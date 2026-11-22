import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { ConnectorsDrawer, type SettingsTab } from './components/ConnectorsDrawer';
import { GlobalCopilotDrawer, type CopilotMessage } from './components/GlobalCopilotDrawer';
import { InboxColumn } from './components/InboxColumn';
import { LandingPage } from './components/LandingPage';
import { NotificationToast, type AlertToastPayload } from './components/NotificationToast';
import { OnboardingFlow, PRODUCTION_WEBHOOK_BASE } from './components/OnboardingFlow';
import { TicketDetailPane } from './components/TicketDetailPane';
import { TopBar, type BrowserNotificationPermission } from './components/TopBar';
import {
  buildOrgId,
  createUserOrg,
  linkUserActiveOrg,
  loadAllUserOrgs,
  loadUserOrg,
  persistOrgConnector,
  persistOrgIncident,
  persistOrgSlackConfig,
  sanitizeId,
  signInWithGoogle,
  signOutUser,
  subscribeToAuth,
  subscribeToOrgIncidents,
  updateOrgIncident,
  updateUserOrg,
} from './lib/firebase';
import { detectOnDeviceCapability, runHybridPrivacyShield } from './lib/hybridAi';
import { getIncidentBucket, sortIncidentsByTriage } from './lib/decisions';
import { buildWorkspaceThreadSummaries, detectProactiveBriefing } from './lib/copilotBriefing';
import { groupIncidents } from './lib/incidentGroups';
import {
  formatSlackText,
  syncedSlackMessageToIncident,
  type SyncedSlackMessage,
} from './lib/slackSync';
import { getSandboxWorkspaceIncidents } from './lib/sampleAlerts';
import {
  SAMPLE_OPENAPI_SPEC,
  createMcpServerTools,
  parseOpenApiToTools,
} from './lib/toolRegistry';
import type {
  CloudInvestigationResult,
  DecisionTriageScores,
  DeferredTool,
  IncidentBucket,
  IncidentItem,
  IndustryPackId,
  OrgProfile,
  RegisteredConnector,
  SlackAppSettings,
  SlackChannelInfo,
  ToolRoleTag,
} from './types/edgeops';

const LOCAL_ORG_STORAGE_KEY = 'edgeops_local_org_v3';
const LOCAL_CHANNELS_STORAGE_PREFIX = 'edgeops_slack_channels_v1_';
const LOCAL_NOTIFICATIONS_KEY = 'edgeops_browser_notifications_v1';
const DEFAULT_INTERNAL_PACK: IndustryPackId = 'ecommerce';

function readNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission as BrowserNotificationPermission;
}

function readStoredNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(LOCAL_NOTIFICATIONS_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return 'Notification' in window && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

function readStoredSelectedChannelIds(orgId: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${LOCAL_CHANNELS_STORAGE_PREFIX}${orgId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeStoredSelectedChannelIds(orgId: string, ids: string[]): void {
  try {
    window.localStorage.setItem(`${LOCAL_CHANNELS_STORAGE_PREFIX}${orgId}`, JSON.stringify(ids));
  } catch {
    // ignore storage errors
  }
}

interface StoredLocalSession {
  orgId: string;
  orgName: string;
  slackConnected?: boolean;
  slackTeam?: string;
  slackBotName?: string;
  defaultSlackChannel?: string;
}

function readLocalSession(): StoredLocalSession | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_ORG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredLocalSession>;
    if (typeof parsed.orgId === 'string' && typeof parsed.orgName === 'string') {
      return {
        orgId: parsed.orgId,
        orgName: parsed.orgName,
        slackConnected: Boolean(parsed.slackConnected),
        slackTeam: typeof parsed.slackTeam === 'string' ? parsed.slackTeam : undefined,
        slackBotName: typeof parsed.slackBotName === 'string' ? parsed.slackBotName : undefined,
        defaultSlackChannel:
          typeof parsed.defaultSlackChannel === 'string' ? parsed.defaultSlackChannel : '#ops-triage',
      };
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

interface IncomingSlackRecord {
  id: string;
  orgId: string;
  receivedAt: string;
  channel: string;
  title: string;
  rawText: string;
  scrubbedSummary: string;
  piiRedactedCount: number;
  piiCategories: string[];
  isNoise: boolean;
  noiseReason: string;
  suggestedReply: string;
  decisionScores?: DecisionTriageScores;
  bucket?: IncidentBucket;
  priorityScore?: number;
}

function slackRecordToIncident(record: IncomingSlackRecord): IncidentItem {
  const cleanRaw = formatSlackText(record.rawText) || record.rawText;
  const bucket: IncidentBucket | undefined =
    record.bucket === 'needs_action' || record.bucket === 'hidden_noise'
      ? record.bucket
      : undefined;
  const isNoise = bucket ? bucket === 'hidden_noise' : record.isNoise;
  const severity: IncidentItem['severity'] = isNoise
    ? 'low'
    : (record.priorityScore ?? 0) >= 85 || (record.decisionScores?.revenueRisk ?? 0) >= 0.75
      ? 'critical'
      : 'high';

  return {
    id: record.id,
    title: record.title,
    channel: record.channel,
    severity,
    status: isNoise ? 'suppressed' : 'open',
    inferenceMode: 'on_device',
    rawPayload: cleanRaw,
    scrubbedSummary: record.scrubbedSummary,
    piiRedactedCount: record.piiRedactedCount,
    piiCategories: record.piiCategories || [],
    isNoise,
    noiseReason: record.noiseReason,
    suggestedReply: record.suggestedReply,
    createdAtIso: record.receivedAt,
    timestampLabel: 'Just now',
    slackPosted: false,
    onDeviceEngineLabel: 'Local Privacy Shield · PREFER_ON_DEVICE',
    industryPack: DEFAULT_INTERNAL_PACK,
    source: 'slack',
    isSample: false,
    decisionScores: record.decisionScores,
    bucket,
    priorityScore: record.priorityScore,
  };
}

function upsertOrgInList(list: OrgProfile[], next: OrgProfile): OrgProfile[] {
  const exists = list.some((item) => item.orgId === next.orgId);
  if (exists) {
    return list.map((item) => (item.orgId === next.orgId ? next : item));
  }
  return [next, ...list];
}

interface InitialSlackOAuthRedirect {
  connected: boolean;
  orgId: string | null;
  team: string | null;
  botName: string | null;
  botUserId: string | null;
  error: string | null;
}

function readSlackOAuthRedirectParams(): InitialSlackOAuthRedirect | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('slack_connected') === '1';
    const error = params.get('slack_oauth_error');
    if (!connected && !error) return null;
    return {
      connected,
      orgId: params.get('orgId')?.trim() || null,
      team: params.get('team')?.trim() || null,
      botName: params.get('botName')?.trim() || null,
      botUserId: params.get('botUserId')?.trim() || null,
      error: error?.trim() || null,
    };
  } catch {
    return null;
  }
}

export default function App() {
  const initialLocal = useMemo(() => (typeof window !== 'undefined' ? readLocalSession() : null), []);
  const initialSlackRedirect = useMemo(() => readSlackOAuthRedirectParams(), []);

  const resolvedInitialOrgId =
    initialLocal?.orgId ?? (initialSlackRedirect?.connected ? initialSlackRedirect.orgId || 'org_workspace' : null);
  const resolvedInitialOrgName =
    initialLocal?.orgName ??
    (initialSlackRedirect?.connected && initialSlackRedirect.team
      ? `${initialSlackRedirect.team} Ops`
      : null);
  const resolvedInitialSlackConnected = Boolean(
    initialSlackRedirect?.connected || initialLocal?.slackConnected
  );
  const resolvedInitialSlackTeam =
    (initialSlackRedirect?.connected ? initialSlackRedirect.team : null) || initialLocal?.slackTeam;
  const resolvedInitialSlackBotName =
    (initialSlackRedirect?.connected ? initialSlackRedirect.botName : null) ||
    initialLocal?.slackBotName;

  const [activeView, setActiveView] = useState<'triage' | 'connectors'>('triage');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('slack');
  const [isOfflineSimulated, setIsOfflineSimulated] = useState(false);

  // Landing page (public visitors at /) vs. Onboarding & Live Workspace
  const wantsLandingParam = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('landing') === '1';
  }, []);
  const [showLanding, setShowLanding] = useState<boolean>(
    () => wantsLandingParam || !resolvedInitialOrgId
  );
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    () => !resolvedInitialOrgId
  );
  const [onboardingSessionKey, setOnboardingSessionKey] = useState(0);
  const [orgProfile, setOrgProfile] = useState<OrgProfile | null>(() =>
    resolvedInitialOrgId && resolvedInitialOrgName
      ? {
          orgId: resolvedInitialOrgId,
          ownerId: 'local',
          name: resolvedInitialOrgName,
          ownerRole: 'Admin',
          industryPack: DEFAULT_INTERNAL_PACK,
          defaultSlackChannel: initialLocal?.defaultSlackChannel || '#ops-triage',
          slackConnected: resolvedInitialSlackConnected,
          slackTeam: resolvedInitialSlackTeam,
          slackBotName: resolvedInitialSlackBotName,
          webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${resolvedInitialOrgId}`,
        }
      : null
  );
  const [workspaces, setWorkspaces] = useState<OrgProfile[]>(() =>
    resolvedInitialOrgId && resolvedInitialOrgName
      ? [
          {
            orgId: resolvedInitialOrgId,
            ownerId: 'local',
            name: resolvedInitialOrgName,
            ownerRole: 'Admin',
            industryPack: DEFAULT_INTERNAL_PACK,
            defaultSlackChannel: initialLocal?.defaultSlackChannel || '#ops-triage',
            slackConnected: resolvedInitialSlackConnected,
            slackTeam: resolvedInitialSlackTeam,
            slackBotName: resolvedInitialSlackBotName,
            webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${resolvedInitialOrgId}`,
          },
        ]
      : []
  );

  // Firebase Auth & Sync state
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(() => {
    if (!initialSlackRedirect?.error) return null;
    if (initialSlackRedirect.error === 'not_configured') {
      return '1-click Slack OAuth needs SLACK_CLIENT_ID and SLACK_CLIENT_SECRET set on the server. Use Connections → Slack → "Create your own Slack app (pre-filled)" in the meantime.';
    }
    if (initialSlackRedirect.error === 'access_denied') {
      return 'Slack connection was canceled. You can connect anytime from Connections → Slack.';
    }
    return `Slack sign-in could not be completed (${initialSlackRedirect.error}). Please try again from Connections → Slack.`;
  });
  const [slackConnectedBanner, setSlackConnectedBanner] = useState<string | null>(() => {
    if (!initialSlackRedirect?.connected) return null;
    const team = initialSlackRedirect.team || 'Slack Workspace';
    const bot = initialSlackRedirect.botName?.replace(/^@/, '');
    return bot ? `${team} as @${bot}` : team;
  });
  const [firestoreSynced, setFirestoreSynced] = useState(false);

  // Incidents ALWAYS start cleanly empty (real alerts arrive from Firestore & Slack read-only sync / webhooks)
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');

  // Real user-connected Integrations & Tools ONLY (MCP + OpenAPI) — zero mock tools
  const [connectors, setConnectors] = useState<RegisteredConnector[]>([]);
  const [customTools, setCustomTools] = useState<DeferredTool[]>([]);

  // Slack App Settings
  const [slackSettings, setSlackSettings] = useState<SlackAppSettings>({
    workspaceId: resolvedInitialOrgId ?? 'org_workspace',
    botName: resolvedInitialSlackBotName || 'EdgeOps',
    defaultChannel: initialLocal?.defaultSlackChannel || '#ops-triage',
    botToken: '',
    signingSecret: '',
    connected: resolvedInitialSlackConnected,
    slackTeam: resolvedInitialSlackTeam,
    slackBotName: resolvedInitialSlackBotName,
    slackBotId: initialSlackRedirect?.botUserId || undefined,
    webhookUrl: resolvedInitialOrgId
      ? `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${resolvedInitialOrgId}`
      : undefined,
  });

  // Read-only Live Slack Channel Sync state
  const [slackChannels, setSlackChannels] = useState<SlackChannelInfo[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(() =>
    resolvedInitialOrgId ? readStoredSelectedChannelIds(resolvedInitialOrgId) : []
  );
  const selectedChannelIdsRef = useRef<string[]>(selectedChannelIds);
  selectedChannelIdsRef.current = selectedChannelIds;
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isSyncingSlack, setIsSyncingSlack] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [syncedChannelCount, setSyncedChannelCount] = useState(0);
  const [slackSyncNote, setSlackSyncNote] = useState<string | null>(null);
  const [slackSyncError, setSlackSyncError] = useState<string | null>(null);

  // Async action states
  const [isRefreshingLocal, setIsRefreshingLocal] = useState(false);
  const [isInvestigating, setIsInvestigating] = useState(false);
  const [investigationError, setInvestigationError] = useState<string | null>(null);
  const [isSendingSlack, setIsSendingSlack] = useState(false);

  // Global Proactive Copilot FAB & Browser Notifications state
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotUnreadCount, setCopilotUnreadCount] = useState(0);
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([]);
  const lastBriefingSigRef = useRef<string | null>(null);
  const copilotOpenRef = useRef(copilotOpen);
  copilotOpenRef.current = copilotOpen;

  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(() => readNotificationPermission());
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() =>
    readStoredNotificationsEnabled()
  );
  const [activeToast, setActiveToast] = useState<AlertToastPayload | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeOrgId = orgProfile?.orgId ?? slackSettings.workspaceId;
  const activeWebhookUrl = `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${activeOrgId}`;
  const isPersistedOrg = Boolean(
    user &&
      firestoreSynced &&
      orgProfile &&
      orgProfile.ownerId === user.uid &&
      orgProfile.orgId !== 'org_sample_sandbox'
  );

  const persistLocalSession = useCallback((profile: OrgProfile) => {
    try {
      const session: StoredLocalSession = {
        orgId: profile.orgId,
        orgName: profile.name,
        slackConnected: profile.slackConnected,
        slackTeam: profile.slackTeam,
        slackBotName: profile.slackBotName,
        defaultSlackChannel: profile.defaultSlackChannel,
      };
      window.localStorage.setItem(LOCAL_ORG_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // ignore storage quota errors
    }
  }, []);

  // Clean up ?slack_connected=1 / ?slack_oauth_error=... query params & persist local Slack OAuth connection
  useEffect(() => {
    if (!initialSlackRedirect) return;
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (initialSlackRedirect.connected && orgProfile) {
      persistLocalSession({
        ...orgProfile,
        slackConnected: true,
        slackTeam: initialSlackRedirect.team || orgProfile.slackTeam || 'Slack Workspace',
        slackBotName: initialSlackRedirect.botName || orgProfile.slackBotName,
      });
    }
  }, [initialSlackRedirect, orgProfile, persistLocalSession]);

  // Persist OAuth Slack connection metadata (including real botName) into Firestore once Firebase Auth finishes hydrating
  useEffect(() => {
    if (!initialSlackRedirect?.connected || !isPersistedOrg || !orgProfile) return;
    const teamName = initialSlackRedirect.team || 'Slack Workspace';
    void updateUserOrg(orgProfile.orgId, {
      slackConnected: true,
      slackTeam: teamName,
      ...(initialSlackRedirect.botName ? { slackBotName: initialSlackRedirect.botName } : {}),
      webhookUrl:
        orgProfile.webhookUrl || `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${orgProfile.orgId}`,
    }).catch(() => undefined);
  }, [initialSlackRedirect, isPersistedOrg, orgProfile]);

  // Detect browser online/offline & Firebase AI Logic on-device readiness
  useEffect(() => {
    void detectOnDeviceCapability();

    const handleOffline = () => setIsOfflineSimulated(true);
    const handleOnline = () => setIsOfflineSimulated(false);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Subscribe to Firebase Auth -> load user's Firestore orgs -> show onboarding if none exist
  useEffect(() => {
    const unsubAuth = subscribeToAuth(async (firebaseUser) => {
      setUser(firebaseUser);

      if (!firebaseUser) {
        setFirestoreSynced(false);
        return;
      }

      try {
        const [allOrgs, activeOrg] = await Promise.all([
          loadAllUserOrgs(firebaseUser).catch(() => [] as OrgProfile[]),
          loadUserOrg(firebaseUser),
        ]);

        if (!activeOrg) {
          const pendingLocal = readLocalSession();
          if (pendingLocal && pendingLocal.orgId !== 'org_sample_sandbox') {
            try {
              const promoted = await createUserOrg(firebaseUser, {
                orgId: pendingLocal.orgId,
                name: pendingLocal.orgName,
                ownerRole: 'Admin',
                industryPack: DEFAULT_INTERNAL_PACK,
                defaultSlackChannel: pendingLocal.defaultSlackChannel || '#ops-triage',
              });
              const enriched: OrgProfile = {
                ...promoted,
                webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${promoted.orgId}`,
              };
              setWorkspaces([enriched]);
              setOrgProfile(enriched);
              setSlackSettings((prev) => ({
                ...prev,
                workspaceId: enriched.orgId,
                defaultChannel: enriched.defaultSlackChannel,
                webhookUrl: enriched.webhookUrl,
              }));
              persistLocalSession(enriched);
              setShowLanding(false);
              setShowOnboarding(false);
              setFirestoreSynced(true);
              return;
            } catch {
              // Fall through to onboarding if org creation fails
            }
          }

          setWorkspaces([]);
          setOrgProfile(null);
          setIncidents([]);
          setSelectedIncidentId(null);
          setFirestoreSynced(false);
          setOnboardingSessionKey((k) => k + 1);
          setShowLanding(false);
          setShowOnboarding(true);
          return;
        }

        const oauthMatched = Boolean(
          initialSlackRedirect?.connected &&
            (!initialSlackRedirect.orgId || initialSlackRedirect.orgId === activeOrg.orgId)
        );
        const hydratedOrg: OrgProfile = oauthMatched
          ? {
              ...activeOrg,
              slackConnected: true,
              slackTeam: initialSlackRedirect?.team || activeOrg.slackTeam || 'Slack Workspace',
              slackBotName: initialSlackRedirect?.botName || activeOrg.slackBotName,
            }
          : activeOrg;

        const mergedList = upsertOrgInList(allOrgs, hydratedOrg);
        setWorkspaces(mergedList);
        setOrgProfile(hydratedOrg);
        setSlackSettings((prev) => ({
          ...prev,
          workspaceId: hydratedOrg.orgId,
          botName: hydratedOrg.slackBotName || prev.botName || 'EdgeOps',
          defaultChannel: hydratedOrg.defaultSlackChannel || '#ops-triage',
          connected: hydratedOrg.slackConnected,
          slackTeam: hydratedOrg.slackTeam,
          slackBotName: hydratedOrg.slackBotName,
          slackBotId:
            (oauthMatched ? initialSlackRedirect?.botUserId : undefined) || prev.slackBotId,
          webhookUrl:
            hydratedOrg.webhookUrl ||
            `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${hydratedOrg.orgId}`,
        }));
        persistLocalSession(hydratedOrg);
        setIncidents([]);
        setSelectedIncidentId(null);
        if (!wantsLandingParam) {
          setShowLanding(false);
        }
        setShowOnboarding(false);
        setFirestoreSynced(true);
      } catch {
        setFirestoreSynced(false);
      }
    });

    return () => {
      unsubAuth();
    };
  }, [persistLocalSession, initialSlackRedirect]);

  // Live Firestore subscription for the currently active persisted org
  useEffect(() => {
    if (!user || !firestoreSynced || !orgProfile || orgProfile.ownerId !== user.uid) {
      return;
    }

    const unsubIncidents = subscribeToOrgIncidents(
      user,
      orgProfile.orgId,
      (remoteDocs) => {
        setIncidents((prev) => {
          const localRealByKey = new Map<string, IncidentItem>();
          for (const item of prev) {
            localRealByKey.set(item.id, item);
            localRealByKey.set(sanitizeId(item.id), item);
          }

          const nextReal: IncidentItem[] = [];
          const seenKeys = new Set<string>();

          for (const d of remoteDocs) {
            const id = String(d.incidentId || d.id || '');
            if (!id) continue;
            const existing = localRealByKey.get(id) ?? localRealByKey.get(sanitizeId(id));
            if (existing) {
              seenKeys.add(existing.id);
              seenKeys.add(sanitizeId(existing.id));
              nextReal.push({
                ...existing,
                status: (d.status as IncidentItem['status']) || existing.status,
                inferenceMode:
                  (d.inferenceMode as IncidentItem['inferenceMode']) || existing.inferenceMode,
                isNoise: typeof d.isNoise === 'boolean' ? d.isNoise : existing.isNoise,
                suggestedReply:
                  typeof d.suggestedReply === 'string'
                    ? d.suggestedReply
                    : existing.suggestedReply,
                slackPosted:
                  typeof d.slackPosted === 'boolean' ? d.slackPosted : existing.slackPosted,
              });
            } else {
              seenKeys.add(id);
              seenKeys.add(sanitizeId(id));
              const cleanSummary = formatSlackText(String(d.scrubbedSummary || ''));
              nextReal.push({
                id,
                title: String(d.title || 'Incoming alert'),
                channel: String(d.channel || '#ops-triage'),
                severity: (d.severity as IncidentItem['severity']) || 'medium',
                status: (d.status as IncidentItem['status']) || 'open',
                inferenceMode: (d.inferenceMode as IncidentItem['inferenceMode']) || 'on_device',
                rawPayload: cleanSummary,
                scrubbedSummary: cleanSummary,
                piiRedactedCount: Number(d.piiRedactedCount || 0),
                piiCategories: [],
                isNoise: Boolean(d.isNoise),
                noiseReason: String(d.noiseReason || 'Actionable operational signal.'),
                suggestedReply: String(d.suggestedReply || ''),
                createdAtIso: new Date().toISOString(),
                timestampLabel: 'Synced',
                slackPosted: Boolean(d.slackPosted),
                industryPack: DEFAULT_INTERNAL_PACK,
                source: (d.source as IncidentItem['source']) || 'slack',
                isSample: false,
              });
            }
          }

          // Preserve any just-arrived real SSE or live-synced Slack events not yet echoed back from Firestore
          for (const item of prev) {
            if (!seenKeys.has(item.id) && !seenKeys.has(sanitizeId(item.id))) {
              seenKeys.add(item.id);
              nextReal.push(item);
            }
          }

          return nextReal;
        });
      },
      () => {
        setFirestoreSynced(false);
      }
    );

    return () => {
      unsubIncidents();
    };
  }, [user, firestoreSynced, orgProfile?.orgId, orgProfile?.ownerId]);

  // Live SSE ingestion stream for POST /webhooks/slack/:orgId -> syncs directly into Inbox & Firestore orgs/{orgId}/incidents
  useEffect(() => {
    if (showOnboarding || !activeOrgId) return;

    const ingestIncoming = (record: IncomingSlackRecord) => {
      const incident = slackRecordToIncident(record);
      setIncidents((prev) => {
        if (prev.some((i) => i.id === incident.id)) return prev;
        return sortIncidentsByTriage([incident, ...prev]);
      });
      setSelectedIncidentId((curr) => {
        if (curr) return curr;
        return getIncidentBucket(incident) === 'needs_action' ? incident.id : curr;
      });
      if (user && isPersistedOrg && orgProfile) {
        void persistOrgIncident(user, orgProfile.orgId, incident, orgProfile).catch(() => undefined);
      }
    };

    // Hydrate any Slack events received before tab opened
    fetch(`/api/webhooks/slack/${encodeURIComponent(activeOrgId)}/events`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { events?: IncomingSlackRecord[] } | null) => {
        if (data?.events && data.events.length > 0) {
          for (const ev of [...data.events].reverse()) {
            ingestIncoming(ev);
          }
        }
      })
      .catch(() => undefined);

    const es = new EventSource(`/api/orgs/${encodeURIComponent(activeOrgId)}/slack-stream`);
    es.onmessage = (event) => {
      try {
        const record = JSON.parse(event.data) as IncomingSlackRecord;
        if (record && record.id) {
          ingestIncoming(record);
        }
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      es.close();
    };
  }, [showOnboarding, activeOrgId, user, isPersistedOrg, orgProfile]);

  // ONLY real user-connected MCP / OpenAPI tools (zero mock packs)
  const allTools = customTools;

  const incidentGroups = useMemo(() => groupIncidents(incidents), [incidents]);

  const selectedGroup = useMemo(() => {
    if (incidentGroups.length === 0) return null;
    if (selectedIncidentId) {
      const matched = incidentGroups.find((g) =>
        g.occurrences.some((occ) => occ.id === selectedIncidentId)
      );
      if (matched) return matched;
    }
    return incidentGroups.find((g) => g.bucket === 'needs_action') ?? incidentGroups[0] ?? null;
  }, [incidentGroups, selectedIncidentId]);

  const selectedGroupKey = selectedGroup?.groupKey ?? null;
  const selectedIncident = selectedGroup?.latest ?? null;

  const triggerToastAndBrowserNotification = useCallback(
    (payload: {
      title: string;
      body: string;
      tone: 'urgent' | 'info';
      targetGroupKey?: string | null;
    }) => {
      const id = `toast_${Date.now().toString(36)}`;
      setActiveToast({ id, ...payload });
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = setTimeout(() => {
        setActiveToast((curr) => (curr?.id === id ? null : curr));
      }, 10_000);

      if (
        notificationsEnabled &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          const notif = new Notification(payload.title, {
            body: payload.body,
            tag: `edgeops_${payload.targetGroupKey || 'briefing'}`,
          });
          notif.onclick = () => {
            window.focus();
            setCopilotOpen(true);
            setCopilotUnreadCount(0);
            notif.close();
          };
        } catch {
          // Ignore browser Notification constructor restrictions in sandboxed iframes
        }
      }
    },
    [notificationsEnabled]
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleToggleNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }

    if (notificationsEnabled && Notification.permission === 'granted') {
      setNotificationsEnabled(false);
      try {
        window.localStorage.setItem(LOCAL_NOTIFICATIONS_KEY, '0');
      } catch {
        // ignore
      }
      return;
    }

    let perm = Notification.permission as BrowserNotificationPermission;
    if (perm === 'default') {
      try {
        perm = (await Notification.requestPermission()) as BrowserNotificationPermission;
      } catch {
        perm = readNotificationPermission();
      }
    }
    setNotificationPermission(perm);

    if (perm === 'granted') {
      setNotificationsEnabled(true);
      try {
        window.localStorage.setItem(LOCAL_NOTIFICATIONS_KEY, '1');
      } catch {
        // ignore
      }
    } else {
      setNotificationsEnabled(false);
    }
  }, [notificationsEnabled]);

  const handleSendTestNotification = useCallback(() => {
    const topGroup =
      incidentGroups.find((g) => g.bucket === 'needs_action') ?? incidentGroups[0] ?? null;
    const title = topGroup
      ? `Urgent alert in ${topGroup.latest.channel}`
      : 'CalmDuty Copilot · Test Alert';
    const body = topGroup
      ? `${topGroup.latest.title}${topGroup.count > 1 ? ` (×${topGroup.count} alerts)` : ''}`
      : 'Browser & in-app notifications are working. Urgent (90%+) alerts will surface here immediately.';
    triggerToastAndBrowserNotification({
      title,
      body,
      tone: 'urgent',
      targetGroupKey: topGroup?.groupKey ?? null,
    });
  }, [incidentGroups, triggerToastAndBrowserNotification]);

  const handleJumpToGroup = useCallback(
    (groupKey: string) => {
      const target = incidentGroups.find((g) => g.groupKey === groupKey);
      if (target) {
        setSelectedIncidentId(target.latest.id);
      }
      setActiveView('triage');
      setMobilePane('detail');
      setInvestigationError(null);
      if (typeof window !== 'undefined' && window.innerWidth < 900) {
        setCopilotOpen(false);
      }
    },
    [incidentGroups]
  );

  // Proactive Copilot Briefing: automatically posts a calm Decisions API window briefing whenever
  // urgent (90%+), routed (`page_eng` / `notify_ops`), or grouped spikes (×2+) arrive — without the user typing anything!
  useEffect(() => {
    if (showLanding || showOnboarding || incidentGroups.length === 0) return;
    const clientTz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();
    const workspaceLabel = orgProfile?.name || slackSettings.slackTeam || 'Slack';
    const briefing = detectProactiveBriefing(incidentGroups, lastBriefingSigRef.current, {
      workspaceName: workspaceLabel,
      timeZone: clientTz,
    });
    if (!briefing) return;

    lastBriefingSigRef.current = briefing.signature;
    const msgId = `proactive_${Date.now().toString(36)}`;
    const proactiveMsg: CopilotMessage = {
      id: msgId,
      role: 'proactive',
      text: briefing.body,
      engine: 'proactive',
      engineLabel: isOfflineSimulated
        ? 'Proactive briefing · On-Device'
        : 'Proactive briefing · Decisions API',
      referencedThreads: briefing.referencedThreads,
    };

    setCopilotMessages((prev) => [...prev, proactiveMsg]);
    if (!copilotOpenRef.current) {
      setCopilotUnreadCount((c) => c + 1);
    }

    const leadRef = briefing.referencedThreads[0];
    triggerToastAndBrowserNotification({
      title: briefing.headline,
      body: leadRef
        ? `${leadRef.channel}: ${leadRef.title}${leadRef.count > 1 ? ` (×${leadRef.count})` : ''}`
        : 'Open CalmDuty Copilot to review top priorities.',
      tone: briefing.urgentCount > 0 || briefing.pageEngCount > 0 ? 'urgent' : 'info',
      targetGroupKey: leadRef?.groupKey ?? null,
    });

    if (isOfflineSimulated) return;

    const controller = new AbortController();
    const summaries = buildWorkspaceThreadSummaries(incidentGroups, 30);
    fetch('/api/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        workspaceName: workspaceLabel,
        timeZone: clientTz,
        threads: summaries,
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ok?: boolean; briefing?: string; modelUsed?: string } | null) => {
        if (
          data?.ok &&
          typeof data.briefing === 'string' &&
          data.briefing.trim().length > 40 &&
          data.modelUsed &&
          data.modelUsed !== 'deterministic-local'
        ) {
          const upgradedText = data.briefing.trim();
          setCopilotMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? {
                    ...m,
                    text: upgradedText,
                    engineLabel: 'Proactive briefing · Decisions API',
                  }
                : m
            )
          );
        }
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
    };
  }, [
    showLanding,
    showOnboarding,
    incidentGroups,
    isOfflineSimulated,
    orgProfile?.name,
    slackSettings.slackTeam,
    triggerToastAndBrowserNotification,
  ]);

  const handleSignIn = async () => {
    setAuthLoading(true);
    setAuthNotice(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in was canceled or blocked.';
      setAuthNotice(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    setFirestoreSynced(false);
    try {
      window.localStorage.removeItem(LOCAL_ORG_STORAGE_KEY);
    } catch {
      // ignore
    }
    setOrgProfile(null);
    setIncidents([]);
    setShowLanding(true);
  };

  // Switch between existing workspaces from the top-left org switcher
  const handleSelectWorkspace = useCallback(
    (targetOrg: OrgProfile) => {
      setOrgProfile(targetOrg);
      setIncidents([]);
      setSelectedIncidentId(null);
      setInvestigationError(null);
      setCopilotMessages([]);
      setCopilotUnreadCount(0);
      lastBriefingSigRef.current = null;
      setSlackSettings({
        workspaceId: targetOrg.orgId,
        botName: targetOrg.slackBotName || 'EdgeOps',
        defaultChannel: targetOrg.defaultSlackChannel || '#ops-triage',
        botToken: '',
        signingSecret: '',
        connected: targetOrg.slackConnected,
        slackTeam: targetOrg.slackTeam,
        slackBotName: targetOrg.slackBotName,
        webhookUrl:
          targetOrg.webhookUrl || `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${targetOrg.orgId}`,
      });
      persistLocalSession(targetOrg);
      if (user && targetOrg.ownerId === user.uid) {
        setFirestoreSynced(true);
        void linkUserActiveOrg(user, targetOrg);
      }
      setActiveView('triage');
    },
    [user, persistLocalSession]
  );

  const handleCreateNewWorkspace = useCallback(() => {
    setOnboardingSessionKey((k) => k + 1);
    setShowOnboarding(true);
  }, []);

  // Onboarding Step 1 -> Create Workspace (starts 100% clean, zero dummy alerts)
  const handleCreateOrg = useCallback(
    async (input: { name: string }) => {
      setIncidents([]);
      setSelectedIncidentId(null);
      setInvestigationError(null);
      setCopilotMessages([]);
      setCopilotUnreadCount(0);
      lastBriefingSigRef.current = null;

      if (user) {
        const created = await createUserOrg(user, {
          name: input.name,
          ownerRole: 'Admin',
          industryPack: DEFAULT_INTERNAL_PACK,
          defaultSlackChannel: '#ops-triage',
        });
        const enriched: OrgProfile = {
          ...created,
          webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${created.orgId}`,
        };
        setOrgProfile(enriched);
        setWorkspaces((prev) => upsertOrgInList(prev, enriched));
        setFirestoreSynced(true);
        setSlackSettings({
          workspaceId: enriched.orgId,
          botName: 'EdgeOps',
          defaultChannel: enriched.defaultSlackChannel,
          botToken: '',
          signingSecret: '',
          connected: false,
          webhookUrl: enriched.webhookUrl,
        });
        persistLocalSession(enriched);
        return { orgId: enriched.orgId, name: enriched.name };
      }

      const localOrgId = buildOrgId(input.name);
      const localProfile: OrgProfile = {
        orgId: localOrgId,
        ownerId: 'local',
        name: input.name,
        ownerRole: 'Admin',
        industryPack: DEFAULT_INTERNAL_PACK,
        defaultSlackChannel: '#ops-triage',
        slackConnected: false,
        webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${localOrgId}`,
      };
      setOrgProfile(localProfile);
      setWorkspaces((prev) => upsertOrgInList(prev, localProfile));
      setSlackSettings({
        workspaceId: localOrgId,
        botName: 'EdgeOps',
        defaultChannel: '#ops-triage',
        botToken: '',
        signingSecret: '',
        connected: false,
        webhookUrl: localProfile.webhookUrl,
      });
      persistLocalSession(localProfile);
      return { orgId: localOrgId, name: input.name };
    },
    [user, persistLocalSession]
  );

  const persistSlackConnectionMetadata = useCallback(
    async (nextSettings: SlackAppSettings) => {
      setSlackSettings(nextSettings);
      await fetch('/api/slack/register-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: nextSettings.workspaceId,
          signingSecret: nextSettings.signingSecret,
          botToken: nextSettings.botToken,
          team: nextSettings.slackTeam,
          botName: nextSettings.slackBotName || nextSettings.botName,
        }),
      }).catch(() => undefined);

      const resolvedWebhook =
        nextSettings.webhookUrl ||
        `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${nextSettings.workspaceId}`;

      setOrgProfile((prev) => {
        if (!prev) return prev;
        const updated: OrgProfile = {
          ...prev,
          defaultSlackChannel: nextSettings.defaultChannel,
          slackConnected: nextSettings.connected,
          slackTeam: nextSettings.slackTeam ?? prev.slackTeam,
          slackBotName: nextSettings.slackBotName ?? nextSettings.botName,
          webhookUrl: resolvedWebhook,
        };
        setWorkspaces((list) => upsertOrgInList(list, updated));
        persistLocalSession(updated);
        return updated;
      });

      if (user && isPersistedOrg && orgProfile) {
        await persistOrgSlackConfig(user, orgProfile.orgId, nextSettings).catch(() => undefined);
        await updateUserOrg(orgProfile.orgId, {
          defaultSlackChannel: nextSettings.defaultChannel,
          slackConnected: nextSettings.connected,
          slackTeam: nextSettings.slackTeam,
          slackBotName: nextSettings.slackBotName || nextSettings.botName,
          webhookUrl: resolvedWebhook,
        }).catch(() => undefined);
      }
    },
    [user, isPersistedOrg, orgProfile, persistLocalSession]
  );

  // Onboarding Step 2 -> Save verified Slack connection & open 100% clean real Inbox
  const handleFinishSlackSetup = useCallback(
    async (nextSettings: SlackAppSettings) => {
      await persistSlackConnectionMetadata(nextSettings);
      setIncidents([]);
      setSelectedIncidentId(null);
      setShowOnboarding(false);
      setActiveView('triage');
    },
    [persistSlackConnectionMetadata]
  );

  // 1-Click Judge / Evaluator Sandbox Workspace (100% synthetic data, zero Firestore writes, pre-loaded MCP + OpenAPI tools)
  const handleLaunchSandbox = useCallback(() => {
    const sandboxOrg: OrgProfile = {
      orgId: 'org_sandbox_northstar',
      ownerId: 'sandbox',
      name: 'Northstar Ops (Sandbox)',
      ownerRole: 'Admin',
      industryPack: 'ecommerce',
      defaultSlackChannel: '#payments-ops',
      slackConnected: false,
      webhookUrl: `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/org_sandbox_northstar`,
    };
    const sandboxAlerts = getSandboxWorkspaceIncidents();
    const mcpBundle = createMcpServerTools(
      'Northstar Ledger MCP',
      'https://mcp.northstar-demo.internal/sse',
      'Admin'
    );
    const openApiBundle = parseOpenApiToTools(SAMPLE_OPENAPI_SPEC, 'Admin');
    const openApiConnector: RegisteredConnector = {
      id: 'openapi_sandbox_billing',
      name: openApiBundle.connectorName,
      kind: 'openapi',
      endpointUrl: openApiBundle.baseUrl,
      deferLoading: true,
      roleAccess: 'Admin',
      toolCount: openApiBundle.tools.length,
      addedAtIso: new Date().toISOString(),
    };

    setOrgProfile(sandboxOrg);
    setFirestoreSynced(false);
    setSlackSettings({
      workspaceId: sandboxOrg.orgId,
      botName: 'EdgeOps',
      defaultChannel: '#payments-ops',
      botToken: '',
      signingSecret: '',
      connected: false,
      webhookUrl: sandboxOrg.webhookUrl,
    });
    setConnectors([mcpBundle.connector, openApiConnector]);
    setCustomTools([...mcpBundle.tools, ...openApiBundle.tools]);
    setIncidents(sandboxAlerts);
    setSelectedIncidentId(sandboxAlerts[0]?.id ?? null);
    setShowLanding(false);
    setShowOnboarding(false);
    setActiveView('triage');
  }, []);

  // Sync shared live Slack workspace status from server (GET /api/slack/status)
  useEffect(() => {
    if (showLanding || showOnboarding || !activeOrgId || activeOrgId.startsWith('org_sandbox_')) return;
    setSelectedChannelIds(readStoredSelectedChannelIds(activeOrgId));

    let cancelled = false;
    fetch(`/api/slack/status?orgId=${encodeURIComponent(activeOrgId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            connected?: boolean;
            orgId?: string | null;
            team?: string | null;
            botName?: string | null;
            channelsCount?: number;
          } | null
        ) => {
          if (cancelled || !data?.connected) return;
          const resolvedTeam = data.team || undefined;
          const resolvedBot = data.botName || undefined;
          if (typeof data.channelsCount === 'number' && data.channelsCount > 0) {
            setSyncedChannelCount((prev) => (prev > 0 ? prev : data.channelsCount || 0));
          }
          setSlackSettings((prev) => ({
            ...prev,
            connected: true,
            slackTeam: resolvedTeam || prev.slackTeam,
            slackBotName: resolvedBot || prev.slackBotName,
            botName: resolvedBot || prev.botName,
          }));
          setOrgProfile((prev) => {
            if (!prev || prev.orgId !== activeOrgId) return prev;
            const updated: OrgProfile = {
              ...prev,
              slackConnected: true,
              slackTeam: resolvedTeam || prev.slackTeam,
              slackBotName: resolvedBot || prev.slackBotName,
            };
            persistLocalSession(updated);
            return updated;
          });
        }
      )
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [showOnboarding, activeOrgId, persistLocalSession]);

  // Read-only discovery of all Slack channels the bot is already a member of
  const handleRefreshSlackChannels = useCallback(async () => {
    if (!activeOrgId || isOfflineSimulated) return;
    setIsLoadingChannels(true);
    setSlackSyncError(null);
    try {
      const headers: Record<string, string> = {};
      if (slackSettings.botToken.trim().startsWith('xoxb-')) {
        headers['x-slack-token'] = slackSettings.botToken.trim();
      }
      const res = await fetch(
        `/api/slack/channels?orgId=${encodeURIComponent(activeOrgId)}`,
        { headers }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        channels?: SlackChannelInfo[];
        error?: string;
      };
      if (data.ok && Array.isArray(data.channels)) {
        setSlackChannels(data.channels);
        setSlackSyncNote(
          data.channels.length > 0
            ? `Found ${data.channels.length} ${data.channels.length === 1 ? 'channel' : 'channels'} where your bot is a member.`
            : null
        );
      } else if (data.error && data.error !== 'slack_not_connected') {
        setSlackSyncNote(`Could not list channels (${data.error}).`);
      }
    } catch {
      setSlackSyncNote('Unable to refresh Slack channels right now.');
    } finally {
      setIsLoadingChannels(false);
    }
  }, [activeOrgId, isOfflineSimulated, slackSettings.botToken]);

  // Strictly read-only live Slack message sync -> passes every message through Slack mrkdwn cleanup + ON-DEVICE Privacy Shield first
  const handleSyncSlack = useCallback(
    async (channelIdsOverride?: string[]) => {
      if (!activeOrgId || isOfflineSimulated || !slackSettings.connected) return;
      setIsSyncingSlack(true);
      setSlackSyncError(null);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (slackSettings.botToken.trim().startsWith('xoxb-')) {
          headers['x-slack-token'] = slackSettings.botToken.trim();
        }
        const effectiveChannelIds =
          channelIdsOverride !== undefined ? channelIdsOverride : selectedChannelIdsRef.current;

        const res = await fetch('/api/slack/sync', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            orgId: activeOrgId,
            channelIds: effectiveChannelIds.length > 0 ? effectiveChannelIds : undefined,
            limitPerChannel: 8,
            botToken: slackSettings.botToken.trim() || undefined,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          channelsSynced?: Array<SlackChannelInfo & { messageCount?: number }>;
          incidents?: SyncedSlackMessage[];
        };

        if (!data.ok) {
          if (data.error && data.error !== 'slack_not_connected') {
            setSlackSyncError(`Sync paused (${data.error}). Reconnect Slack in Connections.`);
          }
          return;
        }

        const syncedChannels = Array.isArray(data.channelsSynced) ? data.channelsSynced : [];
        setSyncedChannelCount(syncedChannels.length);
        if (syncedChannels.length > 0) {
          setSlackChannels((prev) => {
            if (prev.length > 0) return prev;
            return syncedChannels.map(({ id, name, is_private, num_members }) => ({
              id,
              name,
              is_private,
              num_members,
            }));
          });
        }

        const rawSynced = Array.isArray(data.incidents) ? data.incidents : [];
        if (rawSynced.length > 0) {
          // Run clean mrkdwn formatting + strictly on-device Privacy Shield on every synced Slack message
          const scrubbedIncidents = sortIncidentsByTriage(
            rawSynced.map((msg) => syncedSlackMessageToIncident(msg, DEFAULT_INTERNAL_PACK))
          );

          setIncidents((prev) => {
            const incomingByKey = new Map<string, IncidentItem>();
            for (const nextItem of scrubbedIncidents) {
              incomingByKey.set(nextItem.id, nextItem);
              incomingByKey.set(sanitizeId(nextItem.id), nextItem);
            }

            let changed = false;
            const seenKeys = new Set<string>();
            const updatedPrev = prev.map((existing) => {
              seenKeys.add(existing.id);
              seenKeys.add(sanitizeId(existing.id));
              const fresh =
                incomingByKey.get(existing.id) ?? incomingByKey.get(sanitizeId(existing.id));
              const hasNewerDecisionOrMeta = Boolean(
                fresh &&
                  ((fresh.decisionScores &&
                    (!existing.decisionScores ||
                      (fresh.decisionScores.route && !existing.decisionScores.route) ||
                      (fresh.decisionScores.latencyMs && !existing.decisionScores.latencyMs))) ||
                    (typeof fresh.replyCount === 'number' && fresh.replyCount !== existing.replyCount) ||
                    (typeof fresh.isBot === 'boolean' && existing.isBot === undefined))
              );
              if (fresh && hasNewerDecisionOrMeta) {
                changed = true;
                return {
                  ...existing,
                  ...(fresh.decisionScores
                    ? {
                        decisionScores: fresh.decisionScores,
                        bucket: fresh.bucket,
                        priorityScore: fresh.priorityScore,
                        isNoise: fresh.isNoise,
                        status: existing.status === 'resolved' ? 'resolved' : fresh.status,
                        noiseReason: fresh.noiseReason,
                      }
                    : {}),
                  isBot: fresh.isBot,
                  replyCount: fresh.replyCount,
                  threadTs: fresh.threadTs ?? existing.threadTs,
                };
              }
              return existing;
            });

            const additions: IncidentItem[] = [];
            for (const nextItem of scrubbedIncidents) {
              if (!seenKeys.has(nextItem.id) && !seenKeys.has(sanitizeId(nextItem.id))) {
                additions.push(nextItem);
                changed = true;
              }
            }
            if (!changed) return prev;
            return sortIncidentsByTriage([...additions, ...updatedPrev]);
          });

          setSelectedIncidentId((curr) => {
            if (curr) return curr;
            const firstActionable = scrubbedIncidents.find(
              (i) => getIncidentBucket(i) === 'needs_action'
            );
            return firstActionable?.id ?? scrubbedIncidents[0]?.id ?? null;
          });

          if (user && isPersistedOrg && orgProfile) {
            for (const inc of scrubbedIncidents.slice(0, 20)) {
              void persistOrgIncident(user, orgProfile.orgId, inc, orgProfile).catch(() => undefined);
            }
          }
        }

        setSlackSyncNote(
          syncedChannels.length > 0
            ? `Synced ${rawSynced.length} recent ${rawSynced.length === 1 ? 'message' : 'messages'} across ${syncedChannels.length} ${syncedChannels.length === 1 ? 'channel' : 'channels'} (read-only).`
            : 'No channels to sync yet.'
        );
      } catch {
        setSlackSyncError('Could not sync Slack right now.');
      } finally {
        setIsSyncingSlack(false);
      }
    },
    [
      activeOrgId,
      isOfflineSimulated,
      slackSettings.connected,
      slackSettings.botToken,
      user,
      isPersistedOrg,
      orgProfile,
    ]
  );

  // Toggle which channels are watched in Connections -> Slack -> Synced Channels
  const handleToggleSlackChannel = useCallback(
    (channelId: string) => {
      if (!activeOrgId) return;
      setSelectedChannelIds((prev) => {
        const allIds = slackChannels.map((c) => c.id);
        const current = prev.length === 0 ? allIds : prev;
        const next = current.includes(channelId)
          ? current.filter((id) => id !== channelId)
          : [...current, channelId];
        const normalized = next.length === allIds.length ? [] : next;
        writeStoredSelectedChannelIds(activeOrgId, normalized);
        return normalized;
      });
    },
    [activeOrgId, slackChannels]
  );

  // Automatically discover channels & run read-only sync as soon as Slack connects
  useEffect(() => {
    if (showOnboarding || !slackSettings.connected || !activeOrgId || isOfflineSimulated) {
      return;
    }
    void handleRefreshSlackChannels();
    void handleSyncSlack();
  }, [
    showOnboarding,
    slackSettings.connected,
    activeOrgId,
    isOfflineSimulated,
    handleRefreshSlackChannels,
    handleSyncSlack,
  ]);

  // Optional 30-second live read-only polling when Auto 30s is enabled
  useEffect(() => {
    if (
      showOnboarding ||
      !slackSettings.connected ||
      !autoSyncEnabled ||
      !activeOrgId ||
      isOfflineSimulated
    ) {
      return;
    }
    const timer = setInterval(() => {
      void handleSyncSlack();
    }, 30_000);
    return () => clearInterval(timer);
  }, [
    showOnboarding,
    slackSettings.connected,
    autoSyncEnabled,
    activeOrgId,
    isOfflineSimulated,
    handleSyncSlack,
  ]);

  const handleToggleNoiseStatus = useCallback(
    (incidentIds: string[]) => {
      const idSet = new Set(incidentIds);
      setIncidents((prev) =>
        prev.map((item) => {
          if (!idSet.has(item.id)) return item;
          const nextNoise = !item.isNoise;
          const nextStatus = nextNoise ? 'suppressed' : 'open';
          const nextReason = nextNoise
            ? 'Manually marked as transient noise.'
            : 'Restored to active inbox.';
          if (isPersistedOrg && orgProfile && item.status !== 'resolved') {
            void updateOrgIncident(orgProfile.orgId, item.id, {
              status: nextStatus,
              isNoise: nextNoise,
              noiseReason: nextReason,
              suggestedReply: item.suggestedReply,
            }).catch(() => undefined);
          }
          return {
            ...item,
            isNoise: nextNoise,
            bucket: nextNoise ? 'hidden_noise' : 'needs_action',
            status: nextStatus,
            noiseReason: nextReason,
          };
        })
      );
    },
    [isPersistedOrg, orgProfile]
  );

  const handleRefreshLocalShield = useCallback(
    async (incidentId: string) => {
      const target = incidents.find((i) => i.id === incidentId);
      if (!target) return;
      setIsRefreshingLocal(true);
      try {
        const output = await runHybridPrivacyShield(target, {
          simulateOffline: isOfflineSimulated,
          tryHybridModel: true,
        });
        setIncidents((prev) =>
          prev.map((item) =>
            item.id === incidentId
              ? {
                  ...item,
                  scrubbedSummary: output.scrub.scrubbedText,
                  piiRedactedCount: output.scrub.redactionCount,
                  piiCategories: output.scrub.categories,
                  suggestedReply: output.suggestedReply,
                  onDeviceEngineLabel: output.engineDescription,
                }
              : item
          )
        );
      } finally {
        setIsRefreshingLocal(false);
      }
    },
    [incidents, isOfflineSimulated]
  );

  const handleRunInvestigation = useCallback(
    async (incident: IncidentItem) => {
      if (isOfflineSimulated) return;
      setIsInvestigating(true);
      setInvestigationError(null);

      try {
        const response = await fetch('/api/investigate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            incidentTitle: incident.title,
            channel: incident.channel,
            severity: incident.severity,
            scrubbedSummary: incident.scrubbedSummary,
            tools: allTools,
          }),
        });

        const payload = (await response.json()) as CloudInvestigationResult & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || `Investigation failed with status ${response.status}`);
        }

        setIncidents((prev) =>
          prev.map((item) =>
            item.id === incident.id
              ? {
                  ...item,
                  inferenceMode: 'cloud',
                  status: item.status === 'resolved' ? 'resolved' : 'investigating',
                  investigation: payload,
                }
              : item
          )
        );

        if (isPersistedOrg && orgProfile && incident.status !== 'resolved') {
          void updateOrgIncident(orgProfile.orgId, incident.id, {
            status: 'investigating',
            inferenceMode: 'cloud',
            diagnosis: payload.diagnosis.slice(0, 4000),
            remediationPlan: payload.remediationPlan.slice(0, 2000),
            toolsUsed: payload.toolsUsed.slice(0, 15),
            toolsTotal: payload.toolsTotal,
          }).catch(() => undefined);
        }
      } catch (err) {
        setInvestigationError(
          err instanceof Error ? err.message : 'Unable to reach /api/investigate.'
        );
      } finally {
        setIsInvestigating(false);
      }
    },
    [isOfflineSimulated, allTools, isPersistedOrg, orgProfile]
  );

  const handleApproveAndFix = useCallback(
    (incidentIds: string[], primaryIncident: IncidentItem) => {
      const idSet = new Set(incidentIds);
      setIncidents((prev) =>
        prev.map((item) => (idSet.has(item.id) ? { ...item, status: 'resolved' } : item))
      );
      if (isPersistedOrg && orgProfile) {
        const plan =
          primaryIncident.investigation?.remediationPlan.slice(0, 2000) ||
          'Approved and applied.';
        for (const id of incidentIds) {
          void updateOrgIncident(orgProfile.orgId, id, {
            status: 'resolved',
            remediationPlan: plan,
          }).catch(() => undefined);
        }
      }
    },
    [isPersistedOrg, orgProfile]
  );

  const handleSendToSlack = useCallback(
    async (incident: IncidentItem) => {
      if (!incident.investigation || isOfflineSimulated) return;
      setIsSendingSlack(true);
      setInvestigationError(null);
      try {
        const res = await fetch('/api/slack/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId: activeOrgId,
            channel: slackSettings.defaultChannel || incident.channel,
            botToken: slackSettings.botToken,
            incidentTitle: incident.title,
            diagnosis: incident.investigation.diagnosis,
            remediationPlan: incident.investigation.remediationPlan,
            toolsUsed: incident.investigation.toolsUsed,
            toolsTotal: incident.investigation.toolsTotal,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          previewText?: string;
          mode?: string;
          channel?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Failed to dispatch update to Slack.');
        }

        const threadNote =
          data.mode === 'live_slack_api'
            ? `Delivered to live Slack channel ${data.channel}:\n${data.previewText}`
            : `Posted to workspace thread (${data.channel}):\n${data.previewText}`;

        setIncidents((prev) =>
          prev.map((item) =>
            item.id === incident.id
              ? { ...item, slackPosted: true, slackThreadNote: threadNote }
              : item
          )
        );

        if (isPersistedOrg && orgProfile) {
          void updateOrgIncident(orgProfile.orgId, incident.id, {
            slackPosted: true,
          }).catch(() => undefined);
        }
      } catch (err) {
        setInvestigationError(
          err instanceof Error ? err.message : 'Unable to send Slack thread update.'
        );
      } finally {
        setIsSendingSlack(false);
      }
    },
    [isOfflineSimulated, activeOrgId, slackSettings, isPersistedOrg, orgProfile]
  );

  const handleAddMcpServer = useCallback(
    (name: string, url: string, roleAccess: ToolRoleTag) => {
      const { connector, tools } = createMcpServerTools(name, url, roleAccess);
      setConnectors((prev) => [connector, ...prev]);
      setCustomTools((prev) => [...tools, ...prev]);
      if (user && isPersistedOrg && orgProfile) {
        void persistOrgConnector(user, orgProfile.orgId, connector).catch(() => undefined);
      }
    },
    [user, isPersistedOrg, orgProfile]
  );

  const handleImportOpenApi = useCallback(
    (
      connectorName: string,
      baseUrl: string,
      roleAccess: ToolRoleTag,
      tools: DeferredTool[]
    ) => {
      const connector: RegisteredConnector = {
        id: `openapi_${Date.now().toString(36)}`,
        name: connectorName,
        kind: 'openapi',
        endpointUrl: baseUrl,
        deferLoading: true,
        roleAccess,
        toolCount: tools.length,
        addedAtIso: new Date().toISOString(),
      };
      setConnectors((prev) => [connector, ...prev]);
      setCustomTools((prev) => [...tools, ...prev]);
      if (user && isPersistedOrg && orgProfile) {
        void persistOrgConnector(user, orgProfile.orgId, connector).catch(() => undefined);
      }
    },
    [user, isPersistedOrg, orgProfile]
  );

  const handleRemoveConnector = useCallback((connectorId: string) => {
    setConnectors((prev) => {
      const target = prev.find((c) => c.id === connectorId);
      if (target) {
        setCustomTools((tools) => tools.filter((t) => t.sourceName !== target.name));
      }
      return prev.filter((c) => c.id !== connectorId);
    });
  }, []);

  // Public Editorial Landing Page for signed-out / first-time visitors
  if (showLanding) {
    return (
      <LandingPage
        user={user}
        authLoading={authLoading}
        hasExistingWorkspace={Boolean(orgProfile)}
        onSignIn={handleSignIn}
        onLaunchSandbox={handleLaunchSandbox}
        onStartWorkspaceSetup={() => {
          setShowLanding(false);
          setShowOnboarding(true);
        }}
        onOpenExistingWorkspace={() => {
          setShowLanding(false);
          setShowOnboarding(false);
        }}
      />
    );
  }

  // First-Run / Create Workspace 2-Step Onboarding Flow (100% Real-Data-First)
  if (showOnboarding) {
    return (
      <OnboardingFlow
        key={onboardingSessionKey}
        user={user}
        authLoading={authLoading}
        onSignIn={handleSignIn}
        hasExistingWorkspace={Boolean(orgProfile)}
        onCancelToWorkspace={() => setShowOnboarding(false)}
        initialOrgName=""
        onCreateOrg={handleCreateOrg}
        onSaveVerifiedSlack={persistSlackConnectionMetadata}
        onFinishSlackSetup={handleFinishSlackSetup}
        onLaunchSandbox={handleLaunchSandbox}
      />
    );
  }

  return (
    <div
      className={`min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col ${
        activeView === 'triage' ? 'min-[900px]:h-screen min-[900px]:overflow-hidden' : ''
      }`}
    >
      <TopBar
        orgName={orgProfile?.name ?? null}
        activeOrgId={orgProfile?.orgId ?? null}
        workspaces={workspaces}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateNewWorkspace={handleCreateNewWorkspace}
        activeView={activeView}
        onChangeView={(view) => {
          setActiveView(view);
          if (view === 'connectors') setSettingsInitialTab('slack');
        }}
        isOfflineSimulated={isOfflineSimulated}
        onToggleOffline={() => setIsOfflineSimulated((prev) => !prev)}
        notificationsEnabled={notificationsEnabled}
        notificationPermission={notificationPermission}
        onToggleNotifications={() => void handleToggleNotifications()}
        onSendTestNotification={handleSendTestNotification}
        user={user}
        authLoading={authLoading}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
      />

      <NotificationToast
        toast={activeToast}
        onOpenCopilot={() => {
          setCopilotOpen(true);
          setCopilotUnreadCount(0);
        }}
        onJumpToThread={handleJumpToGroup}
        onDismiss={() => setActiveToast(null)}
      />

      {slackConnectedBanner && (
        <div
          data-testid="slack-connected-banner"
          className="bg-emerald-50 border-b border-emerald-200 px-6 py-2 text-xs text-emerald-900 flex items-center justify-between shrink-0"
        >
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
            <span>Connected to {slackConnectedBanner}</span>
          </span>
          <button
            type="button"
            onClick={() => setSlackConnectedBanner(null)}
            className="font-medium text-emerald-800 hover:text-emerald-950 underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {authNotice && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-900 flex items-center justify-between shrink-0">
          <span>{authNotice}</span>
          <button
            type="button"
            onClick={() => setAuthNotice(null)}
            className="font-medium underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {activeView === 'triage' ? (
        <main className="flex-1 min-h-0 max-w-[1440px] w-full mx-auto flex flex-col min-[900px]:flex-row min-[900px]:overflow-hidden bg-white border-x border-[#E2E8F0]">
          <InboxColumn
            groups={incidentGroups}
            selectedGroupKey={selectedGroupKey}
            hiddenOnMobile={incidentGroups.length === 0 || mobilePane === 'detail'}
            botName={slackSettings.slackBotName || slackSettings.botName}
            slackConnected={slackSettings.connected}
            isSyncingSlack={isSyncingSlack}
            autoSyncEnabled={autoSyncEnabled}
            syncedChannelCount={syncedChannelCount || slackChannels.length}
            syncError={slackSyncError}
            onSyncSlack={() => void handleSyncSlack()}
            onToggleAutoSync={() => setAutoSyncEnabled((prev) => !prev)}
            onSelectGroup={(groupKey) => {
              const target = incidentGroups.find((g) => g.groupKey === groupKey);
              if (target) {
                setSelectedIncidentId(target.latest.id);
              }
              setMobilePane('detail');
              setInvestigationError(null);
            }}
          />

          <TicketDetailPane
            group={selectedGroup}
            hiddenOnMobile={incidentGroups.length > 0 && mobilePane === 'list'}
            onBackToInbox={() => setMobilePane('list')}
            totalToolsCount={allTools.length}
            isOfflineSimulated={isOfflineSimulated}
            isRefreshingLocal={isRefreshingLocal}
            isInvestigating={isInvestigating}
            investigationError={investigationError}
            isSendingSlack={isSendingSlack}
            isSyncingSlack={isSyncingSlack}
            slackConnected={slackSettings.connected}
            slackTeam={slackSettings.slackTeam}
            slackChannel={slackSettings.defaultChannel || selectedIncident?.channel || '#ops-triage'}
            botName={slackSettings.slackBotName || slackSettings.botName}
            webhookUrl={activeWebhookUrl}
            onToggleNoiseStatus={handleToggleNoiseStatus}
            onRefreshLocalShield={handleRefreshLocalShield}
            onRunInvestigation={handleRunInvestigation}
            onApproveAndFix={handleApproveAndFix}
            onSendToSlack={handleSendToSlack}
            onSyncSlack={() => handleSyncSlack()}
            onOpenSlackSettings={() => {
              setSettingsInitialTab('slack');
              setActiveView('connectors');
            }}
            onOpenConnections={() => {
              setSettingsInitialTab('mcp');
              setActiveView('connectors');
            }}
          />
        </main>
      ) : (
        <main className="flex-1">
          <ConnectorsDrawer
            initialTab={settingsInitialTab}
            orgName={orgProfile?.name ?? null}
            allTools={allTools}
            connectors={connectors}
            onAddMcpServer={handleAddMcpServer}
            onImportOpenApi={handleImportOpenApi}
            onRemoveConnector={handleRemoveConnector}
            slackSettings={slackSettings}
            slackChannels={slackChannels}
            selectedChannelIds={selectedChannelIds}
            isLoadingChannels={isLoadingChannels}
            isSyncingSlack={isSyncingSlack}
            slackSyncNote={slackSyncNote}
            onToggleSlackChannel={handleToggleSlackChannel}
            onRefreshSlackChannels={handleRefreshSlackChannels}
            onSyncSlackNow={() => handleSyncSlack()}
            onSaveSlackSettings={persistSlackConnectionMetadata}
            onOpenOnboarding={handleCreateNewWorkspace}
            onBackToWorkspace={() => setActiveView('triage')}
          />
        </main>
      )}

      {/* Global Proactive Copilot FAB & Floating Workspace Drawer */}
      <GlobalCopilotDrawer
        workspaceName={orgProfile?.name || 'CalmDuty Workspace'}
        groups={incidentGroups}
        isOpen={copilotOpen}
        unreadCount={copilotUnreadCount}
        messages={copilotMessages}
        isOfflineSimulated={isOfflineSimulated}
        onToggleOpen={() => {
          setCopilotOpen((prev) => {
            const next = !prev;
            if (next) setCopilotUnreadCount(0);
            return next;
          });
        }}
        onClose={() => setCopilotOpen(false)}
        onAppendMessage={(msg) => setCopilotMessages((prev) => [...prev, msg])}
        onUpdateMessage={(id, updater) =>
          setCopilotMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)))
        }
        onClearMessages={() => setCopilotMessages([])}
        onJumpToGroup={handleJumpToGroup}
        onSendTestNotification={handleSendTestNotification}
      />
    </div>
  );
}

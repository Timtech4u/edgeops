import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  CustomProvider,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  initializeAppCheck,
  type AppCheck,
} from 'firebase/app-check';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  IncidentItem,
  IndustryPackId,
  OrgProfile,
  RegisteredConnector,
  SlackAppSettings,
  TriageRole,
} from '../types/edgeops';

export const app = initializeApp(firebaseConfig);

let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    },
    firebaseConfig.firestoreDatabaseId
  );
} catch {
  dbInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db: Firestore = dbInstance;
export const auth = getAuth(app);

// Initialize Firebase App Check with debug token support for local/dev environments
export let appCheck: AppCheck | null = null;
export let appCheckStatus: 'recaptcha' | 'debug' | 'unavailable' = 'unavailable';

if (typeof window !== 'undefined') {
  try {
    const configuredDebugToken =
      (import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN as string | undefined) ||
      window.localStorage.getItem('edgeops_appcheck_debug_token') ||
      '';

    if (configuredDebugToken.trim().length > 0) {
      (self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
        configuredDebugToken === 'true' ? true : configuredDebugToken.trim();
    }

    const configuredSiteKey =
      ((import.meta.env.VITE_FIREBASE_RECAPTCHA_SITE_KEY as string | undefined) || '').trim() ||
      (firebaseConfig.recaptchaSiteKey || '').trim();
    const providerKind =
      ((firebaseConfig as { recaptchaProvider?: string }).recaptchaProvider || 'enterprise').toLowerCase();

    if (configuredSiteKey.length > 0) {
      appCheck = initializeAppCheck(app, {
        provider:
          providerKind === 'v3'
            ? new ReCaptchaV3Provider(configuredSiteKey)
            : new ReCaptchaEnterpriseProvider(configuredSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
      appCheckStatus = 'recaptcha';
    } else {
      appCheck = initializeAppCheck(app, {
        provider: new CustomProvider({
          getToken: async () => ({
            token: configuredDebugToken || 'edgeops-local-appcheck-debug-token',
            expireTimeMillis: Date.now() + 60 * 60 * 1000,
          }),
        }),
        isTokenAutoRefreshEnabled: false,
      });
      appCheckStatus = 'debug';
    }
  } catch {
    appCheckStatus = 'unavailable';
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
if (typeof window !== 'undefined') {
  void testConnection();
}

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeToAuth(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, callback);
}

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : `id_${Date.now().toString(36)}`;
}

export function buildOrgId(orgName: string, seedSuffix?: string): string {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28) || 'workspace';
  const suffix = (seedSuffix || Date.now().toString(36)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return sanitizeId(`org_${slug}_${suffix}`);
}

function mapOrgDoc(id: string, d: Record<string, unknown>, fallbackOwnerId: string): OrgProfile {
  return {
    orgId: String(d.orgId || id),
    ownerId: String(d.ownerId || fallbackOwnerId),
    name: String(d.name || 'Workspace'),
    ownerRole: (d.ownerRole as TriageRole) || 'Admin',
    industryPack: (d.industryPack as IndustryPackId) || 'ecommerce',
    defaultSlackChannel: String(d.defaultSlackChannel || '#ops-triage'),
    slackConnected: Boolean(d.slackConnected),
    slackTeam: typeof d.slackTeam === 'string' && d.slackTeam.length > 0 ? d.slackTeam : undefined,
    slackBotName:
      typeof d.slackBotName === 'string' && d.slackBotName.length > 0 ? d.slackBotName : undefined,
    webhookUrl:
      typeof d.webhookUrl === 'string' && d.webhookUrl.length > 0 ? d.webhookUrl : undefined,
  };
}

export async function loadAllUserOrgs(user: User): Promise<OrgProfile[]> {
  try {
    const q = query(collection(db, 'orgs'), where('ownerId', '==', user.uid), limit(20));
    const snaps = await getDocs(q);
    return snaps.docs.map((snap) =>
      mapOrgDoc(snap.id, snap.data() as Record<string, unknown>, user.uid)
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'orgs');
  }
}

export async function loadUserOrg(user: User): Promise<OrgProfile | null> {
  // 1. Check user's profile doc for linked orgId
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (userSnap.exists()) {
      const userData = userSnap.data() as Record<string, unknown>;
      if (typeof userData.orgId === 'string' && userData.orgId.length > 0) {
        const orgSnap = await getDoc(doc(db, 'orgs', userData.orgId));
        if (orgSnap.exists()) {
          return mapOrgDoc(orgSnap.id, orgSnap.data() as Record<string, unknown>, user.uid);
        }
      }
    }
  } catch {
    // Fall through to orgs query
  }

  // 2. Fallback query: check orgs owned by this user
  const orgs = await loadAllUserOrgs(user);
  return orgs[0] ?? null;
}

export async function linkUserActiveOrg(user: User, org: OrgProfile): Promise<void> {
  try {
    await updateDoc(doc(db, 'users', user.uid), {
      orgId: org.orgId,
      activeRole: org.ownerRole,
      activePack: org.industryPack,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Ignore if user profile doc doesn't exist yet
  }
}

export async function createUserOrg(
  user: User,
  input: {
    orgId?: string;
    name: string;
    ownerRole: TriageRole;
    industryPack: IndustryPackId;
    defaultSlackChannel: string;
  }
): Promise<OrgProfile> {
  const orgId = input.orgId ? sanitizeId(input.orgId) : buildOrgId(input.name, user.uid.slice(0, 6));
  const safeName = input.name.trim().slice(0, 120) || 'My Workspace';
  const safeChannel = (input.defaultSlackChannel || '#ops-triage').trim().slice(0, 80);

  const orgPayload = {
    orgId,
    ownerId: user.uid,
    ownerUid: user.uid,
    memberIds: [user.uid],
    memberUids: [user.uid],
    name: safeName,
    ownerRole: input.ownerRole,
    industryPack: input.industryPack,
    defaultSlackChannel: safeChannel,
    slackConnected: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'orgs', orgId), orgPayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `orgs/${orgId}`);
  }

  // Link user profile to orgId
  const displayName = (user.displayName || user.email?.split('@')[0] || 'Operator').slice(0, 120);
  try {
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      displayName,
      activeRole: input.ownerRole,
      activePack: input.industryPack,
      workspaceId: orgId,
      orgId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        displayName,
        activeRole: input.ownerRole,
        activePack: input.industryPack,
        orgId,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
    }
  }

  return {
    orgId,
    ownerId: user.uid,
    name: safeName,
    ownerRole: input.ownerRole,
    industryPack: input.industryPack,
    defaultSlackChannel: safeChannel,
    slackConnected: false,
  };
}

export async function updateUserOrg(
  orgId: string,
  patch: Partial<
    Pick<
      OrgProfile,
      | 'name'
      | 'ownerRole'
      | 'industryPack'
      | 'defaultSlackChannel'
      | 'slackConnected'
      | 'slackTeam'
      | 'slackBotName'
      | 'webhookUrl'
    >
  >
): Promise<void> {
  const safeId = sanitizeId(orgId);
  const sanitizedPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (typeof patch.name === 'string') sanitizedPatch.name = patch.name.trim().slice(0, 120);
  if (patch.ownerRole) sanitizedPatch.ownerRole = patch.ownerRole;
  if (patch.industryPack) sanitizedPatch.industryPack = patch.industryPack;
  if (typeof patch.defaultSlackChannel === 'string') {
    sanitizedPatch.defaultSlackChannel = patch.defaultSlackChannel.trim().slice(0, 80);
  }
  if (typeof patch.slackConnected === 'boolean') sanitizedPatch.slackConnected = patch.slackConnected;
  if (typeof patch.slackTeam === 'string') sanitizedPatch.slackTeam = patch.slackTeam.trim().slice(0, 120);
  if (typeof patch.slackBotName === 'string') {
    sanitizedPatch.slackBotName = patch.slackBotName.trim().slice(0, 80);
  }
  if (typeof patch.webhookUrl === 'string') sanitizedPatch.webhookUrl = patch.webhookUrl.trim().slice(0, 500);

  try {
    await updateDoc(doc(db, 'orgs', safeId), sanitizedPatch);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `orgs/${safeId}`);
  }
}

const persistedIncidentKeys = new Set<string>();
const inFlightIncidentPersists = new Map<string, Promise<void>>();

export async function ensureUserOrgPersisted(
  user: User,
  org: Pick<OrgProfile, 'orgId' | 'name' | 'ownerRole' | 'industryPack' | 'defaultSlackChannel'>
): Promise<void> {
  const safeOrgId = sanitizeId(org.orgId);
  const orgRef = doc(db, 'orgs', safeOrgId);
  try {
    const existing = await getDoc(orgRef);
    if (existing.exists()) {
      return;
    }
  } catch {
    // If read fails (e.g. doc does not exist yet), proceed to create
  }

  await createUserOrg(user, {
    orgId: safeOrgId,
    name: org.name,
    ownerRole: org.ownerRole,
    industryPack: org.industryPack,
    defaultSlackChannel: org.defaultSlackChannel || '#ops-triage',
  });
}

export async function persistOrgIncident(
  user: User,
  orgId: string,
  incident: IncidentItem,
  orgFallback?: Pick<OrgProfile, 'orgId' | 'name' | 'ownerRole' | 'industryPack' | 'defaultSlackChannel'>
): Promise<void> {
  const safeOrgId = sanitizeId(orgId);
  const incidentId = sanitizeId(incident.id);
  const dedupeKey = `${safeOrgId}/${incidentId}`;

  if (persistedIncidentKeys.has(dedupeKey)) {
    return;
  }
  const existingFlight = inFlightIncidentPersists.get(dedupeKey);
  if (existingFlight) {
    return existingFlight;
  }

  const run = (async () => {
    const path = `orgs/${safeOrgId}/incidents/${incidentId}`;
    const docRef = doc(db, 'orgs', safeOrgId, 'incidents', incidentId);

    // Ensure the parent orgs/{orgId} document exists before creating a subcollection incident
    if (orgFallback) {
      await ensureUserOrgPersisted(user, orgFallback);
    }

    // Avoid overwriting an already-created incident (which would trigger `update` and fail immutable createdAt checks)
    try {
      const existingSnap = await getDoc(docRef);
      if (existingSnap.exists()) {
        persistedIncidentKeys.add(dedupeKey);
        return;
      }
    } catch {
      // Proceed to create
    }

    const safeTitle = (incident.title || 'Incoming alert').trim().slice(0, 200) || 'Incoming alert';
    const safeChannel = (incident.channel || '#ops-triage').trim().slice(0, 64) || '#ops-triage';

    const payload: Record<string, unknown> = {
      incidentId,
      orgId: safeOrgId,
      ownerId: user.uid,
      ownerUid: user.uid,
      title: safeTitle,
      channel: safeChannel,
      severity: incident.severity,
      status: incident.status,
      inferenceMode: incident.inferenceMode,
      scrubbedSummary: (incident.scrubbedSummary || safeTitle).slice(0, 4000),
      piiRedactedCount: Math.min(500, Math.max(0, Number(incident.piiRedactedCount) || 0)),
      isNoise: Boolean(incident.isNoise),
      noiseReason: (incident.noiseReason || 'Actionable operational signal.').slice(0, 300),
      suggestedReply: (incident.suggestedReply || '').slice(0, 2000),
      source:
        incident.source === 'slack_live' ? 'slack' : incident.source || 'manual',
      slackPosted: Boolean(incident.slackPosted),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (incident.investigation) {
      payload.diagnosis = incident.investigation.diagnosis.slice(0, 4000);
      payload.remediationPlan = incident.investigation.remediationPlan.slice(0, 2000);
      payload.toolsUsed = incident.investigation.toolsUsed.slice(0, 15).map((t) => t.slice(0, 120));
      payload.toolsTotal = Math.min(500, Math.max(0, incident.investigation.toolsTotal));
    }

    try {
      await setDoc(docRef, payload);
      persistedIncidentKeys.add(dedupeKey);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  })();

  inFlightIncidentPersists.set(dedupeKey, run);
  try {
    await run;
  } finally {
    inFlightIncidentPersists.delete(dedupeKey);
  }
}

export async function updateOrgIncident(
  orgId: string,
  incidentId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const safeOrgId = sanitizeId(orgId);
  const safeId = sanitizeId(incidentId);
  const path = `orgs/${safeOrgId}/incidents/${safeId}`;
  const docRef = doc(db, 'orgs', safeOrgId, 'incidents', safeId);
  try {
    const existingSnap = await getDoc(docRef);
    if (!existingSnap.exists()) {
      return;
    }
    await updateDoc(docRef, {
      ...patch,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function persistOrgConnector(
  user: User,
  orgId: string,
  connector: RegisteredConnector
): Promise<void> {
  const safeOrgId = sanitizeId(orgId);
  const connectorId = sanitizeId(connector.id);
  const path = `orgs/${safeOrgId}/connectors/${connectorId}`;
  try {
    await setDoc(doc(db, 'orgs', safeOrgId, 'connectors', connectorId), {
      connectorId,
      workspaceId: safeOrgId,
      ownerId: user.uid,
      name: connector.name.slice(0, 120),
      kind: connector.kind,
      endpointUrl: connector.endpointUrl.slice(0, 500),
      deferLoading: true,
      roleAccess: connector.roleAccess,
      toolCount: Math.min(200, Math.max(0, connector.toolCount)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function persistOrgSlackConfig(
  user: User,
  orgId: string,
  settings: SlackAppSettings
): Promise<void> {
  const safeOrgId = sanitizeId(orgId);
  const path = `orgs/${safeOrgId}/private/slack`;
  const tokenHint = settings.botToken.trim()
    ? `${settings.botToken.trim().slice(0, 8)}...${settings.botToken.trim().slice(-4)}`
    : 'Not configured';

  const payload = {
    workspaceId: safeOrgId,
    ownerId: user.uid,
    botName: (settings.botName || 'EdgeOps').slice(0, 60),
    defaultChannel: (settings.defaultChannel || '#ops-triage').slice(0, 80),
    botTokenHint: tokenHint.slice(0, 64),
    hasSigningSecret: settings.signingSecret.trim().length > 0,
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'orgs', safeOrgId, 'private', 'slack'), payload);
  } catch {
    try {
      await updateDoc(doc(db, 'orgs', safeOrgId, 'private', 'slack'), {
        botName: payload.botName,
        defaultChannel: payload.defaultChannel,
        botTokenHint: payload.botTokenHint,
        hasSigningSecret: payload.hasSigningSecret,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }
}

export function subscribeToOrgIncidents(
  user: User,
  orgId: string,
  onData: (docs: Array<Record<string, unknown>>) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const safeOrgId = sanitizeId(orgId);
  const path = `orgs/${safeOrgId}/incidents`;
  const q = query(
    collection(db, 'orgs', safeOrgId, 'incidents'),
    where('ownerId', '==', user.uid),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(
    q,
    (snapshot) => {
      onData(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}

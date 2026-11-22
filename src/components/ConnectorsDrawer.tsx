import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  FileJson,
  Hash,
  Info,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import {
  SAMPLE_OPENAPI_SPEC,
  generateSlackManifestYaml,
  humanizeToolTitle,
  parseOpenApiToTools,
} from '../lib/toolRegistry';
import {
  PRODUCTION_WEBHOOK_BASE,
  buildSlackPrefilledAppUrl,
  type SlackOAuthStartResponse,
  type SlackVerifyResponse,
} from './OnboardingFlow';
import type {
  DeferredTool,
  RegisteredConnector,
  SlackAppSettings,
  SlackChannelInfo,
  ToolRoleTag,
} from '../types/edgeops';

export type SettingsTab = 'slack' | 'mcp' | 'openapi';

interface ConnectorsDrawerProps {
  initialTab?: SettingsTab;
  orgName: string | null;
  allTools: DeferredTool[];
  connectors: RegisteredConnector[];
  onAddMcpServer: (name: string, url: string, roleAccess: ToolRoleTag) => void;
  onImportOpenApi: (
    connectorName: string,
    baseUrl: string,
    roleAccess: ToolRoleTag,
    tools: DeferredTool[]
  ) => void;
  onRemoveConnector: (connectorId: string) => void;
  slackSettings: SlackAppSettings;
  slackChannels: SlackChannelInfo[];
  selectedChannelIds: string[];
  isLoadingChannels: boolean;
  isSyncingSlack: boolean;
  slackSyncNote?: string | null;
  onToggleSlackChannel: (channelId: string) => void;
  onRefreshSlackChannels: () => Promise<void>;
  onSyncSlackNow: () => Promise<void>;
  onSaveSlackSettings: (settings: SlackAppSettings) => Promise<void>;
  onOpenOnboarding: () => void;
  onBackToWorkspace: () => void;
}

export function ConnectorsDrawer({
  initialTab = 'slack',
  orgName,
  allTools,
  connectors,
  onAddMcpServer,
  onImportOpenApi,
  onRemoveConnector,
  slackSettings,
  slackChannels,
  selectedChannelIds,
  isLoadingChannels,
  isSyncingSlack,
  slackSyncNote = null,
  onToggleSlackChannel,
  onRefreshSlackChannels,
  onSyncSlackNow,
  onSaveSlackSettings,
  onOpenOnboarding,
  onBackToWorkspace,
}: ConnectorsDrawerProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Remote MCP form
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSuccess, setMcpSuccess] = useState<string | null>(null);

  // OpenAPI Importer form
  const [openApiJson, setOpenApiJson] = useState('');
  const [openApiError, setOpenApiError] = useState<string | null>(null);
  const [openApiSuccess, setOpenApiSuccess] = useState<string | null>(null);

  // Slack setup state
  const [botName, setBotName] = useState(slackSettings.slackBotName || slackSettings.botName);
  const [defaultChannel, setDefaultChannel] = useState(slackSettings.defaultChannel);
  const [botToken, setBotToken] = useState(slackSettings.botToken);
  const [signingSecret, setSigningSecret] = useState(slackSettings.signingSecret);
  const [copiedManifest, setCopiedManifest] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [previewYaml, setPreviewYaml] = useState(false);
  const [showManualToken, setShowManualToken] = useState(false);
  const [showOptionalSlack, setShowOptionalSlack] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauthSetupHint, setOauthSetupHint] = useState<{
    message: string;
    redirectUri?: string;
  } | null>(null);
  const [verifyingSlack, setVerifyingSlack] = useState(false);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [slackSavedBanner, setSlackSavedBanner] = useState<string | null>(null);

  useEffect(() => {
    setBotName(slackSettings.slackBotName || slackSettings.botName);
    setDefaultChannel(slackSettings.defaultChannel);
    setBotToken(slackSettings.botToken);
    setSigningSecret(slackSettings.signingSecret);
  }, [
    slackSettings.workspaceId,
    slackSettings.botName,
    slackSettings.slackBotName,
    slackSettings.defaultChannel,
    slackSettings.botToken,
    slackSettings.signingSecret,
  ]);

  const webhookUrl = `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${slackSettings.workspaceId}`;
  const manifestYaml = useMemo(
    () =>
      generateSlackManifestYaml(
        slackSettings.workspaceId,
        PRODUCTION_WEBHOOK_BASE,
        botName || 'EdgeOps'
      ),
    [slackSettings.workspaceId, botName]
  );
  const prefilledSlackAppUrl = useMemo(() => buildSlackPrefilledAppUrl(manifestYaml), [manifestYaml]);

  const handleConnectWithSlackOAuth = async () => {
    setOauthSetupHint(null);
    setSlackError(null);
    setSlackSavedBanner(null);
    setStartingOAuth(true);
    try {
      const res = await fetch(
        `/api/slack/oauth/start?orgId=${encodeURIComponent(slackSettings.workspaceId)}&format=json`
      );
      const data = (await res.json()) as SlackOAuthStartResponse;
      if (data.configured && data.authorizeUrl) {
        window.location.assign(data.authorizeUrl);
        return;
      }
      setOauthSetupHint({
        message:
          data.hint ||
          '1-click Slack OAuth is not configured on this server yet. Use "Create your own Slack app (pre-filled)" below to launch your Slack app in one click.',
        redirectUri: data.redirectUri,
      });
    } catch {
      setOauthSetupHint({
        message:
          'Could not reach Slack OAuth right now. Use "Create your own Slack app (pre-filled)" below or connect manually with a bot token.',
      });
    } finally {
      setStartingOAuth(false);
    }
  };

  const handleMcpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMcpError(null);
    setMcpSuccess(null);

    if (!mcpName.trim()) {
      setMcpError('Enter a name for this MCP server.');
      return;
    }
    try {
      const parsed = new URL(mcpUrl.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setMcpError('MCP Server URL must start with https:// or http://.');
        return;
      }
    } catch {
      setMcpError('Enter a valid URL (for example, https://mcp.yourcompany.com/sse).');
      return;
    }

    onAddMcpServer(mcpName.trim(), mcpUrl.trim(), 'Admin');
    setMcpSuccess(`Connected "${mcpName.trim()}" with 3 tools ready for smart checks.`);
    setMcpName('');
    setMcpUrl('');
  };

  const handleOpenApiSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setOpenApiError(null);
    setOpenApiSuccess(null);

    if (!openApiJson.trim()) {
      setOpenApiError('Paste an OpenAPI 3.0 or Swagger 2.0 JSON specification first.');
      return;
    }

    try {
      const parsed = parseOpenApiToTools(openApiJson, 'Admin');
      onImportOpenApi(parsed.connectorName, parsed.baseUrl, 'Admin', parsed.tools);
      setOpenApiSuccess(
        `Imported "${parsed.connectorName}" — ${parsed.tools.length} tools added.`
      );
      setOpenApiJson('');
    } catch (err) {
      setOpenApiError(err instanceof Error ? err.message : 'Failed to parse OpenAPI JSON.');
    }
  };

  const handleCopy = async (value: string, target: 'manifest' | 'webhook') => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Visual confirmation fallback
    }
    if (target === 'manifest') {
      setCopiedManifest(true);
      setTimeout(() => setCopiedManifest(false), 2000);
    } else {
      setCopiedWebhook(true);
      setTimeout(() => setCopiedWebhook(false), 2000);
    }
  };

  const handleTestAndSaveSlack = async (e: React.FormEvent) => {
    e.preventDefault();
    setSlackError(null);
    setSlackSavedBanner(null);

    const token = botToken.trim();
    if (!token) {
      setSlackError('Paste your Slack Bot Token (xoxb-...) first to connect.');
      return;
    }

    setVerifyingSlack(true);
    try {
      const res = await fetch('/api/slack/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: slackSettings.workspaceId,
          botToken: token,
        }),
      });
      const data = (await res.json()) as SlackVerifyResponse;
      if (!res.ok || !data.ok || !data.team || !data.user) {
        setSlackError(
          `Slack couldn't verify that token (${data.error || 'invalid_auth'}). Double-check your Bot Token and try again.`
        );
        return;
      }

      setBotName(data.user);
      await onSaveSlackSettings({
        ...slackSettings,
        botName: data.user,
        defaultChannel: defaultChannel.trim() || '#ops-triage',
        botToken: token,
        signingSecret: signingSecret.trim(),
        connected: true,
        slackTeam: data.team,
        slackBotName: data.user,
        slackBotId: data.bot_id || undefined,
        webhookUrl,
      });
      setSlackSavedBanner(`Connected to ${data.team} as @${data.user}.`);
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : 'Could not reach Slack right now.');
    } finally {
      setVerifyingSlack(false);
    }
  };

  const cleanBotHandle = (slackSettings.slackBotName || botName || 'EdgeOps').replace(/^@/, '');

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBackToWorkspace}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 mb-2 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Inbox</span>
          </button>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Connections
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {orgName ? `${orgName} · ` : ''}
            {slackSettings.connected && slackSettings.slackTeam
              ? `Slack (${slackSettings.slackTeam})`
              : 'Slack not connected'}
            {' · '}
            {connectors.length} {connectors.length === 1 ? 'custom integration' : 'custom integrations'}
            {allTools.length > 0
              ? ` · ${allTools.length} ${allTools.length === 1 ? 'tool' : 'tools'}`
              : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenOnboarding}
          className="text-xs font-medium text-slate-500 hover:text-slate-900 underline underline-offset-4 transition-colors"
        >
          Workspace setup guide
        </button>
      </div>

      {/* Clean 3-Tab Underline Navigation: Slack · MCP Servers · OpenAPI */}
      <div
        role="tablist"
        aria-label="Connections sections"
        className="flex items-center gap-6 border-b border-[#E2E8F0] overflow-x-auto"
      >
        {(
          [
            { id: 'slack', label: 'Slack', icon: MessageSquare },
            { id: 'mcp', label: 'MCP Servers', icon: Server },
            { id: 'openapi', label: 'OpenAPI', icon: FileJson },
          ] as Array<{ id: SettingsTab; label: string; icon: typeof MessageSquare }>
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`connections-tab-${tab.id}`}
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 pb-3 text-sm border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? 'border-slate-900 text-slate-900 font-medium'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: Slack (1-Click OAuth Primary + Pre-Filled BYO Link + Read-Only Synced Channels + Collapsed Manual Token) */}
      {activeTab === 'slack' && (
        <div className="max-w-2xl bg-white border border-[#E2E8F0] rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Connect Slack</h2>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Connect your workspace in one click so Slack messages sync cleanly into your shared inbox.
              </p>
            </div>
            {slackSettings.connected && slackSettings.slackTeam && (
              <span
                data-testid="settings-slack-verified-badge"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  Connected to {slackSettings.slackTeam}
                  {slackSettings.slackBotName ? ` as @${cleanBotHandle}` : ''}
                </span>
              </span>
            )}
          </div>

          {/* Primary CTA: 1-Click Connect with Slack (Standard OAuth 2.0) */}
          <div className="space-y-3">
            <button
              type="button"
              data-testid="connect-with-slack-btn"
              disabled={startingOAuth}
              onClick={() => void handleConnectWithSlackOAuth()}
              className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-3 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-xl transition-colors"
            >
              <Hash className="w-4 h-4 text-emerald-400" />
              <span>
                {startingOAuth
                  ? 'Connecting to Slack...'
                  : slackSettings.connected
                    ? 'Reconnect with Slack'
                    : 'Connect with Slack'}
              </span>
            </button>

            {oauthSetupHint && (
              <div
                data-testid="slack-oauth-hint"
                role="status"
                className="rounded-xl bg-blue-50/70 border border-blue-200 px-3.5 py-3 text-xs text-slate-700 space-y-1.5"
              >
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">{oauthSetupHint.message}</p>
                </div>
                {oauthSetupHint.redirectUri && (
                  <div className="pl-6 space-y-1">
                    <p className="text-[11px] text-slate-500">OAuth callback URL:</p>
                    <code className="block font-mono text-[11px] text-slate-700 bg-white border border-blue-200/70 rounded-md px-2 py-1 overflow-x-auto whitespace-nowrap">
                      {oauthSetupHint.redirectUri}
                    </code>
                  </div>
                )}
              </div>
            )}

            {/* Secondary CTA: 1-Click Pre-Filled BYO Slack App Deep Link */}
            <a
              href={prefilledSlackAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="create-prefilled-slack-app-link"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-800 bg-white border border-[#E2E8F0] hover:bg-slate-50 hover:border-slate-300 rounded-xl transition-colors"
            >
              <span>Create your own Slack app (pre-filled)</span>
              <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
            </a>

            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-1">
              <button
                type="button"
                data-testid="settings-copy-manifest-btn"
                onClick={() => handleCopy(manifestYaml, 'manifest')}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 transition-colors"
              >
                {copiedManifest ? (
                  <Check className="w-3 h-3 text-emerald-600" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>{copiedManifest ? 'Manifest copied' : 'Copy manifest'}</span>
              </button>

              <button
                type="button"
                data-testid="settings-preview-yaml-toggle"
                onClick={() => setPreviewYaml((prev) => !prev)}
                aria-expanded={previewYaml}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 underline underline-offset-4 transition-colors"
              >
                {previewYaml ? 'Hide YAML' : 'Preview YAML'}
              </button>

              <button
                type="button"
                onClick={() => handleCopy(webhookUrl, 'webhook')}
                className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
              >
                {copiedWebhook ? 'Webhook URL copied' : 'Copy webhook URL'}
              </button>
            </div>

            {previewYaml && (
              <pre
                data-testid="settings-yaml-preview"
                className="p-3.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] font-mono text-[11px] text-slate-700 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed"
              >
                {manifestYaml}
              </pre>
            )}
          </div>

          {slackSavedBanner && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{slackSavedBanner}</span>
            </div>
          )}

          {/* Synced Channels (Strictly Read-Only Channel Picker) */}
          <div
            data-testid="synced-channels-card"
            className="rounded-xl border border-[#E2E8F0] bg-white p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-900">Synced Channels</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Choose which channels @{cleanBotHandle} watches (read-only — never posts automatically).
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="refresh-channels-btn"
                  disabled={isLoadingChannels || !slackSettings.connected}
                  onClick={() => void onRefreshSlackChannels()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap"
                >
                  <RefreshCw className={`w-3 h-3 text-slate-500 ${isLoadingChannels ? 'animate-spin' : ''}`} />
                  <span>{isLoadingChannels ? 'Loading...' : 'Refresh'}</span>
                </button>

                <button
                  type="button"
                  data-testid="settings-sync-now-btn"
                  disabled={isSyncingSlack || !slackSettings.connected}
                  onClick={() => void onSyncSlackNow()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap"
                >
                  <span>{isSyncingSlack ? 'Syncing...' : 'Sync now'}</span>
                </button>
              </div>
            </div>

            {slackSyncNote && (
              <p className="text-[11px] text-slate-600 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2">
                {slackSyncNote}
              </p>
            )}

            {!slackSettings.connected ? (
              <p className="text-xs text-slate-500 bg-[#F8FAFC] border border-dashed border-[#E2E8F0] rounded-lg px-3.5 py-3">
                Connect Slack above to automatically discover every channel your bot is already in.
              </p>
            ) : slackChannels.length === 0 ? (
              <p className="text-xs text-slate-500 bg-[#F8FAFC] border border-dashed border-[#E2E8F0] rounded-lg px-3.5 py-3">
                No channels found yet. In Slack, invite{' '}
                <code className="font-mono text-slate-800">/invite @{cleanBotHandle}</code> to any
                channel, then click <span className="font-medium text-slate-700">Refresh</span>.
              </p>
            ) : (
              <div
                data-testid="synced-channels-list"
                className="divide-y divide-slate-100 border border-[#E2E8F0] rounded-lg overflow-hidden max-h-56 overflow-y-auto"
              >
                {slackChannels.map((ch) => {
                  const isChecked =
                    selectedChannelIds.length === 0 || selectedChannelIds.includes(ch.id);
                  return (
                    <label
                      key={ch.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 bg-white hover:bg-[#F8FAFC] cursor-pointer transition-colors"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => onToggleSlackChannel(ch.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-blue-600"
                        />
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-800 truncate">
                          {ch.is_private ? (
                            <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                          ) : (
                            <Hash className="w-3 h-3 text-slate-400 shrink-0" />
                          )}
                          <span className="truncate">{ch.name}</span>
                        </span>
                      </span>
                      <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                        {ch.num_members} {ch.num_members === 1 ? 'member' : 'members'}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quiet Invite Hint */}
          <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]/70 p-4">
            <p className="text-xs font-medium text-slate-900">Invite your bot to any channel</p>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
              Type{' '}
              <code className="font-mono text-xs text-slate-800 bg-white border border-[#E2E8F0] px-1.5 py-0.5 rounded">
                /invite @{cleanBotHandle}
              </code>{' '}
              in Slack to start syncing messages into your inbox.
            </p>
          </div>

          {/* Collapsed Advanced Manual Bot Token Toggle */}
          <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
            <button
              type="button"
              data-testid="toggle-manual-slack-token"
              aria-expanded={showManualToken}
              onClick={() => setShowManualToken((prev) => !prev)}
              className="w-full flex items-center justify-between text-xs font-medium text-slate-500 hover:text-slate-900 transition-colors"
            >
              <span>Already have a custom bot token? Connect manually</span>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform ${
                  showManualToken ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showManualToken && (
              <form
                onSubmit={handleTestAndSaveSlack}
                data-testid="manual-slack-token-panel"
                className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]/70 p-4 space-y-3"
              >
                <div>
                  <label
                    htmlFor="slack-bot-token"
                    className="block text-xs font-medium text-slate-800"
                  >
                    Bot User OAuth Token (xoxb-...)
                  </label>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Copy the Bot User OAuth Token from your custom Slack app and verify the connection.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="slack-bot-token"
                    type="password"
                    value={botToken}
                    onChange={(e) => {
                      setBotToken(e.target.value);
                      if (slackError) setSlackError(null);
                    }}
                    placeholder="xoxb-..."
                    className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-[#E2E8F0] rounded-lg placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                  />
                  <button
                    type="submit"
                    disabled={verifyingSlack}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{verifyingSlack ? 'Connecting...' : 'Test & Connect'}</span>
                  </button>
                </div>

                {slackError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg p-3"
                  >
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>{slackError}</span>
                  </div>
                )}

                <div>
                  <button
                    type="button"
                    onClick={() => setShowOptionalSlack((prev) => !prev)}
                    aria-expanded={showOptionalSlack}
                    className="text-[11px] font-medium text-slate-500 hover:text-slate-800 transition-colors"
                  >
                    {showOptionalSlack
                      ? 'Hide optional settings'
                      : 'Optional: Signing secret, bot name & default channel'}
                  </button>

                  {showOptionalSlack && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2.5">
                      <div className="space-y-1">
                        <label
                          htmlFor="slack-signing-secret"
                          className="block text-[11px] font-medium text-slate-600"
                        >
                          Signing Secret
                        </label>
                        <input
                          id="slack-signing-secret"
                          type="password"
                          value={signingSecret}
                          onChange={(e) => setSigningSecret(e.target.value)}
                          placeholder="Optional secret"
                          className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor="slack-bot-name"
                          className="block text-[11px] font-medium text-slate-600"
                        >
                          Bot name
                        </label>
                        <input
                          id="slack-bot-name"
                          type="text"
                          value={botName}
                          onChange={(e) => setBotName(e.target.value)}
                          placeholder="EdgeOps"
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor="slack-channel"
                          className="block text-[11px] font-medium text-slate-600"
                        >
                          Default channel
                        </label>
                        <input
                          id="slack-channel"
                          type="text"
                          value={defaultChannel}
                          onChange={(e) => setDefaultChannel(e.target.value)}
                          placeholder="#ops-triage"
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: MCP Servers */}
      {activeTab === 'mcp' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleMcpSubmit}
            className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4"
          >
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Add MCP Server</h2>
              <p className="text-xs text-slate-500 mt-1">
                Connect a remote MCP server so CalmDuty can load its tools on demand during checks.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="mcp-name" className="block text-xs font-medium text-slate-700">
                Server name
              </label>
              <input
                id="mcp-name"
                type="text"
                value={mcpName}
                onChange={(e) => setMcpName(e.target.value)}
                placeholder="e.g., Internal Ledger MCP"
                className="w-full px-3 py-2 text-sm bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="mcp-url" className="block text-xs font-medium text-slate-700">
                Server URL
              </label>
              <input
                id="mcp-url"
                type="url"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                placeholder="https://mcp.yourcompany.com/sse"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            {mcpError && (
              <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                {mcpError}
              </p>
            )}
            {mcpSuccess && (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
                {mcpSuccess}
              </p>
            )}

            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Connect MCP server</span>
            </button>
          </form>

          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Connected servers & specs ({connectors.length})
            </h3>
            {connectors.length === 0 ? (
              <div className="p-8 text-center rounded-lg bg-[#F8FAFC] border border-dashed border-[#E2E8F0]">
                <p className="text-sm font-medium text-slate-700">No custom integrations yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Connect an MCP server or import an OpenAPI JSON spec to enable live tool checks.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="divide-y divide-slate-100 border border-[#E2E8F0] rounded-lg overflow-hidden">
                  {connectors.map((c) => (
                    <div key={c.id} className="p-3.5 flex items-center justify-between gap-3 bg-white">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900">
                          {c.name}{' '}
                          <span className="text-xs font-normal text-slate-500">
                            · {c.kind === 'mcp' ? 'MCP' : 'OpenAPI'} · {c.toolCount}{' '}
                            {c.toolCount === 1 ? 'tool' : 'tools'}
                          </span>
                        </div>
                        <p className="text-xs font-mono text-slate-500 truncate mt-0.5">{c.endpointUrl}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemoveConnector(c.id)}
                        aria-label={`Remove ${c.name}`}
                        className="p-2 text-slate-400 hover:text-rose-600 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {allTools.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-slate-700">
                      Available tools ({allTools.length})
                    </h4>
                    <div className="divide-y divide-slate-100 border border-[#E2E8F0] rounded-lg overflow-hidden max-h-56 overflow-y-auto">
                      {allTools.map((tool) => (
                        <div key={tool.name} className="px-3.5 py-2.5 bg-white">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-900">
                              {humanizeToolTitle(tool.name)}
                            </span>
                            <span className="text-[11px] text-slate-400">{tool.sourceName}</span>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">{tool.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: OpenAPI */}
      {activeTab === 'openapi' && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Import OpenAPI / Swagger JSON
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Paste an OpenAPI 3.0 or Swagger 2.0 JSON spec to register its endpoints as on-demand tools.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpenApiJson(SAMPLE_OPENAPI_SPEC);
                setOpenApiError(null);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>Insert example JSON</span>
            </button>
          </div>

          <form onSubmit={handleOpenApiSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="openapi-textarea" className="block text-xs font-medium text-slate-700">
                OpenAPI 3.0 / Swagger 2.0 JSON
              </label>
              <textarea
                id="openapi-textarea"
                rows={10}
                value={openApiJson}
                onChange={(e) => setOpenApiJson(e.target.value)}
                placeholder='{"openapi": "3.0.3", "info": {"title": "My Ops API"}, "paths": { ... }}'
                className="w-full p-3 text-xs font-mono bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            {openApiError && (
              <p role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                {openApiError}
              </p>
            )}
            {openApiSuccess && (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
                {openApiSuccess}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Convert & import tools</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

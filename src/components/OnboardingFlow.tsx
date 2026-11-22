import { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Hash,
  Info,
  LogIn,
  ShieldCheck,
} from 'lucide-react';
import { generateSlackManifestYaml } from '../lib/toolRegistry';
import type { SlackAppSettings } from '../types/edgeops';

export const PRODUCTION_WEBHOOK_BASE = 'https://calmduty.web.app';

export function buildSlackPrefilledAppUrl(manifestYaml: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml)}`;
}

export interface SlackOAuthStartResponse {
  ok: boolean;
  configured: boolean;
  authorizeUrl?: string;
  redirectUri?: string;
  hint?: string;
}

export interface SlackVerifyResponse {
  ok: boolean;
  team: string | null;
  user: string | null;
  bot_id: string | null;
  error: string | null;
}

interface OnboardingFlowProps {
  user: User | null;
  authLoading: boolean;
  onSignIn: () => void;
  hasExistingWorkspace?: boolean;
  onCancelToWorkspace?: () => void;
  initialOrgName?: string;
  onCreateOrg: (input: { name: string }) => Promise<{ orgId: string; name: string }>;
  onSaveVerifiedSlack: (settings: SlackAppSettings) => Promise<void>;
  onFinishSlackSetup: (settings: SlackAppSettings) => Promise<void>;
  onLaunchSandbox?: () => void;
}

export function OnboardingFlow({
  user,
  authLoading,
  onSignIn,
  hasExistingWorkspace = false,
  onCancelToWorkspace,
  initialOrgName = '',
  onCreateOrg,
  onSaveVerifiedSlack,
  onFinishSlackSetup,
  onLaunchSandbox,
}: OnboardingFlowProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [orgName, setOrgName] = useState(initialOrgName);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [creatingOrg, setCreatingOrg] = useState(false);

  // Step 2 state
  const [createdOrgId, setCreatedOrgId] = useState<string>('');
  const [botName, setBotName] = useState('EdgeOps');
  const [defaultChannel, setDefaultChannel] = useState('#ops-triage');
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [copiedManifest, setCopiedManifest] = useState(false);
  const [previewYaml, setPreviewYaml] = useState(false);
  const [showManualToken, setShowManualToken] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauthSetupHint, setOauthSetupHint] = useState<{
    message: string;
    redirectUri?: string;
  } | null>(null);
  const [verifyingSlack, setVerifyingSlack] = useState(false);
  const [savingSlack, setSavingSlack] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifiedConnection, setVerifiedConnection] = useState<{
    team: string;
    user: string;
    botId?: string;
  } | null>(null);

  const liveWebhookUrl = `${PRODUCTION_WEBHOOK_BASE}/webhooks/slack/${createdOrgId || 'your-org-id'}`;
  const cleanBotHandle = (verifiedConnection?.user || botName.trim() || 'EdgeOps').replace(/^@/, '');
  const manifestYaml = useMemo(
    () =>
      generateSlackManifestYaml(
        createdOrgId || 'your-org-id',
        PRODUCTION_WEBHOOK_BASE,
        botName.trim() || 'EdgeOps'
      ),
    [createdOrgId, botName]
  );
  const prefilledSlackAppUrl = useMemo(() => buildSlackPrefilledAppUrl(manifestYaml), [manifestYaml]);

  const handleConnectWithSlackOAuth = async () => {
    setOauthSetupHint(null);
    setVerifyError(null);
    setStartingOAuth(true);
    try {
      const targetOrg = createdOrgId || 'org_workspace';
      const res = await fetch(
        `/api/slack/oauth/start?orgId=${encodeURIComponent(targetOrg)}&format=json`
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

  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrgError(null);
    const trimmed = orgName.trim();
    if (trimmed.length < 2) {
      setOrgError('Enter a team or company name (at least 2 characters).');
      return;
    }

    setCreatingOrg(true);
    try {
      const created = await onCreateOrg({ name: trimmed });
      setCreatedOrgId(created.orgId);
      setStep(2);
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : 'Unable to create workspace right now.');
    } finally {
      setCreatingOrg(false);
    }
  };

  const handleCopy = async (text: string, target: 'webhook' | 'manifest') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Visual confirmation fallback
    }
    if (target === 'webhook') {
      setCopiedWebhook(true);
      setTimeout(() => setCopiedWebhook(false), 2000);
    } else {
      setCopiedManifest(true);
      setTimeout(() => setCopiedManifest(false), 2000);
    }
  };

  const handleTestAndSaveSlack = async () => {
    setVerifyError(null);
    const token = botToken.trim();
    if (!token) {
      setVerifyError('Paste your Slack Bot Token (xoxb-...) first to connect.');
      return;
    }

    setVerifyingSlack(true);
    try {
      const res = await fetch('/api/slack/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: createdOrgId,
          botToken: token,
        }),
      });
      const data = (await res.json()) as SlackVerifyResponse;
      if (!res.ok || !data.ok || !data.team || !data.user) {
        setVerifiedConnection(null);
        setVerifyError(
          `Slack couldn't verify that token (${data.error || 'invalid_auth'}). Double-check your xoxb- Bot Token and try again.`
        );
        return;
      }

      setBotName(data.user);
      setVerifiedConnection({
        team: data.team,
        user: data.user,
        botId: data.bot_id || undefined,
      });

      await onSaveVerifiedSlack({
        workspaceId: createdOrgId,
        botName: data.user,
        defaultChannel: defaultChannel.trim() || '#ops-triage',
        botToken: token,
        signingSecret: signingSecret.trim(),
        connected: true,
        slackTeam: data.team,
        slackBotName: data.user,
        slackBotId: data.bot_id || undefined,
        webhookUrl: liveWebhookUrl,
      });
    } catch (err) {
      setVerifiedConnection(null);
      setVerifyError(
        err instanceof Error ? err.message : 'Could not reach Slack right now. Please try again.'
      );
    } finally {
      setVerifyingSlack(false);
    }
  };

  const handleStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSlack(true);
    try {
      await onFinishSlackSetup({
        workspaceId: createdOrgId,
        botName: verifiedConnection?.user || botName.trim() || 'EdgeOps',
        defaultChannel: defaultChannel.trim() || '#ops-triage',
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim(),
        connected: Boolean(verifiedConnection),
        slackTeam: verifiedConnection?.team,
        slackBotName: verifiedConnection?.user,
        slackBotId: verifiedConnection?.botId,
        webhookUrl: liveWebhookUrl,
      });
    } finally {
      setSavingSlack(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
      {/* Minimal Onboarding Header */}
      <header className="h-14 border-b border-[#E2E8F0] bg-white px-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center">
            <ShieldCheck className="w-4 h-4" />
          </span>
          <span className="font-display text-base font-semibold tracking-tight text-slate-900">
            CalmDuty
          </span>
        </div>

        <div className="flex items-center gap-3">
          {hasExistingWorkspace && onCancelToWorkspace && (
            <button
              type="button"
              onClick={onCancelToWorkspace}
              className="text-xs font-medium text-slate-500 hover:text-slate-900 transition-colors"
            >
              Back to workspace
            </button>
          )}

          {user ? (
            <span className="text-xs text-slate-600">{user.email || user.displayName}</span>
          ) : (
            <button
              type="button"
              disabled={authLoading}
              onClick={onSignIn}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-[#E2E8F0] hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>{authLoading ? 'Signing in...' : 'Sign in with Google'}</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Centered Onboarding Card */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-xl bg-white border border-[#E2E8F0] rounded-2xl p-8 sm:p-10">
          {/* Calm Step Indicator */}
          <div className="flex items-center justify-between text-xs text-slate-500 mb-6">
            <span className="font-medium text-slate-700">
              Step {step} of 2 · {step === 1 ? 'Create Workspace' : 'Connect Slack'}
            </span>
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <span className="w-8 h-1 rounded-full bg-slate-900" />
              <span
                className={`w-8 h-1 rounded-full transition-colors ${
                  step === 2 ? 'bg-slate-900' : 'bg-slate-200'
                }`}
              />
            </div>
          </div>

          {step === 1 ? (
            <form onSubmit={handleStep1Submit} className="space-y-6">
              <div>
                <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                  Create your workspace
                </h1>
                <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
                  Start with a clean shared inbox for your Slack channels. Personal details stay private on your device.
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="onboarding-org-name"
                  className="block text-sm font-medium text-slate-800"
                >
                  Organization name
                </label>
                <input
                  id="onboarding-org-name"
                  type="text"
                  autoFocus
                  value={orgName}
                  onChange={(e) => {
                    setOrgName(e.target.value);
                    if (orgError) setOrgError(null);
                  }}
                  placeholder="e.g., Northstar Ops"
                  className="w-full px-3.5 py-2.5 text-sm text-slate-900 bg-white border border-[#E2E8F0] rounded-lg placeholder:text-slate-400 focus:outline-none focus:border-blue-600 transition-colors"
                />
              </div>

              {orgError && (
                <p
                  role="alert"
                  className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"
                >
                  {orgError}
                </p>
              )}

              <div className="pt-2 space-y-3">
                <button
                  type="submit"
                  disabled={creatingOrg}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors"
                >
                  <span>{creatingOrg ? 'Creating workspace...' : 'Continue to Slack setup'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>

                {onLaunchSandbox && (
                  <div className="pt-2 border-t border-[#E2E8F0] space-y-1.5">
                    <button
                      type="button"
                      data-testid="launch-sandbox-workspace-btn"
                      onClick={onLaunchSandbox}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-[#F8FAFC] hover:bg-slate-100 border border-[#E2E8F0] rounded-lg transition-colors"
                    >
                      <span>Try Sandbox Workspace (Synthetic Agent Stream)</span>
                    </button>
                    <p className="text-center text-[11px] text-slate-500">
                      Test local PII scrubbing, ×N grouping, streaming chat &amp; Dynamic Tools with zero real data.
                    </p>
                  </div>
                )}

                {!user && (
                  <p className="text-center text-xs text-slate-500">
                    Sign in with Google above to save your workspace and sync across devices.
                  </p>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={handleStep2Submit} className="space-y-6">
              <div>
                <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                  Connect Slack
                </h1>
                <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
                  Connect your Slack workspace in one click so team and customer messages flow straight into your inbox.
                </p>
              </div>

              {verifiedConnection && (
                <div
                  data-testid="onboarding-slack-verified-badge"
                  className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>
                    Connected to {verifiedConnection.team} as @{verifiedConnection.user}
                  </span>
                </div>
              )}

              {/* Primary CTA: 1-Click Standard Slack OAuth 2.0 */}
              <div className="space-y-3">
                <button
                  type="button"
                  data-testid="connect-with-slack-btn"
                  disabled={startingOAuth}
                  onClick={() => void handleConnectWithSlackOAuth()}
                  className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-3 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-xl transition-colors"
                >
                  <Hash className="w-4 h-4 text-emerald-400" />
                  <span>{startingOAuth ? 'Connecting to Slack...' : 'Connect with Slack'}</span>
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
                    data-testid="onboarding-copy-manifest-btn"
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
                    data-testid="onboarding-preview-yaml-toggle"
                    onClick={() => setPreviewYaml((prev) => !prev)}
                    aria-expanded={previewYaml}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900 underline underline-offset-4 transition-colors"
                  >
                    {previewYaml ? 'Hide YAML' : 'Preview YAML'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleCopy(liveWebhookUrl, 'webhook')}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
                  >
                    {copiedWebhook ? 'Webhook URL copied' : 'Copy webhook URL'}
                  </button>
                </div>

                {previewYaml && (
                  <pre
                    data-testid="onboarding-yaml-preview"
                    className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] font-mono text-[11px] text-slate-700 overflow-x-auto whitespace-pre-wrap break-words max-h-44 leading-relaxed"
                  >
                    {manifestYaml}
                  </pre>
                )}
              </div>

              {/* Quick Invite Reminder */}
              <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]/70 px-4 py-3 text-xs text-slate-600 leading-relaxed">
                Once connected, invite your bot to any channel with{' '}
                <code className="font-mono text-slate-800 bg-white border border-[#E2E8F0] px-1.5 py-0.5 rounded">
                  /invite @{cleanBotHandle}
                </code>
                .
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
                  <div
                    data-testid="manual-slack-token-panel"
                    className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]/70 p-4 space-y-3"
                  >
                    <div>
                      <label
                        htmlFor="onboarding-bot-token"
                        className="block text-xs font-medium text-slate-800"
                      >
                        Bot User OAuth Token (xoxb-...)
                      </label>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Found under <span className="font-medium text-slate-700">OAuth &amp; Permissions</span> in your custom Slack app.
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        id="onboarding-bot-token"
                        type="password"
                        value={botToken}
                        onChange={(e) => {
                          setBotToken(e.target.value);
                          if (verifyError) setVerifyError(null);
                        }}
                        placeholder="xoxb-..."
                        className="flex-1 px-3 py-2 text-xs font-mono text-slate-900 bg-white border border-[#E2E8F0] rounded-lg placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                      />
                      <button
                        type="button"
                        disabled={verifyingSlack}
                        onClick={() => void handleTestAndSaveSlack()}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{verifyingSlack ? 'Connecting...' : 'Test & Connect'}</span>
                      </button>
                    </div>

                    {verifyError && (
                      <div
                        role="alert"
                        className="flex items-start gap-2 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800"
                      >
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                        <span>{verifyError}</span>
                      </div>
                    )}

                    <div>
                      <button
                        type="button"
                        onClick={() => setShowMoreOptions((prev) => !prev)}
                        aria-expanded={showMoreOptions}
                        className="text-[11px] font-medium text-slate-500 hover:text-slate-800 transition-colors"
                      >
                        {showMoreOptions
                          ? 'Hide optional settings'
                          : 'Optional: Signing secret & channel'}
                      </button>

                      {showMoreOptions && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2.5">
                          <div className="space-y-1">
                            <label
                              htmlFor="onboarding-signing-secret"
                              className="block text-[11px] font-medium text-slate-600"
                            >
                              Signing Secret
                            </label>
                            <input
                              id="onboarding-signing-secret"
                              type="password"
                              value={signingSecret}
                              onChange={(e) => setSigningSecret(e.target.value)}
                              placeholder="Optional secret"
                              className="w-full px-2.5 py-1.5 text-xs font-mono text-slate-900 bg-white border border-[#E2E8F0] rounded-lg placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div className="space-y-1">
                            <label
                              htmlFor="onboarding-channel"
                              className="block text-[11px] font-medium text-slate-600"
                            >
                              Default channel
                            </label>
                            <input
                              id="onboarding-channel"
                              type="text"
                              value={defaultChannel}
                              onChange={(e) => setDefaultChannel(e.target.value)}
                              placeholder="#ops-triage"
                              className="w-full px-2.5 py-1.5 text-xs text-slate-900 bg-white border border-[#E2E8F0] rounded-lg focus:outline-none focus:border-blue-600"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>

                <button
                  type="submit"
                  disabled={savingSlack}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  <span>{savingSlack ? 'Opening...' : 'Open workspace'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

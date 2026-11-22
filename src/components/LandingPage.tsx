import { useState } from 'react';
import type { User } from 'firebase/auth';
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  Smartphone,
  Sparkles,
  Terminal,
} from 'lucide-react';

interface LandingPageProps {
  user: User | null;
  authLoading: boolean;
  hasExistingWorkspace: boolean;
  onSignIn: () => void;
  onLaunchSandbox: () => void;
  onStartWorkspaceSetup: () => void;
  onOpenExistingWorkspace?: () => void;
}

type HeroPreviewMode = 'inbox' | 'briefing';
type SetupTab = 'sandbox' | 'docker' | 'cloudrun' | 'android';

const ANDROID_APK_DOWNLOAD_URL = '/downloads/calmduty-v0.1.0-android.apk';
const ANDROID_SHA256_URL = '/downloads/SHA256SUMS.txt';
const WEB_REPO_URL = 'https://github.com/Timtech4u/edgeops';
const ANDROID_REPO_URL = 'https://github.com/Timtech4u/edgeops-android';
const CLOUD_RUN_DEPLOY_URL = 'https://deploy.cloud.run?git_repo=https://github.com/Timtech4u/edgeops';

const SETUP_TABS: Record<
  SetupTab,
  {
    label: string;
    command: string;
    caption: string;
    action: 'sandbox' | 'copy' | 'cloudrun' | 'apk';
  }
> = {
  sandbox: {
    label: 'Live Sandbox',
    command: 'Zero sign-up · 10 synthetic alerts · 6-signal routing · 6 MCP/OpenAPI tools',
    caption:
      'Test local PII redaction, ×3 duplicate grouping, 6-signal Decisions routing, and the proactive Window Briefing right now in your browser.',
    action: 'sandbox',
  },
  docker: {
    label: 'Docker Compose',
    command: 'git clone https://github.com/Timtech4u/edgeops.git && cd edgeops && docker compose up -d',
    caption:
      'Self-host on localhost or your private VPC in 30 seconds. Add --profile local-ai for an air-gapped Ollama sidecar.',
    action: 'copy',
  },
  cloudrun: {
    label: '1-Click Cloud Run',
    command: CLOUD_RUN_DEPLOY_URL,
    caption:
      'Deploy an isolated single-tenant instance inside your own Google Cloud project (~2 min). You own 100% of tokens and API keys.',
    action: 'cloudrun',
  },
  android: {
    label: 'Android APK',
    command: 'https://calmduty.web.app/downloads/calmduty-v0.1.0-android.apk',
    caption:
      'Direct 1-tap APK download (v0.1.0 · 29 MB · Android 10+ · Gemini Nano on-device fallback). Verify with SHA256SUMS.txt.',
    action: 'apk',
  },
};

export function LandingPage({
  user,
  authLoading,
  hasExistingWorkspace,
  onSignIn,
  onLaunchSandbox,
  onStartWorkspaceSetup,
  onOpenExistingWorkspace,
}: LandingPageProps) {
  const [heroMode, setHeroMode] = useState<HeroPreviewMode>('inbox');
  const [setupTab, setSetupTab] = useState<SetupTab>('sandbox');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleOpenPrimaryApp = () => {
    if (hasExistingWorkspace && onOpenExistingWorkspace) {
      onOpenExistingWorkspace();
      return;
    }
    if (user) {
      onStartWorkspaceSetup();
      return;
    }
    onLaunchSandbox();
  };

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Visual confirmation fallback
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 2000);
  };

  const activeSetup = SETUP_TABS[setupTab];

  return (
    <div
      id="top"
      className="min-h-screen bg-[#F2F3F5] text-[#0B0B0C] overflow-x-hidden selection:bg-[#2B3BFF] selection:text-white"
    >
      {/* HERO WRAPPER (Pure White Canvas) */}
      <div className="bg-white text-[#0B0B0C] px-5 sm:px-10 lg:px-20">
        {/* Minimal Modern Top Navigation */}
        <header className="max-w-[1280px] mx-auto flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5">
          <a
            href="#top"
            className="inline-flex items-center gap-2.5 min-h-[44px] text-[#0B0B0C] font-editorial font-extrabold text-[24px] tracking-[-0.025em] no-underline"
          >
            <span
              aria-hidden="true"
              className="w-3.5 h-3.5 rounded-full bg-[#2B3BFF] shrink-0"
            />
            <span>CalmDuty</span>
          </a>

          <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              href="#features"
              className="inline-flex items-center min-h-[40px] text-[15px] font-medium text-[#3A3B40] hover:text-[#0B0B0C] transition-colors"
            >
              Features
            </a>
            <a
              href="#how"
              className="inline-flex items-center min-h-[40px] text-[15px] font-medium text-[#3A3B40] hover:text-[#0B0B0C] transition-colors"
            >
              How it works
            </a>
            <a
              href="#docs"
              className="inline-flex items-center min-h-[40px] text-[15px] font-medium text-[#3A3B40] hover:text-[#0B0B0C] transition-colors"
            >
              Self-host
            </a>
            <a
              href={ANDROID_APK_DOWNLOAD_URL}
              download="calmduty-v0.1.0-android.apk"
              data-testid="landing-nav-apk-link"
              className="inline-flex items-center gap-1.5 min-h-[40px] text-[15px] font-medium text-[#3A3B40] hover:text-[#2B3BFF] transition-colors"
            >
              <Smartphone className="w-4 h-4" />
              <span>Android APK</span>
            </a>

            {!user ? (
              <button
                type="button"
                disabled={authLoading}
                onClick={onSignIn}
                className="inline-flex items-center min-h-[40px] text-[15px] font-medium text-[#3A3B40] hover:text-[#0B0B0C] transition-colors disabled:opacity-50"
              >
                {authLoading ? 'Signing in...' : 'Sign in'}
              </button>
            ) : null}

            <button
              type="button"
              data-testid="landing-nav-open-app"
              onClick={handleOpenPrimaryApp}
              className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-full bg-[#0B0B0C] hover:bg-[#2B3BFF] text-white text-[15px] font-semibold transition-colors whitespace-nowrap"
            >
              <span>
                {hasExistingWorkspace ? 'Open Workspace' : user ? 'Create Workspace' : 'Try Sandbox'}
              </span>
            </button>
          </nav>
        </header>

        {/* Monumental Typographic Hero */}
        <div className="max-w-[1280px] mx-auto pt-8 sm:pt-14 pb-10 sm:pb-16 flex flex-col gap-6 sm:gap-9">
          {/* Source Flow Pill Row */}
          <div className="flex flex-wrap items-center gap-2 font-mono text-[13px] font-medium">
            <span className="px-3 py-1.5 rounded-full border-[1.5px] border-[#0B0B0C] bg-white">
              Slack
            </span>
            <span className="px-3 py-1.5 rounded-full border-[1.5px] border-[#0B0B0C] bg-white">
              Webhooks
            </span>
            <span className="px-3 py-1.5 rounded-full border-[1.5px] border-[#0B0B0C] bg-white">
              MCP / OpenAPI
            </span>
            <ArrowRight className="w-4 h-4 text-[#0B0B0C] shrink-0" aria-hidden="true" />
            <span className="px-3.5 py-1.5 rounded-full bg-[#2B3BFF] text-white font-semibold">
              One inbox
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 ml-2 text-[12px] text-[#4B4D52]">
              MIT Open Source · Zero Data Retention
            </span>
          </div>

          {/* Monumental Display Headline */}
          <h1 className="m-0 font-editorial font-extrabold text-[clamp(46px,8.6vw,126px)] leading-[0.95] tracking-[-0.045em]">
            <span className="text-[#E8431F] line-through decoration-[0.07em]">
              All that noise.
            </span>
            <br />
            <span className="text-[#2B3BFF]">One calm inbox.</span>
          </h1>

          {/* Subtitle + Primary Action Pills */}
          <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
            <p className="flex-1 basis-[440px] max-w-[660px] m-0 text-[clamp(17px,1.5vw,21px)] leading-[1.55] text-[#3A3B40]">
              AI agents and monitoring bots flood Slack and webhooks with duplicate noise and raw
              customer PII. CalmDuty collapses the chaos into one clean inbox—scrubbed on your
              device, routed at <strong className="font-semibold text-[#0B0B0C]">0 output tokens</strong>,
              and ready offline on Web and Android.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="landing-try-sandbox"
                onClick={onLaunchSandbox}
                className="inline-flex items-center gap-2.5 min-h-[58px] px-7 rounded-full bg-[#2B3BFF] hover:bg-[#1E2CE6] text-white text-[17px] font-semibold transition-colors whitespace-nowrap"
              >
                <span>Try Live Sandbox</span>
                <ArrowRight className="w-5 h-5" />
              </button>

              <a
                href={ANDROID_APK_DOWNLOAD_URL}
                download="calmduty-v0.1.0-android.apk"
                data-testid="landing-hero-apk-btn"
                className="inline-flex items-center gap-2 min-h-[58px] px-7 rounded-full border-2 border-[#0B0B0C] bg-white hover:bg-[#0B0B0C] hover:text-white text-[#0B0B0C] text-[17px] font-semibold transition-colors whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>Download APK</span>
              </a>
            </div>
          </div>
        </div>

        {/* SIGNATURE NOISE -> CALM VISUAL PANEL */}
        <div className="max-w-[1280px] mx-auto pb-14 sm:pb-20 flex flex-wrap lg:flex-nowrap items-center gap-8 lg:gap-6">
          {/* Left: Tilted Neo-Brutalist Stacked Alert Noise */}
          <div
            aria-label="Noisy incoming bot alerts"
            className="flex-1 basis-[340px] min-w-0 flex flex-col py-3 px-2 font-mono text-[13px] leading-[1.45] text-[#0B0B0C] break-words"
          >
            <div className="self-start max-w-[90%] px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-[#FF5B37] -rotate-[3.5deg]">
              <b>#payments-ops</b> EU gateway 504 timeout (eu-west-2)
            </div>
            <div className="self-end max-w-[90%] -mt-2.5 px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-white rotate-[2.5deg]">
              <b>webhook</b> EU gateway 504 timeout (retry burst #2)
            </div>
            <div className="self-start max-w-[92%] -mt-3 ml-[5%] px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-[#FFD2C7] -rotate-[2deg]">
              <b>#virtual-cards</b> Card auto-frozen for maya.chen@northstar-demo.io · 4532 8910 4421 9004
            </div>
            <div className="self-end max-w-[90%] -mt-3 px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-[#FF5B37] rotate-[4deg]">
              <b>#payments-ops</b> EU gateway 504 timeout (14 orders pending)
            </div>
            <div className="self-start max-w-[90%] -mt-3 px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-white -rotate-[3.5deg]">
              <b>#wallet-funding</b> Paystack top-up credited: ₦1,129,000 paid
            </div>
            <div className="self-center max-w-[88%] -mt-2.5 px-4 py-3 rounded-xl border-2 border-[#0B0B0C] shadow-[4px_4px_0_#0B0B0C] bg-[#FFD2C7] rotate-[2deg]">
              <b>#ops-noise</b> ResizeObserver loop completed · HTTP 499
            </div>
          </div>

          {/* Center Arrow Medallion */}
          <div
            aria-hidden="true"
            className="shrink-0 mx-auto w-[68px] h-[68px] rounded-full border-2 border-[#0B0B0C] bg-[#2B3BFF] text-white flex items-center justify-center shadow-[4px_4px_0_#0B0B0C]"
          >
            <ArrowRight className="w-7 h-7 stroke-[2.4] rotate-90 lg:rotate-0" />
          </div>

          {/* Right: Tactile Calm Inbox / Window Briefing Card */}
          <div className="flex-[1.15] basis-[380px] min-w-0 bg-white text-[#0B0B0C] border-2 border-[#0B0B0C] shadow-[8px_8px_0_#0B0B0C] rounded-[24px] p-5 sm:p-7 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5">
              <div className="flex items-baseline gap-2.5">
                <span className="font-editorial font-extrabold text-[26px] tracking-[-0.025em]">
                  {heroMode === 'inbox' ? 'Inbox' : 'Briefing'}
                </span>
                <span className="font-mono text-[12px] text-[#4B4D52]">
                  {heroMode === 'inbox' ? '3 items, routed' : 'Decisions API · 0 tokens'}
                </span>
              </div>

              <div
                role="tablist"
                aria-label="Preview mode"
                className="inline-flex p-0.5 rounded-full border-[1.5px] border-[#0B0B0C] bg-[#F2F3F5] text-[12px] font-mono font-semibold"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={heroMode === 'inbox'}
                  onClick={() => setHeroMode('inbox')}
                  className={`px-3 py-1 rounded-full transition-colors ${
                    heroMode === 'inbox'
                      ? 'bg-[#0B0B0C] text-white'
                      : 'text-[#3A3B40] hover:text-[#0B0B0C]'
                  }`}
                >
                  Inbox
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={heroMode === 'briefing'}
                  data-testid="landing-preview-briefing-tab"
                  onClick={() => setHeroMode('briefing')}
                  className={`px-3 py-1 rounded-full transition-colors ${
                    heroMode === 'briefing'
                      ? 'bg-[#2B3BFF] text-white'
                      : 'text-[#3A3B40] hover:text-[#0B0B0C]'
                  }`}
                >
                  Window briefing
                </button>
              </div>
            </div>

            {heroMode === 'inbox' ? (
              <>
                {/* Item 1 — Page Eng (Electric Cobalt) */}
                <div className="flex gap-3.5 items-start p-4 rounded-[14px] bg-[#2B3BFF] text-white">
                  <span className="font-editorial font-extrabold text-[28px] leading-none">1</span>
                  <div className="min-w-0 flex flex-col gap-2">
                    <div className="font-semibold text-[16px] leading-[1.3]">
                      EU payment gateway 504 timeout
                    </div>
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                      <span className="px-2.5 py-1 rounded-full bg-white text-[#0B0B0C] font-semibold">
                        Page Eng · 96%
                      </span>
                      <span className="px-2.5 py-1 rounded-full border border-white/80">
                        ×3 merged
                      </span>
                      <span className="px-2.5 py-1 rounded-full border border-white/80">
                        Slack + Webhook
                      </span>
                    </div>
                  </div>
                </div>

                {/* Item 2 — Notify Ops (Auto-Frozen Card, Scrubbed) */}
                <div className="flex gap-3.5 items-start p-4 rounded-[14px] bg-[#F2F3F5]">
                  <span className="font-editorial font-extrabold text-[28px] leading-none">2</span>
                  <div className="min-w-0 flex flex-col gap-2">
                    <div className="font-semibold text-[16px] leading-[1.45] break-words">
                      Virtual card auto-frozen for{' '}
                      <span className="font-mono text-[12px] bg-[#0B0B0C] text-white px-1.5 py-0.5 rounded">
                        [EMAIL]
                      </span>
                      , card{' '}
                      <span className="font-mono text-[12px] bg-[#0B0B0C] text-white px-1.5 py-0.5 rounded">
                        [CARD]
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                      <span className="px-2.5 py-1 rounded-full bg-[#0B0B0C] text-white font-semibold">
                        Notify Ops · 94%
                      </span>
                      <span className="px-2.5 py-1 rounded-full border border-[#0B0B0C]">
                        Scrubbed on device
                      </span>
                      <span className="px-2.5 py-1 rounded-full border border-[#0B0B0C]/40 text-[#3A3B40]">
                        No eng page (0.19)
                      </span>
                    </div>
                  </div>
                </div>

                {/* Item 3 — Ignored False Alarm Comparison */}
                <div className="flex gap-3.5 items-start p-4 rounded-[14px] bg-[#F2F3F5] text-[#4B4D52]">
                  <span className="font-editorial font-extrabold text-[28px] leading-none">3</span>
                  <div className="min-w-0 flex flex-col gap-2">
                    <div className="font-medium text-[15px] leading-[1.3]">
                      Paystack AdPay top-up credited (₦1,129,000 paid)
                    </div>
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                      <span className="px-2.5 py-1 rounded-full border border-[#4B4D52]">
                        Ignored · 0.99 routine
                      </span>
                      <span className="px-2.5 py-1 rounded-full border border-[#4B4D52]/50">
                        False alarm avoided
                      </span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-[14px] bg-[#F2F3F5] p-4 space-y-3 text-[13px] leading-[1.55] text-[#0B0B0C]">
                <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-[#2B3BFF] font-bold uppercase tracking-wider">
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    Proactive Window Briefing
                  </span>
                  <span className="text-[#4B4D52] normal-case font-normal">10:00–14:00 CAT</span>
                </div>
                <p className="text-[#3A3B40]">
                  Every message in this Sunday window came from a bot. No manual money moves were
                  flagged and no engineering pages fired.
                </p>
                <div className="rounded-xl bg-white border-[1.5px] border-[#0B0B0C] p-3 space-y-1.5">
                  <p className="font-semibold">
                    #virtual-cards, 10:52 CAT (bot).{' '}
                    <span className="font-normal text-[#3A3B40]">
                      Card auto-frozen after repeated declines. Nobody responded in Slack.
                    </span>
                  </p>
                  <p className="font-mono text-[11px] text-[#3A3B40]">
                    &ldquo;Customer blocked?&rdquo; <strong>0.94</strong> · &ldquo;Routine?&rdquo;{' '}
                    <strong>0.11</strong> →{' '}
                    <span className="px-1.5 py-0.5 rounded bg-[#2B3BFF] text-white font-semibold">
                      notify_ops
                    </span>{' '}
                    (eng 0.19)
                  </p>
                </div>
                <div className="rounded-xl bg-white/80 border border-[#0B0B0C]/30 p-3 space-y-1">
                  <p className="font-semibold text-[#3A3B40]">
                    #wallet-funding, 11:17 CAT (bot), for comparison.{' '}
                    <span className="font-normal">Paystack top-up credited.</span>
                  </p>
                  <p className="font-mono text-[11px] text-[#4B4D52]">
                    &ldquo;Routine?&rdquo; <strong>0.99</strong> · &ldquo;Manual move?&rdquo;{' '}
                    <strong>0.02</strong> → <span className="font-semibold">ignore</span> (stays quiet)
                  </p>
                </div>
                <p className="font-mono text-[11px] text-[#4B4D52]">
                  Each check took 187 ms–546 ms (0 output tokens). Nothing was posted in Slack.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* BOLD CORAL MARQUEE NOISE TICKER */}
      <div
        aria-hidden="true"
        className="bg-[#FF5B37] text-[#0B0B0C] overflow-hidden border-y-2 border-[#0B0B0C]"
      >
        <div className="cd-marquee flex w-max font-mono font-bold text-[14px] tracking-[0.04em] uppercase whitespace-nowrap py-4">
          <span className="pr-10">
            checkout-api 504 timeout &nbsp;×&nbsp; virtual card auto-frozen &nbsp;×&nbsp; paystack
            top-up credited &nbsp;×&nbsp; resizeobserver loop &nbsp;×&nbsp; kyb verification
            overdue &nbsp;×&nbsp; http 499 client closed &nbsp;×&nbsp; nightly-agent finished ok
            &nbsp;×&nbsp;
          </span>
          <span className="pr-10">
            checkout-api 504 timeout &nbsp;×&nbsp; virtual card auto-frozen &nbsp;×&nbsp; paystack
            top-up credited &nbsp;×&nbsp; resizeobserver loop &nbsp;×&nbsp; kyb verification
            overdue &nbsp;×&nbsp; http 499 client closed &nbsp;×&nbsp; nightly-agent finished ok
            &nbsp;×&nbsp;
          </span>
        </div>
      </div>

      {/* FEATURES BENTO GRID */}
      <section id="features" className="py-16 sm:py-24 lg:py-28 px-5 sm:px-10 lg:px-20">
        <div className="max-w-[1280px] mx-auto flex flex-col gap-10 sm:gap-14">
          <h2 className="m-0 max-w-[960px] font-editorial font-extrabold text-[clamp(36px,5.4vw,80px)] leading-[0.98] tracking-[-0.04em]">
            Your bots talk too much. CalmDuty edits them down.
          </h2>

          <div className="flex flex-col gap-5">
            {/* Row 1: 0 Output Tokens + On-Device Privacy Shield */}
            <div className="flex flex-wrap gap-5">
              {/* Electric Cobalt 0-Token Card */}
              <div className="flex-1 basis-[340px] min-w-0 bg-[#2B3BFF] text-white rounded-[28px] p-7 sm:p-10 flex flex-col justify-between gap-6 min-h-[410px]">
                <div className="flex items-center justify-between gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.08em]">
                  <span>6-Signal Routing</span>
                  <span className="opacity-80">gemini-decision-1</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-editorial font-extrabold text-[clamp(150px,19vw,260px)] leading-[0.78] tracking-[-0.06em]">
                    0
                  </span>
                  <span className="font-editorial font-extrabold text-[clamp(28px,3vw,40px)] leading-none tracking-[-0.03em] mt-2">
                    output tokens
                  </span>
                  <p className="mt-3 max-w-[420px] text-[16px] sm:text-[17px] leading-[1.5] text-white/90">
                    Duplicates merge and six parallel checks route{' '}
                    <code className="font-mono text-[14px] bg-white/15 px-1.5 py-0.5 rounded">
                      page_eng
                    </code>
                    ,{' '}
                    <code className="font-mono text-[14px] bg-white/15 px-1.5 py-0.5 rounded">
                      notify_ops
                    </code>
                    , or{' '}
                    <code className="font-mono text-[14px] bg-white/15 px-1.5 py-0.5 rounded">
                      ignore
                    </code>{' '}
                    in ~200 ms without burning generative tokens.
                  </p>
                </div>
              </div>

              {/* Periwinkle On-Device Privacy Card */}
              <div className="flex-[1.3] basis-[420px] min-w-0 bg-[#E6EAFF] text-[#0B0B0C] rounded-[28px] p-7 sm:p-10 flex flex-col justify-between gap-7 min-h-[410px]">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.08em]">
                    <span>Zero Data Retention</span>
                    <span className="text-[#2B3BFF]">store: false · AES-256-GCM</span>
                  </div>
                  <h3 className="m-0 font-editorial font-extrabold text-[clamp(30px,3.4vw,48px)] leading-none tracking-[-0.035em]">
                    PII gets scrubbed on your device.
                  </h3>
                </div>

                <div className="flex flex-col gap-2.5 font-mono text-[13px] sm:text-[14px] leading-[1.7] break-words">
                  <div className="p-4 rounded-[14px] border-2 border-dashed border-[#0B0B0C] bg-white">
                    <span className="block text-[11px] font-bold uppercase tracking-[0.08em] text-[#4B4D52] mb-1">
                      What the bot sent (never leaves device)
                    </span>
                    Card frozen for{' '}
                    <span className="bg-[#FF5B37] text-[#0B0B0C] px-1.5 py-0.5 rounded font-semibold">
                      maya.chen@northstar-demo.io
                    </span>{' '}
                    · card{' '}
                    <span className="bg-[#FF5B37] text-[#0B0B0C] px-1.5 py-0.5 rounded font-semibold">
                      4532 8910 4421 9004
                    </span>{' '}
                    · phone{' '}
                    <span className="bg-[#FF5B37] text-[#0B0B0C] px-1.5 py-0.5 rounded font-semibold">
                      +1 415 555 0134
                    </span>
                  </div>
                  <div className="p-4 rounded-[14px] border-2 border-[#0B0B0C] bg-white">
                    <span className="block text-[11px] font-bold uppercase tracking-[0.08em] text-[#2B3BFF] mb-1">
                      What reaches triage &amp; cloud AI
                    </span>
                    Card frozen for{' '}
                    <span className="bg-[#0B0B0C] text-white px-1.5 py-0.5 rounded">
                      [Protected Email]
                    </span>{' '}
                    · card{' '}
                    <span className="bg-[#0B0B0C] text-white px-1.5 py-0.5 rounded">
                      [Protected Card]
                    </span>{' '}
                    · phone{' '}
                    <span className="bg-[#0B0B0C] text-white px-1.5 py-0.5 rounded">
                      [Protected Phone]
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: Offline + Web + Android */}
            <div className="flex flex-wrap gap-5">
              {/* Coral Offline Card */}
              <div className="flex-[1.2] basis-[300px] min-w-0 bg-[#FF5B37] text-[#0B0B0C] rounded-[28px] p-7 sm:p-9 flex flex-col justify-between gap-8 min-h-[290px]">
                <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em]">
                  Offline · Gemini Nano
                </span>
                <div className="flex flex-col gap-3">
                  <h3 className="m-0 font-editorial font-extrabold text-[clamp(30px,3.2vw,46px)] leading-none tracking-[-0.035em]">
                    No signal? Still an inbox.
                  </h3>
                  <p className="m-0 text-[16px] sm:text-[17px] leading-[1.5]">
                    Firebase AI Logic <code className="font-mono text-[13px] bg-black/10 px-1.5 py-0.5 rounded">PREFER_ON_DEVICE</code> keeps PII scrubbing, triage, and customer replies running offline.
                  </p>
                </div>
              </div>

              {/* White Web Card */}
              <div className="flex-1 basis-[260px] min-w-0 bg-white text-[#0B0B0C] rounded-[28px] p-7 sm:p-9 flex flex-col items-start justify-between gap-8 min-h-[290px]">
                <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-[#4B4D52]">
                  Web App
                </span>
                <div className="flex flex-col items-start gap-4">
                  <h3 className="m-0 font-editorial font-extrabold text-[clamp(30px,3.2vw,46px)] leading-none tracking-[-0.035em]">
                    In your browser.
                  </h3>
                  <button
                    type="button"
                    onClick={onLaunchSandbox}
                    className="inline-flex items-center gap-2 min-h-[48px] px-5 rounded-full bg-[#0B0B0C] hover:bg-[#2B3BFF] text-white text-[15px] font-semibold transition-colors"
                  >
                    <span>Try Live Sandbox</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* White Android Card */}
              <div className="flex-1 basis-[260px] min-w-0 bg-white text-[#0B0B0C] rounded-[28px] p-7 sm:p-9 flex flex-col items-start justify-between gap-8 min-h-[290px]">
                <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-[#4B4D52]">
                  Android · v0.1.0 (29 MB)
                </span>
                <div className="flex flex-col items-start gap-4">
                  <h3 className="m-0 font-editorial font-extrabold text-[clamp(30px,3.2vw,46px)] leading-none tracking-[-0.035em]">
                    In your pocket.
                  </h3>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <a
                      href={ANDROID_APK_DOWNLOAD_URL}
                      download="calmduty-v0.1.0-android.apk"
                      data-testid="landing-bento-apk-btn"
                      className="inline-flex items-center gap-2 min-h-[48px] px-5 rounded-full border-2 border-[#0B0B0C] hover:bg-[#0B0B0C] hover:text-white text-[#0B0B0C] text-[15px] font-semibold transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download APK</span>
                    </a>
                    <a
                      href={ANDROID_SHA256_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[12px] text-[#4B4D52] hover:text-[#2B3BFF] underline underline-offset-4"
                    >
                      SHA-256
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* THREE STEPS TO QUIET */}
      <section id="how" className="bg-white text-[#0B0B0C] py-16 sm:py-24 lg:py-28 px-5 sm:px-10 lg:px-20">
        <div className="max-w-[1280px] mx-auto flex flex-col gap-10 sm:gap-14">
          <h2 className="m-0 font-editorial font-extrabold text-[clamp(36px,5.4vw,80px)] leading-[0.98] tracking-[-0.04em]">
            Three steps to quiet.
          </h2>

          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-x-10 gap-y-3 py-7 sm:py-10 border-t-2 border-[#0B0B0C]">
              <span className="shrink-0 min-w-[110px] sm:min-w-[200px] font-editorial font-extrabold text-[clamp(72px,10.5vw,148px)] leading-[0.8] tracking-[-0.05em] text-[#2B3BFF]">
                01
              </span>
              <h3 className="flex-1 basis-[200px] m-0 font-editorial font-extrabold text-[clamp(32px,4.2vw,60px)] leading-none tracking-[-0.035em]">
                Collect
              </h3>
              <p className="flex-[1.4] basis-[300px] m-0 text-[17px] sm:text-[18px] leading-[1.55] text-[#3A3B40]">
                Connect Slack (read-only scopes only), signed webhooks, and deferred MCP or OpenAPI
                tools. Nothing posts back to your channels without your explicit click.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-10 gap-y-3 py-7 sm:py-10 border-t-2 border-[#0B0B0C]">
              <span className="shrink-0 min-w-[110px] sm:min-w-[200px] font-editorial font-extrabold text-[clamp(72px,10.5vw,148px)] leading-[0.8] tracking-[-0.05em] text-[#2B3BFF]">
                02
              </span>
              <h3 className="flex-1 basis-[200px] m-0 font-editorial font-extrabold text-[clamp(32px,4.2vw,60px)] leading-none tracking-[-0.035em]">
                Scrub
              </h3>
              <p className="flex-[1.4] basis-[300px] m-0 text-[17px] sm:text-[18px] leading-[1.55] text-[#3A3B40]">
                Raw customer emails, phone numbers, card digits, and account IDs are redacted on
                your device first—so you see what broke without leaking who it happened to.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-10 gap-y-3 py-7 sm:py-10 border-y-2 border-[#0B0B0C]">
              <span className="shrink-0 min-w-[110px] sm:min-w-[200px] font-editorial font-extrabold text-[clamp(72px,10.5vw,148px)] leading-[0.8] tracking-[-0.05em] text-[#2B3BFF]">
                03
              </span>
              <h3 className="flex-1 basis-[200px] m-0 font-editorial font-extrabold text-[clamp(32px,4.2vw,60px)] leading-none tracking-[-0.035em]">
                Route
              </h3>
              <p className="flex-[1.4] basis-[300px] m-0 text-[17px] sm:text-[18px] leading-[1.55] text-[#3A3B40]">
                Duplicates collapse into ×N threads, 6 parallel Decisions API checks route{' '}
                <code className="font-mono text-[15px] bg-[#F2F3F5] px-1.5 py-0.5 rounded">
                  page_eng
                </code>{' '}
                vs{' '}
                <code className="font-mono text-[15px] bg-[#F2F3F5] px-1.5 py-0.5 rounded">
                  notify_ops
                </code>{' '}
                at 0 output tokens, and Copilot writes a calm window briefing.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SELF-HOST & INSTALL QUICKSTART */}
      <section id="docs" className="bg-[#F2F3F5] text-[#0B0B0C] py-16 sm:py-24 px-5 sm:px-10 lg:px-20">
        <div className="max-w-[1280px] mx-auto flex flex-col gap-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-[#2B3BFF]">
                Open Source · MIT Licensed
              </span>
              <h2 className="m-0 font-editorial font-extrabold text-[clamp(32px,4.4vw,60px)] leading-[0.98] tracking-[-0.04em]">
                Run it hosted, in Docker, or on your phone.
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-3 font-mono text-[13px]">
              <a
                href={`${WEB_REPO_URL}/blob/main/docs/QUICKSTART.md`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border-[1.5px] border-[#0B0B0C] bg-white hover:bg-[#0B0B0C] hover:text-white transition-colors"
              >
                <span>Quickstart</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href={`${WEB_REPO_URL}/blob/main/docs/SECURITY.md`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border-[1.5px] border-[#0B0B0C] bg-white hover:bg-[#0B0B0C] hover:text-white transition-colors"
              >
                <span>Security &amp; Zero-Retention</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <a
                href={ANDROID_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border-[1.5px] border-[#0B0B0C] bg-white hover:bg-[#0B0B0C] hover:text-white transition-colors"
              >
                <span>Android Repo</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          <div className="bg-white border-2 border-[#0B0B0C] shadow-[8px_8px_0_#0B0B0C] rounded-[24px] p-5 sm:p-8 flex flex-col gap-5">
            {/* Tabs */}
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Deployment options">
              {(Object.keys(SETUP_TABS) as SetupTab[]).map((key) => {
                const selected = setupTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setSetupTab(key)}
                    className={`px-4 py-2 rounded-full font-mono text-[13px] font-semibold border-[1.5px] transition-colors ${
                      selected
                        ? 'bg-[#0B0B0C] text-white border-[#0B0B0C]'
                        : 'bg-[#F2F3F5] text-[#3A3B40] border-transparent hover:border-[#0B0B0C]'
                    }`}
                  >
                    {SETUP_TABS[key].label}
                  </button>
                );
              })}
            </div>

            {/* Command / Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 rounded-[14px] bg-[#F2F3F5] border-[1.5px] border-[#0B0B0C]">
              <div className="flex items-center gap-2.5 min-w-0 flex-1 font-mono text-[13px] text-[#0B0B0C] break-all">
                <Terminal className="w-4 h-4 text-[#2B3BFF] shrink-0" />
                <span>{activeSetup.command}</span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {activeSetup.action === 'sandbox' ? (
                  <button
                    type="button"
                    onClick={onLaunchSandbox}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2B3BFF] hover:bg-[#1E2CE6] text-white text-[13px] font-semibold transition-colors whitespace-nowrap"
                  >
                    <span>Launch Sandbox</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                ) : activeSetup.action === 'cloudrun' ? (
                  <a
                    href={CLOUD_RUN_DEPLOY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2B3BFF] hover:bg-[#1E2CE6] text-white text-[13px] font-semibold transition-colors whitespace-nowrap"
                  >
                    <span>Deploy on Cloud Run</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : activeSetup.action === 'apk' ? (
                  <a
                    href={ANDROID_APK_DOWNLOAD_URL}
                    download="calmduty-v0.1.0-android.apk"
                    data-testid="landing-setup-apk-btn"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2B3BFF] hover:bg-[#1E2CE6] text-white text-[13px] font-semibold transition-colors whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download APK (29 MB)</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleCopy(setupTab, activeSetup.command)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#0B0B0C] hover:bg-[#2B3BFF] text-white text-[13px] font-semibold transition-colors whitespace-nowrap"
                  >
                    {copiedKey === setupTab ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy command</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            <p className="m-0 text-[15px] leading-[1.55] text-[#3A3B40]">{activeSetup.caption}</p>
          </div>
        </div>
      </section>

      {/* MONUMENTAL FINAL CTA */}
      <section className="bg-[#2B3BFF] text-white py-16 sm:py-28 px-5 sm:px-10 lg:px-20">
        <div className="max-w-[1280px] mx-auto flex flex-col items-start gap-8 sm:gap-11">
          <h2 className="m-0 font-editorial font-extrabold text-[clamp(44px,8.6vw,128px)] leading-[0.92] tracking-[-0.045em]">
            Take the noise out of on-call.
          </h2>
          <div className="flex flex-wrap items-center gap-3.5">
            <button
              type="button"
              onClick={onLaunchSandbox}
              className="inline-flex items-center gap-3 min-h-[64px] px-8 rounded-full bg-white hover:bg-[#F2F3F5] text-[#0B0B0C] text-[18px] sm:text-[20px] font-semibold transition-colors whitespace-nowrap"
            >
              <span>Open CalmDuty</span>
              <ArrowRight className="w-5 h-5" />
            </button>
            <a
              href={ANDROID_APK_DOWNLOAD_URL}
              download="calmduty-v0.1.0-android.apk"
              data-testid="landing-cta-apk-btn"
              className="inline-flex items-center gap-2.5 min-h-[64px] px-7 rounded-full border-2 border-white/80 hover:bg-white hover:text-[#0B0B0C] text-white text-[17px] font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>Download Android APK</span>
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-[#F2F3F5] text-[#3A3B40] border-t-2 border-[#0B0B0C] py-7 px-5 sm:px-10 lg:px-20">
        <div className="max-w-[1280px] mx-auto flex flex-wrap items-center justify-between gap-x-8 gap-y-2 text-[14px]">
          <span className="font-editorial font-extrabold text-[18px] text-[#0B0B0C] inline-flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#2B3BFF]" aria-hidden="true" />
            CalmDuty
          </span>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-1">
            <a href="#features" className="inline-flex items-center min-h-[40px] hover:text-[#0B0B0C]">
              Features
            </a>
            <a href="#how" className="inline-flex items-center min-h-[40px] hover:text-[#0B0B0C]">
              How it works
            </a>
            <a href="#docs" className="inline-flex items-center min-h-[40px] hover:text-[#0B0B0C]">
              Self-host
            </a>
            <a
              href={ANDROID_APK_DOWNLOAD_URL}
              download="calmduty-v0.1.0-android.apk"
              className="inline-flex items-center min-h-[40px] hover:text-[#2B3BFF]"
            >
              Android APK
            </a>
            <a
              href={WEB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center min-h-[40px] hover:text-[#0B0B0C]"
            >
              GitHub
            </a>
          </nav>
          <span>MIT Open Source · © 2026 CalmDuty</span>
        </div>
      </footer>
    </div>
  );
}

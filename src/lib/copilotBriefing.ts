import { formatLatencyDuration, inferDecisionRoute } from './decisions.ts';
import { scrubPiiLocally } from './privacyShield.ts';
import { formatLocalClockTime, formatSlackText } from './slackSync.ts';
import type { IncidentGroup } from './incidentGroups.ts';
import type { DecisionRoute, IncidentBucket } from '../types/edgeops.ts';

export interface WorkspaceThreadSummary {
  groupKey: string;
  latestId: string;
  title: string;
  channel: string;
  count: number;
  bucket: IncidentBucket;
  route: DecisionRoute | null;
  priorityScore: number | null;
  needsAction: number | null;
  customerBlocked: number | null;
  isNoise: number | null;
  revenueRisk: number | null;
  manualMoneyMove: number | null;
  needsEngineering: number | null;
  latencyMs: number | null;
  isBot: boolean;
  replyCount: number;
  unanswered: boolean;
  createdAtIso: string;
  timestampLabel: string;
  scrubbedSummary: string;
  resolved: boolean;
}

export interface ProactiveThreadRef {
  groupKey: string;
  latestId: string;
  title: string;
  channel: string;
  count: number;
  priorityScore: number | null;
  revenueRisk: number | null;
  route?: DecisionRoute | null;
  isUrgent: boolean;
  isSpike: boolean;
}

export interface ProactiveBriefingPayload {
  signature: string;
  headline: string;
  body: string;
  urgentCount: number;
  spikeCount: number;
  notifyOpsCount: number;
  pageEngCount: number;
  referencedThreads: ProactiveThreadRef[];
}

function toPct(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? Math.round(val * 100) : null;
}

function fmtProb(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '0.00';
  return (Math.max(0, Math.min(100, pct)) / 100).toFixed(2);
}

/**
 * Builds a strictly PII-scrubbed summary list of all grouped workspace threads
 * for the Global Proactive Copilot, `/api/briefing`, and workspace-wide `/api/chat` context.
 */
export function buildWorkspaceThreadSummaries(
  groups: IncidentGroup[],
  maxThreads = 30
): WorkspaceThreadSummary[] {
  return groups.slice(0, maxThreads).map((group) => {
    const cleanTitle = (formatSlackText(group.latest.title) || group.latest.title)
      .replace(/\n+/g, ' ')
      .trim();
    const safeTitle = scrubPiiLocally(cleanTitle).scrubbedText.slice(0, 140);

    const cleanBody = (
      formatSlackText(group.latest.scrubbedSummary || group.latest.rawPayload) ||
      group.latest.scrubbedSummary ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const safeSummary = scrubPiiLocally(cleanBody).scrubbedText.slice(0, 320);
    const scores = group.decisionScores ?? group.latest.decisionScores;
    const route = inferDecisionRoute(scores);
    const replyCount =
      typeof group.latest.replyCount === 'number' && Number.isFinite(group.latest.replyCount)
        ? Math.max(0, Math.floor(group.latest.replyCount))
        : 0;
    const isBot = Boolean(group.latest.isBot);

    return {
      groupKey: group.groupKey,
      latestId: group.latest.id,
      title: safeTitle,
      channel: group.latest.channel,
      count: group.count,
      bucket: group.bucket,
      route,
      priorityScore:
        typeof group.priorityScore === 'number' && Number.isFinite(group.priorityScore)
          ? Math.round(group.priorityScore)
          : null,
      needsAction: toPct(scores?.needsAction),
      customerBlocked: toPct(scores?.customerBlocked),
      isNoise: toPct(scores?.isNoise),
      revenueRisk: toPct(scores?.revenueRisk),
      manualMoneyMove: toPct(scores?.manualMoneyMove),
      needsEngineering: toPct(scores?.needsEngineering),
      latencyMs:
        typeof scores?.latencyMs === 'number' && Number.isFinite(scores.latencyMs)
          ? Math.round(scores.latencyMs)
          : null,
      isBot,
      replyCount,
      unanswered: replyCount === 0,
      createdAtIso: group.latest.createdAtIso,
      timestampLabel: group.latest.timestampLabel,
      scrubbedSummary: safeSummary,
      resolved: group.occurrences.every((occ) => occ.status === 'resolved'),
    };
  });
}

export function computeWindowMetadata(
  threads: WorkspaceThreadSummary[],
  timeZone?: string
): {
  windowLabel: string;
  weekday: string;
  allBots: boolean;
  anyManualMoneyMove: boolean;
  anyEngEscalation: boolean;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
} {
  const validMs = threads
    .map((t) => Date.parse(t.createdAtIso))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  const nowIso = new Date().toISOString();
  const earliestIso = validMs.length > 0 ? new Date(validMs[0]).toISOString() : nowIso;
  const latestIso = validMs.length > 0 ? new Date(validMs[validMs.length - 1]).toISOString() : nowIso;

  const startClock = formatLocalClockTime(earliestIso, timeZone);
  const endClock = formatLocalClockTime(latestIso, timeZone);
  const windowLabel =
    startClock.hhmm === endClock.hhmm
      ? endClock.label
      : `${startClock.hhmm}–${endClock.hhmm} ${endClock.tzShort}`.trim();

  const latencies = threads
    .map((t) => t.latencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);

  return {
    windowLabel,
    weekday: endClock.weekday,
    allBots: threads.length > 0 && threads.every((t) => t.isBot),
    anyManualMoneyMove: threads.some((t) => (t.manualMoneyMove ?? 0) >= 65),
    anyEngEscalation: threads.some((t) => t.route === 'page_eng'),
    minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
  };
}

/**
 * Picks the single most informative `ignore` thread for comparison (preferring monetary/payment
 * confirmations so the briefing clearly explains which false alarm was avoided).
 */
export function pickComparisonIgnoredThread(
  threads: WorkspaceThreadSummary[]
): WorkspaceThreadSummary | null {
  const ignored = threads.filter((t) => t.route === 'ignore' || t.bucket === 'hidden_noise');
  if (ignored.length === 0) return null;

  const monetaryRegex = /(₦|\$|€|£|ngn|usd|top-?up|credit|funded|paystack|payment|wallet|payout)/i;
  const scored = [...ignored].sort((a, b) => {
    const aMon = monetaryRegex.test(`${a.title} ${a.scrubbedSummary}`) ? 1 : 0;
    const bMon = monetaryRegex.test(`${b.title} ${b.scrubbedSummary}`) ? 1 : 0;
    if (bMon !== aMon) return bMon - aMon;
    return (b.isNoise ?? 0) - (a.isNoise ?? 0);
  });
  return scored[0] ?? null;
}

/**
 * Deterministic, strictly PII-scrubbed executive window briefing matching the Decisions API format.
 * Used for instant 0ms rendering, offline mode, and server fallback if Gemini Flash-Lite is unreachable.
 */
export function buildExecutiveBriefingFallback(
  summaries: WorkspaceThreadSummary[],
  options: { workspaceName?: string; timeZone?: string } = {}
): { headline: string; body: string } {
  const workspace = options.workspaceName?.trim() || 'Slack';
  const meta = computeWindowMetadata(summaries, options.timeZone);
  const headline = `Decisions API: what stood out in ${workspace} (${meta.windowLabel})`;

  const active = summaries.filter(
    (t) => !t.resolved && (t.route === 'page_eng' || t.route === 'notify_ops' || t.bucket === 'needs_action')
  );
  const comparison = pickComparisonIgnoredThread(summaries);

  const lines: string[] = [`**${headline}**`, ''];

  // Opening 1-sentence calm summary
  const overviewParts: string[] = [];
  if (meta.allBots) {
    overviewParts.push(
      meta.weekday
        ? `It's ${meta.weekday}, so every message in this window came from a bot.`
        : 'Every message in this window came from a bot.'
    );
  } else {
    overviewParts.push(`Reviewed ${summaries.length} scrubbed ${summaries.length === 1 ? 'thread' : 'threads'} in this window.`);
  }
  const quietNotes: string[] = [];
  if (!meta.anyManualMoneyMove) quietNotes.push('there were no manual money moves');
  if (!meta.anyEngEscalation) quietNotes.push('no engineering pages fired');
  if (quietNotes.length > 0) {
    overviewParts.push(
      quietNotes.length === 2
        ? `No manual money moves were flagged and no engineering pages fired.`
        : `${quietNotes[0][0].toUpperCase()}${quietNotes[0].slice(1)}.`
    );
  }
  lines.push(overviewParts.join(' '), '');

  if (active.length === 0) {
    lines.push(
      'Nothing needed human intervention — every synced message in this window stayed below action thresholds.'
    );
    lines.push('');
  } else {
    for (const thread of active.slice(0, 3)) {
      const clock = formatLocalClockTime(thread.createdAtIso, options.timeZone);
      const actorTag = thread.isBot ? ' (bot)' : '';
      const replyNote = thread.unanswered
        ? ' Nobody responded in Slack.'
        : ` ${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'} in thread.`;
      const routeLabel = thread.route || 'notify_ops';
      const repeatNote = thread.count > 1 ? ` (×${thread.count} grouped alerts)` : '';

      lines.push(
        `**${thread.channel}, ${clock.label}${actorTag}.** ${thread.title}${repeatNote}.${replyNote}`
      );

      // Questions bullet
      const qParts: string[] = [];
      if ((thread.customerBlocked ?? 0) >= 50) {
        qParts.push(`"Is a customer blocked right now?" got ${fmtProb(thread.customerBlocked)}.`);
      }
      if ((thread.manualMoneyMove ?? 0) >= 50) {
        qParts.push(`"Is this a manual money move?" got ${fmtProb(thread.manualMoneyMove)}.`);
      }
      if (thread.needsAction !== null) {
        qParts.push(`"Does a human need to act now?" got ${fmtProb(thread.needsAction)}.`);
      }
      if (thread.isNoise !== null) {
        qParts.push(`"Is this routine?" got ${fmtProb(thread.isNoise)}.`);
      }
      lines.push(
        `- **Questions:** ${qParts.join(' ')} The route came back as \`${routeLabel}\`.`
      );

      // What the code does bullet
      const engProb = fmtProb(thread.needsEngineering);
      if (routeLabel === 'page_eng') {
        lines.push(
          `- **What the code does:** pages engineering (\`needs_engineering\` ${engProb}) with the scrubbed context so the team can inspect backend logs and remediate immediately.`
        );
      } else if ((thread.customerBlocked ?? 0) >= 70) {
        lines.push(
          `- **What the code does:** because of the strong customer-blocked score (${fmtProb(thread.customerBlocked)}), it routes to support/ops to unblock the customer. It doesn't page engineering (${engProb}).`
        );
      } else if ((thread.manualMoneyMove ?? 0) >= 65) {
        lines.push(
          `- **What the code does:** routes to finance/ops for manual money-move verification (${fmtProb(thread.manualMoneyMove)}) without paging engineering (${engProb}).`
        );
      } else {
        lines.push(
          `- **What the code does:** routes to support/ops for follow-up and keeps engineering quiet (${engProb}).`
        );
      }
      lines.push('');
    }
  }

  if (comparison) {
    const clock = formatLocalClockTime(comparison.createdAtIso, options.timeZone);
    const actorTag = comparison.isBot ? ' (bot)' : '';
    lines.push(
      `**${comparison.channel}, ${clock.label}${actorTag}, included for comparison.** ${comparison.title}.`
    );
    const qParts: string[] = [];
    if (comparison.isNoise !== null) {
      qParts.push(`"Is this routine?" got ${fmtProb(comparison.isNoise)}.`);
    }
    if (comparison.needsAction !== null) {
      qParts.push(`"Does a human need to act now?" got ${fmtProb(comparison.needsAction)}.`);
    }
    if (comparison.manualMoneyMove !== null) {
      qParts.push(`"Is this a manual money move?" got ${fmtProb(comparison.manualMoneyMove)}.`);
    }
    lines.push(
      `- **Questions:** ${qParts.length > 0 ? `${qParts.join(' ')} ` : ''}The route came back as \`ignore\`.`
    );
    lines.push(
      '- **What the code does:** stay quiet. Routine telemetry or automated top-ups alone do not alert anyone, avoiding false alarms.'
    );
    lines.push('');
  }

  if (meta.minLatencyMs !== null && meta.maxLatencyMs !== null) {
    const rangeStr =
      meta.minLatencyMs === meta.maxLatencyMs
        ? formatLatencyDuration(meta.minLatencyMs)
        : `${formatLatencyDuration(meta.minLatencyMs)} to ${formatLatencyDuration(meta.maxLatencyMs)}`;
    lines.push(`Each check took about ${rangeStr} (0 output tokens). Nothing was posted in Slack.`);
  } else {
    lines.push('Scored at 0 output tokens. Nothing was posted in Slack.');
  }

  return { headline, body: lines.join('\n') };
}

/**
 * Detects whether newly synced workspace threads contain urgent alerts (`priorityScore >= 90`),
 * repeated grouped spikes (`count >= 2`), or active `page_eng` / `notify_ops` routed items
 * that warrant a proactive Copilot briefing.
 * Returns `null` if nothing actionable is active or if the signature matches `previousSignature`.
 */
export function detectProactiveBriefing(
  groups: IncidentGroup[],
  previousSignature: string | null = null,
  options: { workspaceName?: string; timeZone?: string } = {}
): ProactiveBriefingPayload | null {
  const summaries = buildWorkspaceThreadSummaries(groups, 40);
  const active = summaries.filter((t) => !t.resolved && t.bucket === 'needs_action');

  const urgentThreads = active.filter((t) => (t.priorityScore ?? 0) >= 90);
  const spikeThreads = active.filter((t) => t.count >= 2);
  const routedThreads = active.filter((t) => t.route === 'page_eng' || t.route === 'notify_ops');
  const notifyOpsCount = active.filter((t) => t.route === 'notify_ops').length;
  const pageEngCount = active.filter((t) => t.route === 'page_eng').length;

  if (urgentThreads.length === 0 && spikeThreads.length === 0 && routedThreads.length === 0) {
    return null;
  }

  // Combine unique priority threads (page_eng / urgent first, then customer-blocked / notify_ops, then spikes)
  const byKey = new Map<string, WorkspaceThreadSummary>();
  for (const t of [...urgentThreads, ...routedThreads, ...spikeThreads]) {
    if (!byKey.has(t.groupKey)) {
      byKey.set(t.groupKey, t);
    }
  }

  const prioritized = Array.from(byKey.values()).sort((a, b) => {
    const aEng = a.route === 'page_eng' ? 1 : 0;
    const bEng = b.route === 'page_eng' ? 1 : 0;
    if (bEng !== aEng) return bEng - aEng;
    const aUrg = (a.priorityScore ?? 0) >= 90 ? 1 : 0;
    const bUrg = (b.priorityScore ?? 0) >= 90 ? 1 : 0;
    if (bUrg !== aUrg) return bUrg - aUrg;
    const scoreDiff = (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return b.count - a.count;
  });

  const signature = prioritized
    .map((t) => `${t.groupKey}@${t.latestId}#${t.count}:${t.priorityScore ?? 0}:${t.route ?? ''}`)
    .join('|');

  if (previousSignature && previousSignature === signature) {
    return null;
  }

  const topRefs: ProactiveThreadRef[] = prioritized.slice(0, 3).map((t) => ({
    groupKey: t.groupKey,
    latestId: t.latestId,
    title: t.title,
    channel: t.channel,
    count: t.count,
    priorityScore: t.priorityScore,
    revenueRisk: t.revenueRisk,
    route: t.route,
    isUrgent: (t.priorityScore ?? 0) >= 90,
    isSpike: t.count >= 2,
  }));

  const parts: string[] = [];
  if (pageEngCount > 0) {
    parts.push(`${pageEngCount} eng ${pageEngCount === 1 ? 'page' : 'pages'}`);
  } else if (urgentThreads.length > 0) {
    parts.push(`${urgentThreads.length} urgent ${urgentThreads.length === 1 ? 'alert' : 'alerts'}`);
  }
  if (notifyOpsCount > 0 && pageEngCount === 0 && urgentThreads.length === 0) {
    parts.push(`${notifyOpsCount} ops ${notifyOpsCount === 1 ? 'item' : 'items'}`);
  }
  if (spikeThreads.length > 0) {
    parts.push(
      `${spikeThreads.length} repeated ${spikeThreads.length === 1 ? 'spike' : 'spikes'}`
    );
  }
  const headline =
    parts.length > 0
      ? `Heads up: ${parts.join(' and ')} need attention`
      : 'Decisions API: what stood out';

  const executive = buildExecutiveBriefingFallback(summaries, options);

  return {
    signature,
    headline,
    body: executive.body,
    urgentCount: urgentThreads.length,
    spikeCount: spikeThreads.length,
    notifyOpsCount,
    pageEngCount,
    referencedThreads: topRefs,
  };
}

/**
 * Matches workspace threads mentioned in an assistant reply so the Copilot drawer
 * can surface crisp 1-click jump links straight to the referenced threads.
 */
export function matchReferencedThreadsInText(
  text: string,
  summaries: WorkspaceThreadSummary[],
  maxMatches = 3
): ProactiveThreadRef[] {
  const lower = text.toLowerCase();
  const matches: ProactiveThreadRef[] = [];

  for (const t of summaries) {
    if (matches.length >= maxMatches) break;
    const titleSnippet = t.title.toLowerCase().slice(0, 28).trim();
    const channelMatch = t.channel && lower.includes(t.channel.toLowerCase());
    const titleWords = t.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4);
    const wordHits = titleWords.filter((w) => lower.includes(w)).length;

    if (
      (titleSnippet.length >= 10 && lower.includes(titleSnippet)) ||
      (titleWords.length >= 2 && wordHits >= Math.min(3, titleWords.length)) ||
      (channelMatch && wordHits >= 1)
    ) {
      matches.push({
        groupKey: t.groupKey,
        latestId: t.latestId,
        title: t.title,
        channel: t.channel,
        count: t.count,
        priorityScore: t.priorityScore,
        revenueRisk: t.revenueRisk,
        route: t.route,
        isUrgent: (t.priorityScore ?? 0) >= 90,
        isSpike: t.count >= 2,
      });
    }
  }

  return matches;
}

/**
 * Generates a calm, grounded local on-device workspace summary when offline.
 * Strictly operates on locally scrubbed summaries.
 */
export function buildOfflineWorkspaceReply(
  prompt: string,
  summaries: WorkspaceThreadSummary[]
): string {
  const active = summaries.filter((t) => !t.resolved && t.bucket === 'needs_action');
  if (active.length === 0) {
    return 'Working offline — there are no unresolved actionable alerts in your inbox right now.';
  }

  const lower = prompt.toLowerCase();

  if (lower.includes('revenue') || lower.includes('blocking')) {
    const revThreads = [...active]
      .sort((a, b) => (b.revenueRisk ?? b.priorityScore ?? 0) - (a.revenueRisk ?? a.priorityScore ?? 0))
      .slice(0, 3);
    return [
      '**Top Revenue & SLA Risks (On-Device)**',
      ...revThreads.map(
        (t) =>
          `- **${t.title}** (${t.channel}${t.count > 1 ? ` · ×${t.count}` : ''}${t.revenueRisk !== null ? ` · ${t.revenueRisk}% risk` : ''})`
      ),
      '',
      'Reconnect to stream live deeper triage across these threads.',
    ].join('\n');
  }

  if (lower.includes('standup')) {
    const top = active.slice(0, 4);
    return [
      '**Ops Standup Update (On-Device)**',
      `- **Active threads needing action:** ${active.length} (${summaries.filter((t) => t.bucket === 'hidden_noise').length} routine noise threads auto-filtered)`,
      ...top.map(
        (t) =>
          `- **${t.channel}:** ${t.title}${t.count > 1 ? ` (×${t.count})` : ''}${t.priorityScore !== null ? ` — ${t.priorityScore}% priority` : ''}`
      ),
    ].join('\n');
  }

  const urgent = active.filter((t) => (t.priorityScore ?? 0) >= 85);
  const top = (urgent.length > 0 ? urgent : active).slice(0, 3);
  return [
    `**Urgent Fires Summary (On-Device · ${active.length} active)**`,
    ...top.map(
      (t) =>
        `- **${t.title}** in ${t.channel}${t.count > 1 ? ` (×${t.count})` : ''}${t.priorityScore !== null ? ` · ${t.priorityScore}%` : ''}`
    ),
    '',
    'Click any thread below to inspect details or reconnect for live streaming chat.',
  ].join('\n');
}

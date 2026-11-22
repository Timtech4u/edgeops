import type {
  DecisionTriageScores,
  IncidentBucket,
  IncidentItem,
  IncidentSeverity,
  IndustryPackId,
  SlackChannelInfo,
} from '../types/edgeops.ts';
import {
  buildOfflineSuggestedReply,
  evaluateNoiseGate,
  scrubPiiLocally,
} from './privacyShield.ts';

export interface RawSlackHistoryAttachment {
  fallback?: string;
  title?: string;
  text?: string;
  pretext?: string;
}

export interface RawSlackHistoryMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: {
    id?: string;
    name?: string;
  };
  attachments?: RawSlackHistoryAttachment[];
}

export interface SyncedSlackMessage {
  id: string;
  channelId: string;
  channel: string;
  rawText: string;
  scrubbedText?: string;
  timestamp: string;
  ts: string;
  threadTs?: string;
  user: string;
  isBot: boolean;
  replyCount: number;
  source: 'slack_live';
  decisionScores?: DecisionTriageScores;
  bucket?: IncidentBucket;
  priorityScore?: number;
}

export interface SyncedChannelSummary extends SlackChannelInfo {
  messageCount: number;
}

const IGNORED_SLACK_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_purpose',
  'channel_topic',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_purpose',
  'group_topic',
  'group_name',
  'group_archive',
  'group_unarchive',
  'bot_add',
  'bot_remove',
  'message_deleted',
  'pinned_item',
  'unpinned_item',
]);

/**
 * Converts raw Slack mrkdwn into clean, human-readable text BEFORE Privacy Shield PII scrubbing:
 * - `<mailto:user@co.io|user@co.io>` -> `user@co.io` (so PII scrubbing outputs a single `[Protected Email]`)
 * - `<https://url|Label>` -> `Label` and `<https://url>` -> `https://url`
 * - `<#C123|ops-team>` -> `#ops-team`, removes raw `<@U123>` / `<!here>` / `<!channel>` wrappers
 * - Strips `*bold*`, `~strike~`, inline code backticks, and `-----` / `=====` divider lines
 *   while preserving underscores inside IDs like `acct_88412K` or `FAILED_VERIFICATION`
 */
export function formatSlackText(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw.replace(/\r\n?/g, '\n');

  // 1. Unwrap Slack angle-bracket links & mentions BEFORE decoding &lt;/&gt;
  text = text
    .replace(/<mailto:([^|>\s]+)(?:\|[^>]*)?>/gi, '$1')
    .replace(/mailto:([^\s|>]+)/gi, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, (_m, _url: string, label: string) => label.trim())
    .replace(/<(https?:\/\/[^>]+)>/gi, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/gi, '#$1')
    .replace(/<!subteam\^[^|>]+\|(@?[^>]+)>/gi, '$1')
    .replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/gi, '')
    .replace(/<@[A-Z0-9]+\|([^>]+)>/gi, '@$1')
    .replace(/<@[A-Z0-9]+>/gi, '');

  // 2. Decode standard Slack HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // 3. Re-run angle-bracket unwrap in case entities were double-encoded (&lt;mailto:...&gt;)
  text = text
    .replace(/<mailto:([^|>\s]+)(?:\|[^>]*)?>/gi, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, (_m, _url: string, label: string) => label.trim())
    .replace(/<(https?:\/\/[^>]+)>/gi, '$1');

  // 4. Remove horizontal divider lines (-----, =========, _________, etc.) and inline long dash runs
  text = text
    .replace(/^[ \t]*[-=_*~—–─━]{3,}[ \t]*$/gm, '')
    .replace(/(?:^|\s)[-=—–─━]{4,}(?=\s|$)/g, ' ');

  // 5. Strip Slack mrkdwn formatting markers without harming underscores inside IDs (e.g. acct_88412K, FAILED_VERIFICATION)
  text = text
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~([^~\n]+)~/g, '$1')
    .replace(/(^|[\s([{"'])_([^_\n]+)_(?=$|[\s.,!?;:)\]}"'])/gm, '$1$2');

  // 6. Collapse excessive whitespace and empty lines into crisp paragraphs
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function extractSlackMessageText(msg: RawSlackHistoryMessage): string {
  const direct = typeof msg.text === 'string' ? formatSlackText(msg.text) : '';
  if (direct.length > 0) {
    return direct;
  }

  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      const parts = [att.pretext, att.title, att.text, att.fallback]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => formatSlackText(v))
        .filter((v) => v.length > 0);
      if (parts.length > 0) {
        const uniqueParts = Array.from(new Set(parts));
        return uniqueParts.join('\n');
      }
    }
  }

  return '';
}

export function isSyncableSlackMessage(msg: RawSlackHistoryMessage): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type && msg.type !== 'message') return false;
  if (typeof msg.ts !== 'string' || !msg.ts.trim()) return false;
  if (msg.subtype && IGNORED_SLACK_SUBTYPES.has(msg.subtype)) return false;

  const rawDirect = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (/^<@[A-Z0-9]+>\s+has\s+(joined|left)\s+the\s+channel/i.test(rawDirect)) return false;

  const text = extractSlackMessageText(msg);
  if (!text) return false;
  return true;
}

export function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }
  return new Date(Math.round(seconds * 1000)).toISOString();
}

export function normalizeSlackHistoryMessages(
  channelId: string,
  channelName: string,
  messages: RawSlackHistoryMessage[]
): SyncedSlackMessage[] {
  const cleanChannel = channelName.startsWith('#') ? channelName : `#${channelName}`;
  const out: SyncedSlackMessage[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (!isSyncableSlackMessage(msg)) continue;
    const ts = String(msg.ts).trim();
    const id = `slk_${channelId}_${ts}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const isBot = Boolean(
      msg.bot_id || msg.subtype === 'bot_message' || (msg.bot_profile && typeof msg.bot_profile === 'object')
    );
    const replyCount =
      typeof msg.reply_count === 'number' && Number.isFinite(msg.reply_count)
        ? Math.max(0, Math.floor(msg.reply_count))
        : 0;
    const threadTs =
      typeof msg.thread_ts === 'string' && msg.thread_ts.trim().length > 0
        ? msg.thread_ts.trim()
        : undefined;

    out.push({
      id,
      channelId,
      channel: cleanChannel,
      rawText: extractSlackMessageText(msg),
      timestamp: slackTsToIso(ts),
      ts,
      ...(threadTs ? { threadTs } : {}),
      user: msg.user || msg.username || msg.bot_profile?.name || msg.bot_id || 'slack_user',
      isBot,
      replyCount,
      source: 'slack_live',
    });
  }

  return out;
}

export function deduplicateAndSortSyncedMessages(
  messages: SyncedSlackMessage[]
): SyncedSlackMessage[] {
  const byId = new Map<string, SyncedSlackMessage>();
  for (const msg of messages) {
    if (!byId.has(msg.id)) {
      byId.set(msg.id, msg);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aNum = Number.parseFloat(a.ts) || 0;
    const bNum = Number.parseFloat(b.ts) || 0;
    return bNum - aNum;
  });
}

export function formatRelativeTimeLabel(isoTimestamp: string, nowMs = Date.now()): string {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return 'Just now';
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(parsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatLocalClockTime(isoTimestamp: string, timeZone?: string): {
  hhmm: string;
  tzShort: string;
  label: string;
  weekday: string;
} {
  const parsed = Date.parse(isoTimestamp);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  const safeTz = (() => {
    if (timeZone && timeZone.trim()) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: timeZone.trim() }).format(date);
        return timeZone.trim();
      } catch {
        return 'UTC';
      }
    }
    return 'UTC';
  })();

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: safeTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
      weekday: 'long',
    }).formatToParts(date);

    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const rawTz = parts.find((p) => p.type === 'timeZoneName')?.value ?? safeTz;
    // Normalize Africa/Harare GMT+2 -> CAT for crisp readability
    const tzShort =
      safeTz === 'Africa/Harare' || safeTz === 'Africa/Maputo'
        ? rawTz === 'GMT+2' || rawTz === 'UTC+2'
          ? 'CAT'
          : rawTz
        : rawTz;
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hhmm = `${hour}:${minute}`;
    return { hhmm, tzShort, label: `${hhmm} ${tzShort}`.trim(), weekday };
  } catch {
    const hhmm = date.toISOString().slice(11, 16);
    return { hhmm, tzShort: 'UTC', label: `${hhmm} UTC`, weekday: '' };
  }
}

export function deriveTitleFromScrubbedText(scrubbedText: string, channel: string): string {
  const cleaned = formatSlackText(scrubbedText)
    .replace(/@[a-zA-Z0-9_-]+/g, '')
    .replace(/^[•·\-*>\s]+/, '')
    .trim();

  if (!cleaned) return `Message from ${channel}`;
  const firstLine = cleaned.split('\n').find((line) => line.trim().length > 0)?.trim() || cleaned;
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0].trim();
  const base =
    firstSentence.length >= 12
      ? firstSentence
      : firstLine.length >= 12
        ? firstLine
        : cleaned.replace(/\s+/g, ' ');
  return base.length > 96 ? `${base.slice(0, 93)}...` : base;
}

function inferSeverity(
  text: string,
  isNoise: boolean,
  priorityScore?: number,
  revenueRisk?: number
): IncidentSeverity {
  if (isNoise) return 'low';
  if ((typeof priorityScore === 'number' && priorityScore >= 85) || (typeof revenueRisk === 'number' && revenueRisk >= 0.75)) {
    return 'high';
  }
  if (/\b(critical|sev1|p0|outage|down|500|502|503|504|duplicate charge|payment fail|failed_verification|failed|fatal|crash)\b/i.test(text)) {
    return 'high';
  }
  return 'medium';
}

/**
 * Runs Slack mrkdwn cleanup + strictly on-device Privacy Shield (PII scrubbing + noise filtering + offline reply draft)
 * on a synced Slack message, preserving zero-output-token `gemini-decision-1` scores & priority bucket when present.
 */
export function syncedSlackMessageToIncident(
  msg: SyncedSlackMessage,
  pack: IndustryPackId,
  nowMs = Date.now()
): IncidentItem {
  const cleanRaw = formatSlackText(msg.rawText) || msg.rawText;
  const scrub = scrubPiiLocally(cleanRaw);
  const title = deriveTitleFromScrubbedText(scrub.scrubbedText, msg.channel);
  const localNoise = evaluateNoiseGate(title, cleanRaw);

  const hasDecisionBucket = msg.bucket === 'needs_action' || msg.bucket === 'hidden_noise';
  const bucket: IncidentBucket = hasDecisionBucket
    ? msg.bucket!
    : localNoise.isNoise
      ? 'hidden_noise'
      : 'needs_action';
  const isNoise = bucket === 'hidden_noise';
  const route = msg.decisionScores?.route;
  const noiseReason = hasDecisionBucket
    ? route === 'page_eng'
      ? 'Routed to Page Eng by Gemini Decisions (0 output tokens).'
      : route === 'notify_ops'
        ? (msg.decisionScores?.customerBlocked ?? 0) >= 0.7
          ? 'Customer blocked — routed to Notify Ops (0 output tokens).'
          : (msg.decisionScores?.manualMoneyMove ?? 0) >= 0.65
            ? 'Manual money movement — routed to Notify Ops (0 output tokens).'
            : 'Routed to Notify Ops by Gemini Decisions (0 output tokens).'
        : route === 'digest_only'
          ? 'Low-urgency follow-up — kept in digest (0 output tokens).'
          : isNoise
            ? 'Routine FYI, confirmation, or digest — ignored (0 output tokens).'
            : 'Requires team action (scored at 0 output tokens).'
    : localNoise.reason;

  const severity = inferSeverity(
    scrub.scrubbedText,
    isNoise,
    msg.priorityScore,
    msg.decisionScores?.revenueRisk
  );
  const suggestedReply = buildOfflineSuggestedReply(
    { title, channel: msg.channel, severity },
    scrub.scrubbedText
  );

  return {
    id: msg.id,
    title,
    channel: msg.channel,
    severity,
    status: isNoise ? 'suppressed' : 'open',
    inferenceMode: 'on_device',
    rawPayload: cleanRaw,
    scrubbedSummary: scrub.scrubbedText,
    piiRedactedCount: scrub.redactionCount,
    piiCategories: scrub.categories,
    isNoise,
    noiseReason,
    suggestedReply,
    createdAtIso: msg.timestamp,
    timestampLabel: formatRelativeTimeLabel(msg.timestamp, nowMs),
    slackPosted: false,
    onDeviceEngineLabel: 'Local Privacy Shield · PREFER_ON_DEVICE',
    industryPack: pack,
    source: 'slack_live',
    isSample: false,
    decisionScores: msg.decisionScores,
    bucket,
    priorityScore: msg.priorityScore,
    isBot: Boolean(msg.isBot),
    replyCount: typeof msg.replyCount === 'number' ? msg.replyCount : 0,
    ...(msg.threadTs ? { threadTs: msg.threadTs } : {}),
  };
}

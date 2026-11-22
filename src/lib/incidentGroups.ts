import { getIncidentBucket, sortIncidentsByTriage } from './decisions.ts';
import { formatSlackText } from './slackSync.ts';
import type { DecisionTriageScores, IncidentBucket, IncidentItem } from '../types/edgeops.ts';

export interface IncidentGroup {
  groupKey: string;
  latest: IncidentItem;
  occurrences: IncidentItem[];
  count: number;
  entityName: string | null;
  normalizedTitle: string;
  bucket: IncidentBucket;
  priorityScore?: number;
  decisionScores?: DecisionTriageScores;
}

const GENERIC_FOR_PHRASES = new Set([
  'review',
  'manual review',
  'reconciliation',
  'approval',
  'attention',
  'action',
  'verification',
  'compliance',
  'triage',
  'details',
  'more',
  'today',
  'now',
  'all',
  'your team',
  'the team',
  'ops',
  'support',
  'finance',
  'engineering',
  'you',
  'us',
  'them',
  'this',
  'that',
  'it',
]);

function cleanEntityCandidate(raw: string): string | null {
  const cleaned = raw
    .replace(/\[Protected\s+(?:Email|Phone|Account|Card)\]/gi, '')
    .replace(/[#*_`"'()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:.,;!?-]+$/g, '')
    .trim();

  if (cleaned.length < 2 || cleaned.length > 48) return null;
  const lower = cleaned.toLowerCase();
  if (GENERIC_FOR_PHRASES.has(lower)) return null;
  if (/^\d+$/.test(lower)) return null;
  if (/^(?:the|a|an)\s+/i.test(lower)) {
    const stripped = cleaned.replace(/^(?:the|a|an)\s+/i, '').trim();
    if (stripped.length < 2 || GENERIC_FOR_PHRASES.has(stripped.toLowerCase())) return null;
    return stripped;
  }
  return cleaned;
}

/**
 * Extracts a key business / merchant / entity name when present in an alert title or body,
 * so repeated alerts for the same business collapse together while different businesses stay separate.
 */
export function extractEntityKey(title: string, summary: string): { key: string | null; display: string | null } {
  const cleanTitle = (formatSlackText(title) || title).replace(/\n+/g, ' ').trim();
  const cleanSummary = (formatSlackText(summary) || summary).trim();

  // 1. Explicit labeled fields in summary or title (e.g., "Business: Acme Corp", "Merchant: Northstar")
  const combined = `${cleanTitle}\n${cleanSummary}`;
  const labeledMatch = combined.match(
    /\b(?:business|merchant|company|client|tenant|organization|org|customer|workspace)\s*[:=-]\s*([^\n,|;·•—–()[\]]{2,48})/i
  );
  if (labeledMatch?.[1]) {
    const rawSegment = labeledMatch[1].split(/\s+-\s+/)[0] || labeledMatch[1];
    const candidate = cleanEntityCandidate(rawSegment);
    if (candidate) {
      return { key: candidate.toLowerCase(), display: candidate };
    }
  }

  // 2. "for <Entity Name>" in the title (e.g., "Compliance verification overdue for Acme Logistics")
  const forMatch = cleanTitle.match(
    /\bfor\s+([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z0-9][A-Za-z0-9&'.-]*){0,3})\b/
  );
  if (forMatch?.[1]) {
    const candidate = cleanEntityCandidate(forMatch[1]);
    if (candidate) {
      return { key: candidate.toLowerCase(), display: candidate };
    }
  }

  // 3. Leading bracketed org/app tag in title (e.g., "[NORTHSTAR] Compliance alert digest")
  const bracketMatch = cleanTitle.match(/^\[([A-Za-z0-9 _.-]{2,32})\]/);
  if (bracketMatch?.[1]) {
    const candidate = cleanEntityCandidate(bracketMatch[1]);
    if (candidate && !/^protected\s+/i.test(candidate)) {
      return { key: candidate.toLowerCase(), display: candidate };
    }
  }

  return { key: null, display: null };
}

/**
 * Normalizes an incident title by removing volatile timestamps, IDs, amounts, counts,
 * and entity suffixes so repeated occurrences of the same operational alert share a base title.
 */
export function normalizeGroupBaseTitle(title: string, entityKey: string | null = null): string {
  let text = (formatSlackText(title) || title)
    .replace(/\n+/g, ' ')
    .trim()
    .toLowerCase();

  // Remove dates & timestamps
  text = text
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[t\s]\d{1,2}:\d{2}(?::\d{2})?z?)?\b/gi, ' ')
    .replace(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{2,4})?\b/gi,
      ' '
    )
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|utc|gmt|est|pst)?\b/gi, ' ')
    // Remove UUIDs, hex tokens, numeric IDs, order/operation codes, dollar amounts
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b(?:id|op|tx|txn|ord|inv|req|acct|cus|usr|biz)[_#-]?[a-z0-9]{3,}\b/gi, ' ')
    .replace(/#[0-9a-z_-]{2,}\b/gi, ' ')
    .replace(/[$€£¥]\s?\d[\d,]*(?:\.\d+)?/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|%|usd|eur|gbp|ngn)\b/gi, ' ')
    .replace(/\(\s*(?:\d+\s*(?:items?|alerts?|events?|new|overdue|pending)?)?\s*\)/gi, ' ')
    .replace(/\b\d+\b/g, ' ');

  if (entityKey) {
    const escaped = entityKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\bfor\\s+${escaped}\\b`, 'gi'), ' ');
  }

  text = text
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 80) || 'alert';
}

export function buildIncidentGroupKey(item: IncidentItem): string {
  const channel = (item.channel || '#ops-triage').trim().toLowerCase();
  const { key: entityKey } = extractEntityKey(item.title, item.scrubbedSummary || item.rawPayload);
  const baseTitle = normalizeGroupBaseTitle(item.title, entityKey);
  return `${channel}::${baseTitle}::${entityKey || ''}`;
}

function getIncidentTimestampMs(item: IncidentItem): number {
  const parsed = Date.parse(item.createdAtIso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Groups repeated Slack alerts by (channel + normalized base title + key business/entity name).
 * Keeps the newest occurrence as `latest` and sorts groups by triage priority & recency.
 */
export function groupIncidents(incidents: IncidentItem[]): IncidentGroup[] {
  const buckets = new Map<
    string,
    {
      items: IncidentItem[];
      entityDisplay: string | null;
      normalizedTitle: string;
    }
  >();

  for (const item of incidents) {
    const channel = (item.channel || '#ops-triage').trim().toLowerCase();
    const { key: entityKey, display: entityDisplay } = extractEntityKey(
      item.title,
      item.scrubbedSummary || item.rawPayload
    );
    const normalizedTitle = normalizeGroupBaseTitle(item.title, entityKey);
    const groupKey = `${channel}::${normalizedTitle}::${entityKey || ''}`;

    const existing = buckets.get(groupKey);
    if (existing) {
      existing.items.push(item);
      if (!existing.entityDisplay && entityDisplay) {
        existing.entityDisplay = entityDisplay;
      }
    } else {
      buckets.set(groupKey, {
        items: [item],
        entityDisplay,
        normalizedTitle,
      });
    }
  }

  const groups: Array<IncidentGroup & { createdAtIso: string }> = [];

  for (const [groupKey, entry] of buckets.entries()) {
    const occurrences = [...entry.items].sort((a, b) => {
      const diff = getIncidentTimestampMs(b) - getIncidentTimestampMs(a);
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });

    const latest = occurrences[0];
    const hasActionable = occurrences.some((occ) => getIncidentBucket(occ) === 'needs_action');
    const bucket: IncidentBucket = hasActionable ? 'needs_action' : 'hidden_noise';

    let highestPriority: number | undefined;
    let bestScores: DecisionTriageScores | undefined = latest.decisionScores;

    for (const occ of occurrences) {
      if (typeof occ.priorityScore === 'number' && Number.isFinite(occ.priorityScore)) {
        if (highestPriority === undefined || occ.priorityScore > highestPriority) {
          highestPriority = occ.priorityScore;
          if (occ.decisionScores) {
            bestScores = occ.decisionScores;
          }
        }
      }
    }

    groups.push({
      groupKey,
      latest,
      occurrences,
      count: occurrences.length,
      entityName: entry.entityDisplay,
      normalizedTitle: entry.normalizedTitle,
      bucket,
      priorityScore: highestPriority,
      decisionScores: bestScores,
      createdAtIso: latest.createdAtIso,
    });
  }

  return sortIncidentsByTriage(groups).map(({ createdAtIso: _ignored, ...group }) => group);
}

/**
 * Produces a short human-readable summary or diff note for an occurrence row inside the
 * collapsible `N occurrences ▾` timeline. Operates strictly on locally scrubbed text.
 */
export function computeOccurrenceDiffNote(
  current: IncidentItem,
  previous: IncidentItem | undefined
): string {
  const cleanCurrent = (formatSlackText(current.scrubbedSummary) || current.scrubbedSummary).trim();
  if (!previous) {
    const firstLine = cleanCurrent.split('\n').map((l) => l.trim()).find(Boolean) || current.title;
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  const cleanPrev = (formatSlackText(previous.scrubbedSummary) || previous.scrubbedSummary).trim();
  if (cleanCurrent === cleanPrev) {
    return 'Same alert payload repeated';
  }

  const prevLines = new Set(
    cleanPrev
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const changedLine = cleanCurrent
    .split('\n')
    .map((l) => l.trim())
    .find((line) => line.length > 0 && !prevLines.has(line));

  if (changedLine) {
    return changedLine.length > 120 ? `${changedLine.slice(0, 117)}...` : changedLine;
  }

  const firstLine = cleanCurrent.split('\n').map((l) => l.trim()).find(Boolean) || 'Updated alert details';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

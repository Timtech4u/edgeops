import type { IncidentItem, NoiseGateResult, RedactionSpan, ScrubResult } from '../types/edgeops.ts';

const NOISE_RULES: Array<{ name: string; pattern: RegExp; reason: string; confidence: number }> = [
  {
    name: 'resize-observer-loop',
    pattern: /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
    reason: 'Benign browser layout ResizeObserver warning with zero user impact.',
    confidence: 0.98,
  },
  {
    name: 'client-abort-499',
    pattern: /\b(499|ERR_ABORTED|AbortError|client closed connection before response)\b/i,
    reason: 'Transient client navigation cancel (HTTP 499 / AbortError).',
    confidence: 0.95,
  },
  {
    name: 'healthcheck-probe',
    pattern: /\b(synthetic healthcheck|keepalive ping|heartbeat timeout 1\/3|edge-probe-ok)\b/i,
    reason: 'Single-sample synthetic heartbeat probe jitter; auto-recovered.',
    confidence: 0.96,
  },
  {
    name: 'browser-extension-script',
    pattern: /(chrome-extension:\/\/|moz-extension:\/\/|Script error\.?\s*$)/i,
    reason: 'Third-party browser extension script noise outside application origin.',
    confidence: 0.97,
  },
  {
    name: 'cdn-preflight-cache-miss',
    pattern: /\b(favicon\.ico 404|robots\.txt 404|source map 404|prefetch canceled)\b/i,
    reason: 'Non-critical static asset prefetch or sourcemap miss.',
    confidence: 0.94,
  },
];

export function evaluateNoiseGate(title: string, rawPayload: string): NoiseGateResult {
  const combined = `${title}\n${rawPayload}`;
  for (const rule of NOISE_RULES) {
    if (rule.pattern.test(combined)) {
      return {
        isNoise: true,
        reason: rule.reason,
        confidence: rule.confidence,
        matchedRule: rule.name,
      };
    }
  }
  return {
    isNoise: false,
    reason: 'Actionable operational signal affecting customer workflows or revenue.',
    confidence: 0.92,
    matchedRule: 'signal-verified',
  };
}

interface PatternSpec {
  category: RedactionSpan['category'];
  replacement: string;
  regex: RegExp;
}

const PII_PATTERNS: PatternSpec[] = [
  {
    category: 'Email',
    replacement: '[Protected Email]',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'Card',
    replacement: '[Protected Card]',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  },
  {
    category: 'Account',
    replacement: '[Protected Account]',
    regex: /\b(?:acct|cus|wal|usr|iban|wallet|sub)_[A-Za-z0-9]{4,32}\b|\b0x[a-fA-F0-9]{12,42}\b|\bACC-\d{4,12}\b/g,
  },
  {
    category: 'Phone',
    replacement: '[Protected Phone]',
    regex: /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
];

export function scrubPiiLocally(input: string): ScrubResult {
  const rawMatches: RedactionSpan[] = [];

  for (const spec of PII_PATTERNS) {
    const regex = new RegExp(spec.regex.source, spec.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      rawMatches.push({
        original: match[0],
        replacement: spec.replacement,
        category: spec.category,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Sort by start position and drop overlaps
  rawMatches.sort((a, b) => a.start - b.start || b.end - a.end);
  const redactions: RedactionSpan[] = [];
  let cursor = 0;
  for (const span of rawMatches) {
    if (span.start >= cursor) {
      redactions.push(span);
      cursor = span.end;
    }
  }

  let scrubbedText = '';
  let lastIdx = 0;
  for (const span of redactions) {
    scrubbedText += input.slice(lastIdx, span.start) + span.replacement;
    lastIdx = span.end;
  }
  scrubbedText += input.slice(lastIdx);

  const categories = Array.from(new Set(redactions.map((r) => r.category)));

  return {
    originalText: input,
    scrubbedText,
    redactions,
    redactionCount: redactions.length,
    categories,
  };
}

export function buildOfflineSuggestedReply(
  incident: Pick<IncidentItem, 'title' | 'channel' | 'severity'>,
  scrubbedText: string
): string {
  const lower = `${incident.title} ${scrubbedText}`.toLowerCase();

  if (lower.includes('payment') || lower.includes('checkout') || lower.includes('charge') || lower.includes('invoice')) {
    return (
      "Hi there — thanks for flagging this right away. We noticed a brief delay processing your payment request and our team is actively verifying the transaction status so you won't be double-charged. No action is needed on your side; we'll follow up with confirmation within 15 minutes."
    );
  }

  if (lower.includes('shipment') || lower.includes('label') || lower.includes('carrier') || lower.includes('delivery') || lower.includes('warehouse')) {
    return (
      "Hi there — we spotted a dispatch sync delay affecting your shipment update and have already queued a fresh carrier handoff check. Your order remains prioritized in today's outbound wave, and we'll send your updated tracking link shortly."
    );
  }

  if (lower.includes('sso') || lower.includes('login') || lower.includes('webhook') || lower.includes('api') || lower.includes('rate limit')) {
    return (
      "Hi team — we detected an intermittent service hiccup impacting your workspace integration and have isolated the affected queue. All queued events are safe and will replay automatically once cleared; we'll share a brief root-cause note as soon as normal throughput resumes."
    );
  }

  return (
    `Hi there — we received an alert regarding "${incident.title}" and have begun an immediate review. Your account details remain protected, and we'll post a clear update as soon as our fix is verified.`
  );
}

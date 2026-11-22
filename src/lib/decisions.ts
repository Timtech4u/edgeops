import type {
  DecisionRoute,
  DecisionTriageScores,
  DeferredTool,
  IncidentBucket,
  IncidentItem,
  ToolDecisionScore,
} from '../types/edgeops.ts';

export const DECISION_MODEL = 'gemini-decision-1';
export const TOOL_MATCH_THRESHOLD = 0.5;

export interface NoulQuestionSpec {
  type: 'noul';
  instructions: string;
}

export interface DecisionNoulAnswerLike {
  type?: string;
  noul?: number;
  confidence?: number;
}

export type DecisionAnswersMap = Record<string, DecisionNoulAnswerLike | undefined>;

export type TriageDecisionQuestionKey =
  | 'needs_action'
  | 'customer_blocked'
  | 'is_fyi_or_digest'
  | 'revenue_or_sla_risk'
  | 'manual_money_move'
  | 'needs_engineering';

export const TRIAGE_DECISION_QUESTIONS: Record<TriageDecisionQuestionKey, NoulQuestionSpec> = {
  needs_action: {
    type: 'noul',
    instructions:
      'Does a human need to act now to resolve a failure, blocked workflow, overdue compliance/KYC issue, or active operational incident?',
  },
  customer_blocked: {
    type: 'noul',
    instructions:
      'Is a customer blocked right now from completing a payment, using their card, accessing their account, or finishing checkout (including auto-frozen cards or repeated declines)?',
  },
  is_fyi_or_digest: {
    type: 'noul',
    instructions:
      'Is this routine operational noise, an automated successful payment or wallet top-up confirmation, a digest summary, or a general FYI notification that needs no intervention?',
  },
  revenue_or_sla_risk: {
    type: 'noul',
    instructions:
      'Does this message indicate direct revenue loss, a failed payment/budget operation, or a critical SLA/compliance deadline breach?',
  },
  manual_money_move: {
    type: 'noul',
    instructions:
      'Is this a manual wallet debit, manual payout, manual balance adjustment, or off-cycle money move initiated by an operator rather than a routine automated customer deposit?',
  },
  needs_engineering: {
    type: 'noul',
    instructions:
      'Does resolving this issue require an engineer to inspect code, backend APIs, infrastructure, or Sentry errors rather than support or operations handling it?',
  },
};

export interface TriageDecisionOutcome {
  decisionScores: DecisionTriageScores;
  bucket: IncidentBucket;
  route: DecisionRoute;
  priorityScore: number;
}

function clampProb(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function extractNoulScore(answers: DecisionAnswersMap | undefined, key: string): number | null {
  const ans = answers?.[key];
  if (!ans || ans.type !== 'noul' || typeof ans.noul !== 'number' || !Number.isFinite(ans.noul)) {
    return null;
  }
  return clampProb(ans.noul);
}

/**
 * Maps calibrated 6-signal `gemini-decision-1` probabilities onto an explicit operational route:
 * - `page_eng`: high engineering need paired with real action/customer/revenue impact
 * - `notify_ops`: customer blocked (e.g. auto-frozen card), manual money move, or actionable ops signal without needing engineering
 * - `digest_only`: mild follow-up signal kept out of urgent alerts
 * - `ignore`: routine telemetry / automated top-ups / confirmations (zero false alarms)
 */
export function computeDecisionRoute(scores: {
  needsAction: number;
  customerBlocked?: number;
  isNoise: number;
  revenueRisk: number;
  manualMoneyMove?: number;
  needsEngineering: number;
}): DecisionRoute {
  const customerBlocked = clampProb(scores.customerBlocked, 0);
  const manualMoneyMove = clampProb(scores.manualMoneyMove, 0);
  const needsAction = clampProb(scores.needsAction, 0);
  const isNoise = clampProb(scores.isNoise, 0);
  const revenueRisk = clampProb(scores.revenueRisk, 0);
  const needsEngineering = clampProb(scores.needsEngineering, 0);

  if (isNoise >= 0.7) {
    return 'ignore';
  }
  const hasStrongImpact =
    needsAction >= 0.55 || customerBlocked >= 0.7 || revenueRisk >= 0.75 || manualMoneyMove >= 0.65;
  if (needsEngineering >= 0.65 && hasStrongImpact) {
    return 'page_eng';
  }
  if (hasStrongImpact) {
    return 'notify_ops';
  }
  if (needsAction >= 0.35 && isNoise < 0.65) {
    return 'digest_only';
  }
  return 'ignore';
}

export function inferDecisionRoute(scores?: DecisionTriageScores): DecisionRoute | null {
  if (!scores) return null;
  if (
    scores.route === 'page_eng' ||
    scores.route === 'notify_ops' ||
    scores.route === 'digest_only' ||
    scores.route === 'ignore'
  ) {
    return scores.route;
  }
  return computeDecisionRoute(scores);
}

/**
 * Computes calibrated triage route, bucket & priority score from a `gemini-decision-1` response.
 * Returns null if the model response did not contain valid `noul` answers.
 */
export function computeTriageDecision(
  answers: DecisionAnswersMap | undefined,
  outputTokens = 0,
  latencyMs?: number
): TriageDecisionOutcome | null {
  const needsAction = extractNoulScore(answers, 'needs_action');
  const isNoise = extractNoulScore(answers, 'is_fyi_or_digest');
  const customerBlocked = extractNoulScore(answers, 'customer_blocked');
  const revenueRisk = extractNoulScore(answers, 'revenue_or_sla_risk');
  const manualMoneyMove = extractNoulScore(answers, 'manual_money_move');
  const needsEngineering = extractNoulScore(answers, 'needs_engineering');

  if (needsAction === null || isNoise === null) {
    return null;
  }

  const safeCustomerBlocked = customerBlocked ?? 0;
  const safeRevenueRisk = revenueRisk ?? 0;
  const safeManualMoneyMove = manualMoneyMove ?? 0;
  const safeNeedsEngineering = needsEngineering ?? 0;

  const route = computeDecisionRoute({
    needsAction,
    customerBlocked: safeCustomerBlocked,
    isNoise,
    revenueRisk: safeRevenueRisk,
    manualMoneyMove: safeManualMoneyMove,
    needsEngineering: safeNeedsEngineering,
  });

  const bucket: IncidentBucket =
    route === 'page_eng' || route === 'notify_ops' ? 'needs_action' : 'hidden_noise';
  const priorityScore = Math.round(
    Math.max(needsAction, safeCustomerBlocked, safeManualMoneyMove, safeRevenueRisk) * 100
  );
  const safeLatency =
    typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0
      ? Math.round(latencyMs)
      : undefined;

  return {
    decisionScores: {
      needsAction,
      customerBlocked: safeCustomerBlocked,
      isNoise,
      revenueRisk: safeRevenueRisk,
      manualMoneyMove: safeManualMoneyMove,
      needsEngineering: safeNeedsEngineering,
      route,
      ...(safeLatency !== undefined ? { latencyMs: safeLatency } : {}),
      model: DECISION_MODEL,
      outputTokens: typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : 0,
    },
    bucket,
    route,
    priorityScore,
  };
}

/**
 * Builds up to 1,000 `noul` questions for scoring candidate MCP / OpenAPI tools in a single
 * zero-output-token `ai.decisions.create` call. Keys strictly match `[A-Za-z0-9_-]{1,64}`.
 */
export function buildToolDecisionQuestions(tools: DeferredTool[]): {
  questions: Record<string, NoulQuestionSpec>;
  keyToTool: Map<string, DeferredTool>;
} {
  const questions: Record<string, NoulQuestionSpec> = {};
  const keyToTool = new Map<string, DeferredTool>();

  const capped = tools.slice(0, 1000);
  capped.forEach((tool, idx) => {
    const key = `tool_${idx}`;
    keyToTool.set(key, tool);
    questions[key] = {
      type: 'noul',
      instructions: `Is the tool "${tool.name}" (${tool.category} — ${tool.description}) directly relevant for investigating, diagnosing, or resolving this operations incident?`,
    };
  });

  return { questions, keyToTool };
}

/**
 * Selects only the tools whose `gemini-decision-1` relevance probability meets or exceeds `threshold` (default 0.50).
 */
export function selectMatchedToolsFromDecisions(
  keyToTool: Map<string, DeferredTool>,
  answers: DecisionAnswersMap | undefined,
  threshold = TOOL_MATCH_THRESHOLD
): {
  matchedTools: DeferredTool[];
  toolScores: ToolDecisionScore[];
} {
  const scored: Array<{ tool: DeferredTool; score: number; matched: boolean }> = [];

  for (const [key, tool] of keyToTool.entries()) {
    const score = extractNoulScore(answers, key) ?? 0;
    scored.push({
      tool,
      score,
      matched: score >= threshold,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    matchedTools: scored.filter((s) => s.matched).map((s) => s.tool),
    toolScores: scored.map((s) => ({
      toolName: s.tool.name,
      score: Math.round(s.score * 1000) / 1000,
      matched: s.matched,
    })),
  };
}

export interface PriorityBadge {
  label: string;
  tone: 'urgent' | 'action';
}

export interface RouteBadge {
  route: DecisionRoute;
  label: string;
  shortLabel: string;
}

export function getRouteBadge(scores?: DecisionTriageScores | null): RouteBadge | null {
  const route = inferDecisionRoute(scores ?? undefined);
  if (!route) return null;
  switch (route) {
    case 'page_eng':
      return { route, label: 'Route: Page Eng', shortLabel: 'Page Eng' };
    case 'notify_ops':
      return { route, label: 'Route: Notify Ops', shortLabel: 'Notify Ops' };
    case 'digest_only':
      return { route, label: 'Route: Digest', shortLabel: 'Digest' };
    case 'ignore':
      return { route, label: 'Route: Ignore', shortLabel: 'Ignored' };
  }
}

export function formatLatencyDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.round(ms)} ms`;
}

export function getIncidentBucket(incident: Pick<IncidentItem, 'bucket' | 'isNoise'>): IncidentBucket {
  if (incident.bucket === 'needs_action' || incident.bucket === 'hidden_noise') {
    return incident.bucket;
  }
  return incident.isNoise ? 'hidden_noise' : 'needs_action';
}

export function getPriorityBadge(
  incident: Pick<IncidentItem, 'bucket' | 'isNoise' | 'priorityScore' | 'decisionScores'>
): PriorityBadge | null {
  if (getIncidentBucket(incident) !== 'needs_action') return null;
  if (typeof incident.priorityScore !== 'number' || !Number.isFinite(incident.priorityScore)) {
    return null;
  }
  const pct = Math.max(1, Math.min(99, Math.round(incident.priorityScore)));
  const revenueRisk = incident.decisionScores?.revenueRisk ?? 0;
  if (pct >= 85 || revenueRisk >= 0.75) {
    return { label: `Urgent · ${pct}%`, tone: 'urgent' };
  }
  if (pct >= 55) {
    return { label: `Action · ${pct}%`, tone: 'action' };
  }
  return null;
}

/**
 * Sorts `needs_action` incidents by highest `priorityScore` first (ties by newest timestamp),
 * and `hidden_noise` incidents by newest timestamp first.
 */
export function sortIncidentsByTriage<
  T extends { bucket?: IncidentBucket; isNoise?: boolean; priorityScore?: number; createdAtIso?: string; ts?: string }
>(items: T[]): T[] {
  const getTime = (item: T): number => {
    if (item.ts) {
      const n = Number.parseFloat(item.ts);
      if (Number.isFinite(n)) return n * 1000;
    }
    if (item.createdAtIso) {
      const ms = Date.parse(item.createdAtIso);
      if (Number.isFinite(ms)) return ms;
    }
    return 0;
  };

  const getBucket = (item: T): IncidentBucket => {
    if (item.bucket === 'needs_action' || item.bucket === 'hidden_noise') return item.bucket;
    return item.isNoise ? 'hidden_noise' : 'needs_action';
  };

  return [...items].sort((a, b) => {
    const aBucket = getBucket(a);
    const bBucket = getBucket(b);
    if (aBucket !== bBucket) {
      return aBucket === 'needs_action' ? -1 : 1;
    }
    if (aBucket === 'needs_action') {
      const aPrio = typeof a.priorityScore === 'number' ? a.priorityScore : -1;
      const bPrio = typeof b.priorityScore === 'number' ? b.priorityScore : -1;
      if (bPrio !== aPrio) return bPrio - aPrio;
    }
    return getTime(b) - getTime(a);
  });
}

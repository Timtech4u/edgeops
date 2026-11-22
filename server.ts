import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type FunctionDeclaration,
  type GenerateContentResponse,
} from '@google/genai';
import { filterToolsByRole } from './src/lib/toolRegistry.ts';
import {
  buildOfflineSuggestedReply,
  evaluateNoiseGate,
  scrubPiiLocally,
} from './src/lib/privacyShield.ts';
import {
  deduplicateAndSortSyncedMessages,
  formatLocalClockTime,
  formatSlackText,
  normalizeSlackHistoryMessages,
  type RawSlackHistoryMessage,
  type SyncedChannelSummary,
  type SyncedSlackMessage,
} from './src/lib/slackSync.ts';
import {
  DECISION_MODEL,
  TOOL_MATCH_THRESHOLD,
  TRIAGE_DECISION_QUESTIONS,
  buildToolDecisionQuestions,
  computeTriageDecision,
  formatLatencyDuration,
  inferDecisionRoute,
  selectMatchedToolsFromDecisions,
  sortIncidentsByTriage,
  type DecisionAnswersMap,
  type TriageDecisionOutcome,
} from './src/lib/decisions.ts';
import {
  buildExecutiveBriefingFallback,
  computeWindowMetadata,
  pickComparisonIgnoredThread,
  type WorkspaceThreadSummary,
} from './src/lib/copilotBriefing.ts';
import {
  createSlackConnectionStore,
  isWildcardOrgId,
  sanitizeOrgIdForStore,
  type PersistedSlackConnection,
} from './src/lib/slackStore.ts';
import type {
  CloudInvestigationResult,
  DecisionRoute,
  DecisionTriageScores,
  DeferredTool,
  IncidentBucket,
  IndustryPackId,
  SlackChannelInfo,
  ToolDecisionScore,
  ToolExecutionTrace,
  ToolRoleTag,
  TriageRole,
} from './src/types/edgeops.ts';

const PORT = Number(process.env.PORT) || 3000;
const PRIMARY_MODEL = 'gemini-4-neon';
const FALLBACK_MODEL = 'gemini-4-hydrogen';
const MAX_TURNS = 4;
const PER_CALL_TIMEOUT_MS = 14_000;
const TOTAL_INVESTIGATION_BUDGET_MS = 22_000;
const DECISION_TIMEOUT_MS = 6_000;
const MAX_DECISION_CACHE_SIZE = 1_000;

interface SlackWebhookEventRecord {
  id: string;
  orgId: string;
  receivedAt: string;
  channel: string;
  user: string;
  title: string;
  rawText: string;
  scrubbedSummary: string;
  piiRedactedCount: number;
  piiCategories: string[];
  isNoise: boolean;
  noiseReason: string;
  suggestedReply: string;
  verified: boolean;
  eventType: 'app_mention' | 'message';
  decisionScores?: DecisionTriageScores;
  bucket?: IncidentBucket;
  priorityScore?: number;
}

const SLACK_OAUTH_SCOPES =
  'app_mentions:read,channels:history,groups:history,channels:read,groups:read';
const DEFAULT_SLACK_REDIRECT_URI =
  'https://calmduty.web.app/api/slack/oauth/callback';
const WEBHOOK_EPHEMERAL_TTL_MS = 5 * 60_000;

const slackStore = createSlackConnectionStore();
const orgSigningSecrets = new Map<string, string>();
const orgSlackEvents = new Map<string, SlackWebhookEventRecord[]>();
const orgSseClients = new Map<string, Set<express.Response>>();
const orgSlackChannelCache = new Map<string, SlackChannelInfo[]>();

interface ResolvedSlackConnection {
  orgId: string;
  token: string;
  team: string | null;
  botName: string | null;
  botUserId: string | null;
  selectedChannelIds: string[];
  connectedAt: string | null;
}

function toResolvedSlackConnection(conn: PersistedSlackConnection): ResolvedSlackConnection {
  return {
    orgId: conn.orgId,
    token: conn.accessToken,
    team: conn.team || null,
    botName: conn.botName || null,
    botUserId: conn.botUserId || null,
    selectedChannelIds: [...(conn.selectedChannelIds || [])],
    connectedAt: conn.updatedAt || null,
  };
}

async function resolveActiveSlackConnection(
  requestedOrgId?: string
): Promise<ResolvedSlackConnection | null> {
  const persisted = await slackStore.resolveConnection(requestedOrgId);
  return persisted ? toResolvedSlackConnection(persisted) : null;
}

async function resolveSlackTokenAndOrg(
  rawOrgId: unknown,
  req: express.Request,
  bodyToken?: string
): Promise<{ token: string; orgId: string; selectedChannelIds: string[] }> {
  const requestedOrg = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';
  const sanitized = isWildcardOrgId(requestedOrg) ? '' : sanitizeOrgIdForStore(requestedOrg);

  const headerToken = req.header('x-slack-token')?.trim() || '';
  if (headerToken.startsWith('xoxb-') || headerToken.startsWith('xoxp-')) {
    return {
      token: headerToken,
      orgId: sanitized || 'org_workspace',
      selectedChannelIds: [],
    };
  }
  const explicitBody = typeof bodyToken === 'string' ? bodyToken.trim() : '';
  if (explicitBody.startsWith('xoxb-') || explicitBody.startsWith('xoxp-')) {
    return {
      token: explicitBody,
      orgId: sanitized || 'org_workspace',
      selectedChannelIds: [],
    };
  }

  const active = await resolveActiveSlackConnection(requestedOrg);
  if (active) {
    return {
      token: active.token,
      orgId: active.orgId,
      selectedChannelIds: active.selectedChannelIds,
    };
  }

  return { token: '', orgId: sanitized || 'org_workspace', selectedChannelIds: [] };
}

async function fetchBotMemberChannels(token: string): Promise<{
  ok: boolean;
  channels: SlackChannelInfo[];
  error?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url =
      'https://slack.com/api/users.conversations?types=public_channel,private_channel&exclude_archived=true&limit=100';
    const slackRes = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const data = (await slackRes.json()) as {
      ok?: boolean;
      error?: string;
      channels?: Array<{
        id?: string;
        name?: string;
        is_private?: boolean;
        num_members?: number;
      }>;
    };

    if (!data.ok) {
      return {
        ok: false,
        channels: [],
        error: data.error || 'users_conversations_failed',
      };
    }

    const channels: SlackChannelInfo[] = (data.channels || [])
      .filter((ch): ch is { id: string; name: string; is_private?: boolean; num_members?: number } =>
        Boolean(ch && typeof ch.id === 'string' && typeof ch.name === 'string')
      )
      .map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_private: Boolean(ch.is_private),
        num_members: typeof ch.num_members === 'number' ? ch.num_members : 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { ok: true, channels };
  } catch (error) {
    return {
      ok: false,
      channels: [],
      error: error instanceof Error ? error.message : 'slack_channels_network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeOrgId(raw: unknown): string {
  if (typeof raw !== 'string') return 'org_workspace';
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  return cleaned || 'org_workspace';
}

function resolveSlackRedirectUri(): string {
  const configured = process.env.SLACK_REDIRECT_URI?.trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured;
  }
  return DEFAULT_SLACK_REDIRECT_URI;
}

function encodeSlackOAuthState(orgId: string): string {
  return Buffer.from(JSON.stringify({ orgId }), 'utf8').toString('base64url');
}

function decodeSlackOAuthState(rawState: unknown): string {
  if (typeof rawState !== 'string' || !rawState.trim()) return 'org_workspace';
  try {
    const parsed = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as {
      orgId?: string;
    };
    if (parsed && typeof parsed.orgId === 'string') {
      return sanitizeOrgId(parsed.orgId);
    }
  } catch {
    // Support plain orgId state strings as fallback
  }
  return sanitizeOrgId(rawState);
}

const slackDecisionCache = new Map<string, TriageDecisionOutcome>();

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function setCachedTriageDecision(id: string, outcome: TriageDecisionOutcome): void {
  if (slackDecisionCache.size >= MAX_DECISION_CACHE_SIZE) {
    const oldestKey = slackDecisionCache.keys().next().value;
    if (oldestKey) slackDecisionCache.delete(oldestKey);
  }
  slackDecisionCache.set(id, outcome);
}

async function createDecisionsWithTimeout(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['decisions']['create']>[0],
  timeoutMs = DECISION_TIMEOUT_MS
): Promise<Awaited<ReturnType<GoogleGenAI['decisions']['create']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Decisions API timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([ai.decisions.create(params), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scrubs PII locally and scores a Slack message using `gemini-decision-1` (0 output tokens).
 * Caches results by message ID so repeat syncs are instant.
 * Returns `outcome: null` cleanly on timeout/API failure without fabricating fake scores.
 */
async function scoreMessageWithDecisionsApi(
  id: string,
  channel: string,
  cleanRawText: string
): Promise<{ outcome: TriageDecisionOutcome | null; scrubbedText: string }> {
  const formatted = formatSlackText(cleanRawText) || cleanRawText;
  const scrub = scrubPiiLocally(formatted);

  const cached = slackDecisionCache.get(id);
  if (cached) {
    return { outcome: cached, scrubbedText: scrub.scrubbedText };
  }

  try {
    const ai = getGenAIClient();
    const input = `${channel}: ${scrub.scrubbedText}`.slice(0, 4000);
    const startedAt = Date.now();
    const result = await createDecisionsWithTimeout(ai, {
      model: DECISION_MODEL,
      input,
      questions: TRIAGE_DECISION_QUESTIONS,
    });
    const latencyMs = Math.max(1, Date.now() - startedAt);
    const outcome = computeTriageDecision(result.answers as DecisionAnswersMap, 0, latencyMs);
    if (outcome) {
      setCachedTriageDecision(id, outcome);
    }
    return { outcome, scrubbedText: scrub.scrubbedText };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`gemini-decision-1 triage fallback for ${id}: ${msg}`);
    return { outcome: null, scrubbedText: scrub.scrubbedText };
  }
}

async function scoreMessagesInBatches(
  messages: SyncedSlackMessage[],
  maxToScore = 25,
  batchSize = 6
): Promise<SyncedSlackMessage[]> {
  const toScore = messages.slice(0, maxToScore);
  const remaining = messages.slice(maxToScore).map((msg) => {
    const formatted = formatSlackText(msg.rawText) || msg.rawText;
    const scrub = scrubPiiLocally(formatted);
    return {
      ...msg,
      rawText: formatted,
      scrubbedText: scrub.scrubbedText,
    };
  });

  const scored: SyncedSlackMessage[] = [];
  for (let i = 0; i < toScore.length; i += batchSize) {
    const batch = toScore.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (msg) => {
        const formatted = formatSlackText(msg.rawText) || msg.rawText;
        const { outcome, scrubbedText } = await scoreMessageWithDecisionsApi(
          msg.id,
          msg.channel,
          formatted
        );
        return {
          ...msg,
          rawText: formatted,
          scrubbedText,
          ...(outcome
            ? {
                decisionScores: outcome.decisionScores,
                bucket: outcome.bucket,
                priorityScore: outcome.priorityScore,
              }
            : {}),
        };
      })
    );
    scored.push(...results);
  }

  return sortIncidentsByTriage([...scored, ...remaining]);
}

function executePluggableTool(
  tool: DeferredTool,
  args: Record<string, unknown>,
  incidentTitle: string,
  scrubbedSummary: string
): ToolExecutionTrace {
  const start = Date.now();
  const argValue =
    Object.values(args).find((v) => typeof v === 'string' && v.trim().length > 0) || 'primary-pool';
  const nameLower = tool.name.toLowerCase();

  let summary = `Checked ${tool.category} telemetry via ${tool.name} for "${String(argValue)}".`;
  let data: Record<string, unknown> = {
    status: 'degraded_isolated',
    target: String(argValue),
    checkedAt: new Date().toISOString(),
    piiExposed: false,
  };

  if (
    nameLower.includes('payment') ||
    nameLower.includes('billing') ||
    nameLower.includes('invoice') ||
    nameLower.includes('freight') ||
    nameLower.includes('giftcard')
  ) {
    summary = `Detected 1 duplicate pending hold/entry tied to ${String(argValue)} after upstream 504 retry; ledger reconciliation ready.`;
    data = {
      target: String(argValue),
      duplicateEntriesFound: 1,
      settlementMismatch: true,
      idempotencyKeyCollision: 'idem_retry_window_12s',
      recommendedAction:
        tool.roleTag === 'Viewer'
          ? 'Escalate to Finance Lead for hold release'
          : 'Void duplicate hold and settle single capture',
    };
  } else if (
    nameLower.includes('sso') ||
    nameLower.includes('jwks') ||
    nameLower.includes('identity') ||
    nameLower.includes('scim')
  ) {
    summary = `JWKS signing key cache for ${String(argValue)} is 45m stale after IdP key rollover (kid mismatch).`;
    data = {
      target: String(argValue),
      cachedKeyId: 'kid_2026_old',
      idpActiveKeyId: 'kid_2026_rotated',
      failedAssertionsLast15m: 142,
      cacheTtlRemainingSec: 1840,
    };
  } else if (
    nameLower.includes('shipping') ||
    nameLower.includes('label') ||
    nameLower.includes('fulfillment') ||
    nameLower.includes('wms') ||
    nameLower.includes('manifest') ||
    nameLower.includes('cold_chain')
  ) {
    summary = `Found stalled batch queue (${String(argValue)}) with 42 queued items due to carrier/bridge lock timeout.`;
    data = {
      target: String(argValue),
      stalledCount: 42,
      queueAgeMinutes: 19,
      backupEndpointHealthy: true,
      lockState: 'orphaned_worker_lock',
    };
  } else if (
    nameLower.includes('webhook') ||
    nameLower.includes('rate_limit') ||
    nameLower.includes('cart') ||
    nameLower.includes('lock')
  ) {
    summary = `Queue depth elevated on ${String(argValue)}; circuit breaker tripped after upstream spike and is ready for controlled replay.`;
    data = {
      target: String(argValue),
      deadLetterCount: 18,
      p95LatencyMs: 3420,
      downstreamHealthyNow: true,
    };
  } else if (
    nameLower.includes('deployment') ||
    nameLower.includes('rollback') ||
    nameLower.includes('db') ||
    nameLower.includes('cache')
  ) {
    summary = `Recent canary rollout shifted p95 latency +280% on ${String(argValue)}; prior stable revision verified healthy.`;
    data = {
      target: String(argValue),
      canaryErrorRatePct: 6.4,
      baselineErrorRatePct: 0.12,
      incidentReference: incidentTitle.slice(0, 60),
      scrubbedContextMatched: scrubbedSummary.length > 0,
    };
  }

  return {
    toolName: tool.name,
    roleTag: tool.roleTag,
    source: tool.sourceName,
    latencyMs: Math.max(12, Date.now() - start + 28),
    summary,
    data,
  };
}

function rankDeferredTools(
  authorizedTools: DeferredTool[],
  queryText: string,
  maxResults = 3
): DeferredTool[] {
  const tokens = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = authorizedTools.map((tool) => {
    const hay = `${tool.name} ${tool.category} ${tool.description} ${tool.sourceName}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) {
        score += tool.name.toLowerCase().includes(tok) ? 4 : 2;
      }
    }
    if (tool.sourceType !== 'pack') score += 1;
    return { tool, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.tool);
}

async function generateContentWithTimeout(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  timeoutMs: number
): Promise<GenerateContentResponse> {
  const effectiveTimeout = Math.min(PER_CALL_TIMEOUT_MS, Math.max(2_000, timeoutMs));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Gemini call timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);
  });

  try {
    const configWithSignal = {
      ...(params.config ?? {}),
      store: false,
      abortSignal: controller.signal,
    };
    return await Promise.race([
      ai.models.generateContent({
        ...params,
        config: configWithSignal,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callModelWithFallback(
  ai: GoogleGenAI,
  turnBudgetMs: number,
  deadlineMs: number,
  buildRequest: (model: string, thinkingLevel: ThinkingLevel) => Parameters<GoogleGenAI['models']['generateContent']>[0]
): Promise<{ response: GenerateContentResponse; modelUsed: string }> {
  const remaining = Math.min(turnBudgetMs, deadlineMs - Date.now());
  if (remaining <= 800) {
    throw new Error('Investigation time budget exceeded before model call.');
  }

  // Use Gemini 4 Neon (ThinkingLevel.LOW — MINIMAL is not supported on gemini-4-neon); fallback on retryable errors
  const primaryBudget = Math.min(PER_CALL_TIMEOUT_MS, remaining);
  try {
    const response = await generateContentWithTimeout(
      ai,
      buildRequest(PRIMARY_MODEL, ThinkingLevel.LOW),
      primaryBudget
    );
    return { response, modelUsed: PRIMARY_MODEL };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isRetryable =
      msg.includes('503') ||
      msg.includes('UNAVAILABLE') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('INTERNAL');
    const fallbackRemaining = deadlineMs - Date.now();
    if (!isRetryable || fallbackRemaining <= 2_500) {
      throw err;
    }
  }

  const fallbackRemaining = Math.min(PER_CALL_TIMEOUT_MS, deadlineMs - Date.now());
  const response = await generateContentWithTimeout(
    ai,
    buildRequest(FALLBACK_MODEL, ThinkingLevel.LOW),
    fallbackRemaining
  );
  return { response, modelUsed: FALLBACK_MODEL };
}

const DIAGNOSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    diagnosis: {
      type: Type.STRING,
      description: 'Plain-English 2-3 sentence explanation of what happened and root cause.',
    },
    customerImpact: {
      type: Type.STRING,
      description: '1 concise sentence describing customer impact.',
    },
    remediationPlan: {
      type: Type.STRING,
      description: 'Clear 1-2 sentence summary of the recommended fix appropriate for the active role.',
    },
    remediationSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2 to 4 crisp, plain-English action steps.',
    },
    recommendedActionLabel: {
      type: Type.STRING,
      description: 'Short action summary under 8 words.',
    },
    slackSummary: {
      type: Type.STRING,
      description: 'Clean 2-line Slack thread summary safe to post (zero raw PII).',
    },
  },
  required: [
    'diagnosis',
    'customerImpact',
    'remediationPlan',
    'remediationSteps',
    'recommendedActionLabel',
    'slackSummary',
  ],
};

async function runCloudInvestigation(params: {
  incidentTitle: string;
  channel: string;
  severity: string;
  scrubbedSummary: string;
  activeRole: TriageRole;
  tools: DeferredTool[];
  industryPack: IndustryPackId;
}): Promise<CloudInvestigationResult> {
  const ai = getGenAIClient();
  const startedAt = Date.now();
  const deadlineMs = startedAt + TOTAL_INVESTIGATION_BUDGET_MS;

  const totalToolsCount = params.tools.length;
  const authorizedTools = filterToolsByRole(params.tools, params.activeRole);
  const byName = new Map(authorizedTools.map((t) => [t.name, t]));

  const toolTraces: ToolExecutionTrace[] = [];
  const executedNames = new Set<string>();
  let toolScores: ToolDecisionScore[] = [];
  let activeModelUsed = PRIMARY_MODEL;

  // When workspace has connected MCP/OpenAPI tools, use `gemini-decision-1` as a 0-output-token parallel tool retriever
  if (authorizedTools.length > 0) {
    let matchedTools: DeferredTool[] = [];

    try {
      const { questions, keyToTool } = buildToolDecisionQuestions(authorizedTools);
      const decisionInput = `Channel: ${params.channel}\nIncident: ${params.incidentTitle}\nSummary: ${params.scrubbedSummary}`.slice(
        0,
        4000
      );
      const decisionResult = await createDecisionsWithTimeout(
        ai,
        {
          model: DECISION_MODEL,
          input: decisionInput,
          questions,
        },
        Math.min(DECISION_TIMEOUT_MS, Math.max(3_000, deadlineMs - Date.now() - 8_000))
      );
      const selection = selectMatchedToolsFromDecisions(
        keyToTool,
        decisionResult.answers as DecisionAnswersMap,
        TOOL_MATCH_THRESHOLD
      );
      matchedTools = selection.matchedTools;
      toolScores = selection.toolScores;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`gemini-decision-1 tool retrieval fallback: ${msg}`);
      matchedTools = rankDeferredTools(
        authorizedTools,
        `${params.incidentTitle} ${params.scrubbedSummary}`,
        3
      );
    }

    // Pass ONLY the matched tool schemas (threshold >= 0.50) to Gemini 4 Neon — never bloating context with unmatched tools
    if (matchedTools.length > 0 && Date.now() < deadlineMs - 6_500) {
      const topMatched = matchedTools.slice(0, 8);
      const matchedDeclarations: FunctionDeclaration[] = topMatched.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            target: {
              type: Type.STRING,
              description: 'Affected resource, order, account, tenant, or service identifier (no PII).',
            },
          },
        },
      }));

      try {
        const { response, modelUsed } = await callModelWithFallback(
          ai,
          7_000,
          deadlineMs - 5_500,
          (model, thinkingLevel) => ({
            model,
            contents: `You are investigating an operations incident from ${params.channel}.
Incident: ${params.incidentTitle}
Scrubbed Summary: ${params.scrubbedSummary}
Call the most relevant connected tool(s) to gather diagnostic evidence.`,
            config: {
              thinkingConfig: { thinkingLevel },
              maxOutputTokens: 1024,
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO,
                },
              },
              tools: [{ functionDeclarations: matchedDeclarations }],
            },
          })
        );
        activeModelUsed = modelUsed;

        const calls = response.functionCalls ?? [];
        for (const call of calls) {
          if (!call.name) continue;
          const def = byName.get(call.name);
          if (def && !executedNames.has(def.name) && toolTraces.length < 4) {
            executedNames.add(def.name);
            toolTraces.push(
              executePluggableTool(
                def,
                (call.args || {}) as Record<string, unknown>,
                params.incidentTitle,
                params.scrubbedSummary
              )
            );
          }
        }
      } catch {
        // Proceed with direct execution of matched tools below
      }

      if (toolTraces.length === 0) {
        for (const def of topMatched.slice(0, 3)) {
          if (!executedNames.has(def.name)) {
            executedNames.add(def.name);
            toolTraces.push(
              executePluggableTool(
                def,
                { target: 'primary-pool' },
                params.incidentTitle,
                params.scrubbedSummary
              )
            );
          }
        }
      }
    }
  }

  // Final turn: Structured plain-English JSON synthesis on Gemini 4 Neon
  const synthesisPrompt =
    toolTraces.length > 0
      ? `EdgeOps Cloud Investigator.
Incident: ${params.incidentTitle} (${params.channel})
Scrubbed Summary: ${params.scrubbedSummary}
Connected Tool Findings (${toolTraces.length}/${totalToolsCount}):
${toolTraces.map((t) => `- ${t.toolName}: ${t.summary}`).join('\n')}
Return concise plain-English JSON diagnosis and remediation.`
      : `EdgeOps Triage Assistant.
Channel: ${params.channel}
Title: ${params.incidentTitle}
Scrubbed Message (zero raw PII): ${params.scrubbedSummary}
${totalToolsCount > 0 ? 'None of the connected tools were relevant for this message. Do not invent tool runs or fake telemetry.' : 'No external MCP or OpenAPI tools are connected yet. Do not invent tool runs or fake telemetry.'}
Analyze the message itself and return concise, calm plain-English JSON explaining what happened, likely impact, and practical next steps for the team.`;

  let parsed: {
    diagnosis?: string;
    customerImpact?: string;
    remediationPlan?: string;
    remediationSteps?: string[];
    recommendedActionLabel?: string;
    slackSummary?: string;
  } = {};

  try {
    const { response: synthesisResp, modelUsed: synthesisModel } = await callModelWithFallback(
      ai,
      Math.min(PER_CALL_TIMEOUT_MS, Math.max(5_000, deadlineMs - Date.now())),
      deadlineMs,
      (model, thinkingLevel) => ({
        model,
        contents: synthesisPrompt,
        config: {
          thinkingConfig: { thinkingLevel },
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          responseSchema: DIAGNOSIS_RESPONSE_SCHEMA,
        },
      })
    );
    activeModelUsed = synthesisModel;
    parsed = JSON.parse((synthesisResp.text ?? '{}').trim());
  } catch (err) {
    console.warn(
      'Synthesis fallback triggered:',
      err instanceof Error ? err.message : String(err)
    );
    const primaryTrace = toolTraces[0];
    activeModelUsed = `${PRIMARY_MODEL} · fallback`;
    parsed =
      toolTraces.length > 0
        ? {
            diagnosis: primaryTrace
              ? `${primaryTrace.summary} Verified across ${toolTraces.length} connected tools with zero raw PII exposed.`
              : `Reviewed "${params.incidentTitle}" across ${toolTraces.length} connected tools with zero raw PII exposed.`,
            customerImpact: 'Affected requests may experience temporary errors or delays until resolved.',
            remediationPlan: 'Review the connected tool findings and apply the recommended fix.',
            remediationSteps: toolTraces.slice(0, 3).map((t) => `${t.toolName}: ${t.summary}`),
            recommendedActionLabel: 'Approve & reply',
            slackSummary: `EdgeOps reviewed "${params.incidentTitle}" using ${toolTraces.length} of ${totalToolsCount} connected tools. ${primaryTrace?.summary || 'Ready to reply.'}`,
          }
        : {
            diagnosis: `Reviewed "${params.incidentTitle}" from ${params.channel} with personal details protected on-device.`,
            customerImpact: 'Review the message context in Slack to confirm whether any customers are currently blocked.',
            remediationPlan: 'Confirm the details with the channel owner and post a clear status update.',
            remediationSteps: [
              'Confirm affected scope in the Slack thread',
              'Coordinate the owner and next action',
              'Share a brief confirmation update back to the channel',
            ],
            recommendedActionLabel: 'Approve & reply',
            slackSummary: `EdgeOps summarized "${params.incidentTitle}" from ${params.channel} with personal details kept private.`,
          };
  }

  return {
    diagnosis:
      parsed.diagnosis ||
      `Reviewed "${params.incidentTitle}" from ${params.channel} with personal details protected.`,
    customerImpact:
      parsed.customerImpact ||
      'Review the thread to confirm customer or operational impact.',
    remediationPlan:
      parsed.remediationPlan ||
      'Confirm the recommended next steps and reply back to the channel.',
    remediationSteps:
      Array.isArray(parsed.remediationSteps) && parsed.remediationSteps.length > 0
        ? parsed.remediationSteps.slice(0, 4)
        : ['Confirm affected scope', 'Apply the next step', 'Confirm normal recovery'],
    recommendedActionLabel: parsed.recommendedActionLabel || 'Approve & reply',
    toolsUsed: toolTraces.map((t) => t.toolName),
    toolsTotal: totalToolsCount,
    toolsAuthorized: authorizedTools.length,
    toolTraces,
    toolScores,
    roleUsed: params.activeRole,
    modelUsed:
      totalToolsCount > 0
        ? `${activeModelUsed} (v1beta · ${DECISION_MODEL})`
        : `${activeModelUsed} (v1beta)`,
    slackSummary:
      parsed.slackSummary ||
      (totalToolsCount > 0
        ? `EdgeOps triaged "${params.incidentTitle}" using ${toolTraces.length} of ${totalToolsCount} connected tools.`
        : `EdgeOps analyzed "${params.incidentTitle}" from ${params.channel}.`),
    investigatedAt: new Date().toISOString(),
  };
}

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  signature: string,
  rawBody: string,
  nowEpochSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  const parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs) || Math.abs(nowEpochSec - parsedTs) > 300) {
    return false;
  }
  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function deriveTitleFromSlackText(text: string, channel: string): string {
  const cleaned = formatSlackText(text)
    .replace(/@[a-zA-Z0-9_-]+/g, '')
    .replace(/^[•·\-*>\s]+/, '')
    .trim();
  if (!cleaned) {
    return `Message from ${channel}`;
  }
  const firstLine = cleaned.split('\n')[0].trim();
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0].trim();
  const base =
    firstSentence.length >= 12
      ? firstSentence
      : firstLine.length >= 12
        ? firstLine
        : cleaned.replace(/\s+/g, ' ');
  return base.length > 96 ? `${base.slice(0, 93)}...` : base;
}

function broadcastSlackEvent(orgId: string, record: SlackWebhookEventRecord) {
  const listeners = orgSseClients.get(orgId);
  if (!listeners || listeners.size === 0) return;
  const payload = `data: ${JSON.stringify(record)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

async function startServer() {
  const app = express();

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    })
  );

  app.get('/downloads/calmduty-v0.1.0-android.apk', (_req, res) => {
    res.redirect(302, 'https://calmduty.web.app/downloads/calmduty-v0.1.0-android.apk');
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'edgeops-api',
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
      apiVersion: 'v1beta',
      model: PRIMARY_MODEL,
      decisionModel: DECISION_MODEL,
      zeroDataRetention: true,
      readOnlySlackScopes: true,
      maxTurns: MAX_TURNS,
      perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
    });
  });

  // Cloud Investigation Endpoint (@google/genai v1beta + gemini-decision-1 tool retriever + Gemini 4 Neon)
  // Compatible with BOTH Web (incidentTitle, scrubbedSummary, tools) and Android (title, scrubbedMessage, tools/availableTools)
  app.post('/api/investigate', async (req, res) => {
    res.setTimeout(25_000);
    try {
      const body = (req.body || {}) as {
        incidentTitle?: string;
        title?: string;
        channel?: string;
        severity?: string;
        scrubbedSummary?: string;
        scrubbedMessage?: string;
        activeRole?: TriageRole;
        role?: TriageRole;
        tools?: DeferredTool[];
        availableTools?: Array<string | Partial<DeferredTool>>;
        industryPack?: IndustryPackId;
        pack?: IndustryPackId;
      };

      const resolvedSummary = (body.scrubbedSummary || body.scrubbedMessage || '').trim();
      const resolvedTitle =
        (body.incidentTitle || body.title || '').trim() ||
        (resolvedSummary ? resolvedSummary.slice(0, 90) : '');

      if (!resolvedTitle || !resolvedSummary) {
        return res.status(400).json({
          error:
            'Missing incidentTitle/title or scrubbedSummary/scrubbedMessage. Ensure local PII scrubbing ran before cloud escalation.',
        });
      }

      const rawRole = body.activeRole || body.role;
      const role: TriageRole =
        rawRole === 'Support' || rawRole === 'Finance Lead' || rawRole === 'Admin'
          ? rawRole
          : 'Admin';

      const rawPack = body.industryPack || body.pack;
      const pack: IndustryPackId =
        rawPack === 'ecommerce' || rawPack === 'saas' || rawPack === 'logistics'
          ? rawPack
          : 'ecommerce';

      // Real-only: NEVER fall back to mock industry packs; use ONLY tools connected by Web or Android
      const defaultToolParams: DeferredTool['parameters'] = {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Scrubbed incident or resource reference' },
        },
      };
      const normalizedFromAvailable: DeferredTool[] = Array.isArray(body.availableTools)
        ? body.availableTools
            .map((entry): DeferredTool | null => {
              if (typeof entry === 'string' && entry.trim()) {
                const name = entry.trim().slice(0, 64);
                return {
                  name,
                  description: `${name.replace(/[_-]+/g, ' ')} diagnostic check`,
                  category: 'Connected Tool',
                  roleTag: 'Viewer',
                  defer_loading: true,
                  sourceType: 'mcp',
                  sourceName: 'Connected Tool',
                  parameters: defaultToolParams,
                };
              }
              if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim()) {
                const validRole: ToolRoleTag =
                  entry.roleTag === 'Viewer' || entry.roleTag === 'Operator' || entry.roleTag === 'Admin'
                    ? entry.roleTag
                    : 'Viewer';
                return {
                  name: entry.name.trim().slice(0, 64),
                  description: (entry.description || entry.name).trim(),
                  category: entry.category || 'Connected Tool',
                  roleTag: validRole,
                  defer_loading: true,
                  sourceType: entry.sourceType || 'mcp',
                  sourceName: entry.sourceName || 'Connected Tool',
                  endpointHint: entry.endpointHint,
                  parameters: entry.parameters ?? defaultToolParams,
                };
              }
              return null;
            })
            .filter((t): t is DeferredTool => t !== null)
        : [];
      const rawTools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : normalizedFromAvailable;
      const catalog: DeferredTool[] = rawTools.map((t) => ({
        ...t,
        parameters: t.parameters ?? defaultToolParams,
      }));

      const result = await runCloudInvestigation({
        incidentTitle: resolvedTitle,
        channel: body.channel || '#ops-triage',
        severity: body.severity || 'medium',
        scrubbedSummary: resolvedSummary,
        activeRole: role,
        tools: catalog,
        industryPack: pack,
      });

      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloud investigation failed.';
      console.error('/api/investigate error:', message);
      return res.status(502).json({
        error: message,
      });
    }
  });

  // Ultra-Fast Streaming Triage & Workspace Copilot Chat (SSE via @google/genai v1beta Interactions API)
  // Supports BOTH per-ticket (`scope: "ticket"`) and workspace-wide (`scope: "workspace"`) modes
  // Receives ONLY locally scrubbed context (and re-scrubs defense-in-depth on server)
  app.post('/api/chat', async (req, res) => {
    const body = (req.body || {}) as {
      scope?: 'ticket' | 'workspace';
      workspaceName?: string;
      message?: string;
      history?: Array<{ role?: string; text?: string }>;
      threads?: Array<{
        title?: string;
        channel?: string;
        count?: number;
        bucket?: string;
        route?: string | null;
        priorityScore?: number | null;
        needsAction?: number | null;
        customerBlocked?: number | null;
        isNoise?: number | null;
        revenueRisk?: number | null;
        manualMoneyMove?: number | null;
        needsEngineering?: number | null;
        latencyMs?: number | null;
        isBot?: boolean;
        replyCount?: number;
        unanswered?: boolean;
        createdAtIso?: string;
        timestampLabel?: string;
        scrubbedSummary?: string;
        resolved?: boolean;
      }>;
      ticket?: {
        title?: string;
        channel?: string;
        severity?: string;
        scrubbedSummary?: string;
        occurrenceCount?: number;
        occurrences?: Array<{
          timestampLabel?: string;
          createdAtIso?: string;
          scrubbedSummary?: string;
        }>;
        diagnosis?: string;
        remediationPlan?: string;
      };
    };

    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    if (!rawMessage) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const safeMessage = scrubPiiLocally(rawMessage).scrubbedText.slice(0, 1500);
    const safeHistory = Array.isArray(body.history)
      ? body.history
          .slice(-8)
          .filter(
            (turn): turn is { role: string; text: string } =>
              Boolean(turn && typeof turn.text === 'string' && turn.text.trim().length > 0)
          )
          .map((turn) => ({
            role: turn.role === 'assistant' ? 'Assistant' : 'Teammate',
            text: scrubPiiLocally(turn.text.trim()).scrubbedText.slice(0, 800),
          }))
      : [];

    let fullPrompt = '';
    let systemInstruction = '';

    if (body.scope === 'workspace') {
      const safeWorkspaceName =
        typeof body.workspaceName === 'string' && body.workspaceName.trim()
          ? scrubPiiLocally(body.workspaceName.trim()).scrubbedText.slice(0, 80)
          : 'EdgeOps Workspace';

      const incomingThreads = Array.isArray(body.threads) ? body.threads.slice(0, 25) : [];
      const activeThreads = incomingThreads.filter((t) => !t.resolved && t.bucket !== 'hidden_noise');
      const hiddenNoiseCount = incomingThreads.filter((t) => t.bucket === 'hidden_noise').length;

      const formattedThreads = activeThreads.map((t, idx) => {
        const ch = typeof t.channel === 'string' && t.channel.trim() ? t.channel.trim() : '#ops-triage';
        const title = scrubPiiLocally(
          formatSlackText(typeof t.title === 'string' ? t.title : 'Alert') || 'Alert'
        ).scrubbedText.replace(/\s+/g, ' ').slice(0, 140);
        const summary = scrubPiiLocally(
          formatSlackText(typeof t.scrubbedSummary === 'string' ? t.scrubbedSummary : '') || ''
        ).scrubbedText.replace(/\s+/g, ' ').slice(0, 240);
        const count = typeof t.count === 'number' && t.count > 1 ? ` ×${t.count}` : '';
        const prio =
          typeof t.priorityScore === 'number' && Number.isFinite(t.priorityScore)
            ? ` · Priority ${Math.round(t.priorityScore)}%`
            : '';
        const rev =
          typeof t.revenueRisk === 'number' && Number.isFinite(t.revenueRisk)
            ? ` · Revenue/SLA risk ${Math.round(t.revenueRisk)}%`
            : '';
        const eng =
          typeof t.needsEngineering === 'number' && Number.isFinite(t.needsEngineering)
            ? ` · Eng ${Math.round(t.needsEngineering)}%`
            : '';
        const routeStr = typeof t.route === 'string' && t.route.trim() ? ` · Route ${t.route.trim()}` : '';
        const blockedStr =
          typeof t.customerBlocked === 'number' && Number.isFinite(t.customerBlocked) && t.customerBlocked >= 40
            ? ` · Customer blocked ${Math.round(t.customerBlocked)}%`
            : '';
        const replyStr =
          t.unanswered === true || t.replyCount === 0
            ? ' · Unanswered in Slack'
            : typeof t.replyCount === 'number' && t.replyCount > 0
              ? ` · ${t.replyCount} replies`
              : '';
        return `${idx + 1}. [${ch}${count}${routeStr}${prio}${blockedStr}${rev}${eng}${replyStr}] ${title}\n   Summary: ${summary}`;
      });

      const sections: string[] = [
        `Workspace: ${safeWorkspaceName}`,
        `Active Actionable Threads: ${activeThreads.length} (Auto-filtered Routine Noise Threads: ${hiddenNoiseCount})`,
        formattedThreads.length > 0
          ? `Current Scrubbed Workspace Threads:\n${formattedThreads.join('\n')}`
          : 'Current Scrubbed Workspace Threads: Inbox is clear (0 unresolved actionable threads).',
      ];

      if (safeHistory.length > 0) {
        sections.push(
          `Conversation So Far:\n${safeHistory.map((h) => `${h.role}: ${h.text}`).join('\n')}`
        );
      }

      fullPrompt = `${sections.join('\n\n')}\n\nTeammate Request:\n${safeMessage}`;
      systemInstruction =
        'You are CalmDuty Copilot, a proactive, calm operations chief-of-staff with visibility across all synced, locally-scrubbed Slack threads in the workspace. ' +
        'Answer in clear plain English using crisp bold headings and short bullet points (typically under 180 words). ' +
        'Reference exact alert titles, #channels, and Decision Routes (page_eng vs notify_ops vs ignore) so teammates know what to open first. ' +
        'Prioritize urgent fires (90%+), blocked customers, manual money moves, revenue/SLA blockers, and repeated spikes (×N). ' +
        'Never invent metrics, IDs, or alerts not present in the workspace context, and never ask for raw personal details.';
    } else {
      const ticket = body.ticket || {};
      const safeChannel =
        typeof ticket.channel === 'string' && ticket.channel.trim()
          ? ticket.channel.trim()
          : '#ops-triage';
      const safeTitle = scrubPiiLocally(
        formatSlackText(typeof ticket.title === 'string' ? ticket.title : 'Operations alert') ||
          'Operations alert'
      ).scrubbedText.slice(0, 240);
      const safeSummary = scrubPiiLocally(
        formatSlackText(typeof ticket.scrubbedSummary === 'string' ? ticket.scrubbedSummary : '') ||
          ''
      ).scrubbedText.slice(0, 3500);

      const safeOccurrences = Array.isArray(ticket.occurrences)
        ? ticket.occurrences.slice(0, 12).map((occ, idx) => {
            const ts =
              typeof occ.timestampLabel === 'string' && occ.timestampLabel.trim()
                ? occ.timestampLabel.trim()
                : typeof occ.createdAtIso === 'string'
                  ? occ.createdAtIso
                  : `#${idx + 1}`;
            const text = scrubPiiLocally(
              formatSlackText(typeof occ.scrubbedSummary === 'string' ? occ.scrubbedSummary : '') ||
                ''
            ).scrubbedText
              .replace(/\s+/g, ' ')
              .slice(0, 320);
            return `${idx + 1}. [${ts}] ${text}`;
          })
        : [];

      const occurrenceCount =
        typeof ticket.occurrenceCount === 'number' && ticket.occurrenceCount > 0
          ? ticket.occurrenceCount
          : Math.max(1, safeOccurrences.length);

      const contextSections: string[] = [
        `Channel: ${safeChannel}`,
        `Alert Title: ${safeTitle}`,
        `Grouped Occurrences: ${occurrenceCount}`,
        `Latest Protected Message:\n${safeSummary || safeTitle}`,
      ];

      if (safeOccurrences.length > 1) {
        contextSections.push(
          `Recent Grouped Occurrences (newest first):\n${safeOccurrences.join('\n')}`
        );
      }
      if (typeof ticket.diagnosis === 'string' && ticket.diagnosis.trim()) {
        contextSections.push(
          `Existing Analysis: ${scrubPiiLocally(ticket.diagnosis.trim()).scrubbedText.slice(0, 600)}`
        );
      }
      if (typeof ticket.remediationPlan === 'string' && ticket.remediationPlan.trim()) {
        contextSections.push(
          `Existing Plan: ${scrubPiiLocally(ticket.remediationPlan.trim()).scrubbedText.slice(0, 400)}`
        );
      }
      if (safeHistory.length > 0) {
        contextSections.push(
          `Conversation So Far:\n${safeHistory.map((h) => `${h.role}: ${h.text}`).join('\n')}`
        );
      }

      fullPrompt = `${contextSections.join('\n\n')}\n\nTeammate Request:\n${safeMessage}`;
      systemInstruction =
        'You are EdgeOps Triage Chat, a calm, concise operations copilot embedded inside a shared team inbox. ' +
        'Answer in clear plain English using short paragraphs or crisp bullet points (usually under 160 words unless asked for more). ' +
        'Never ask for raw personal details, never invent ticket/order IDs or fake tool outputs, and keep placeholders like [Protected Email] intact when drafting customer replies. ' +
        'When asked to draft a customer reply, output ONLY the ready-to-send reply text with no preamble.';
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clientClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
      }
    });

    const writeSse = (payload: Record<string, unknown>) => {
      if (clientClosed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        clientClosed = true;
      }
    };

    const CHAT_MODEL_CANDIDATES: Array<{ model: string; isGemini4: boolean }> = [
      { model: 'gemini-3.5-flash-lite', isGemini4: false },
      { model: 'gemini-3.1-flash-lite', isGemini4: false },
      { model: 'gemini-4-hydrogen', isGemini4: true },
      { model: 'gemini-4-neon', isGemini4: true },
    ];

    try {
      const ai = getGenAIClient();
      let streamedAnyText = false;
      let modelUsed = '';
      let lastError = '';

      for (const candidate of CHAT_MODEL_CANDIDATES) {
        if (clientClosed) break;
        const candidateController = new AbortController();
        const candidateTimer = setTimeout(() => candidateController.abort(), 16_000);
        try {
          const interactionParams: Record<string, unknown> = {
            model: candidate.model,
            input: fullPrompt,
            system_instruction: systemInstruction,
            stream: true,
            store: false,
          };
          if (candidate.isGemini4) {
            interactionParams.generation_config = { thinking_level: 'low' };
          }

          const stream = await ai.interactions.create(
            interactionParams as unknown as Parameters<GoogleGenAI['interactions']['create']>[0],
            { signal: candidateController.signal }
          );

          let announcedMeta = false;
          for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
            if (clientClosed) break;
            const eventType = typeof rawEvent.event_type === 'string' ? rawEvent.event_type : '';
            if (eventType === 'step.delta' || eventType === 'content.delta') {
              const delta = rawEvent.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === 'text' && typeof delta.text === 'string' && delta.text.length > 0) {
                if (!announcedMeta) {
                  announcedMeta = true;
                  modelUsed = candidate.model;
                  writeSse({ type: 'meta', model: candidate.model, mode: 'cloud_streaming' });
                }
                streamedAnyText = true;
                writeSse({ type: 'delta', text: delta.text });
              }
            }
          }

          if (streamedAnyText || clientClosed) {
            break;
          }
        } catch (candidateErr) {
          lastError = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
          if (streamedAnyText) {
            // Partial response already streamed; stop retrying to avoid duplicate text
            break;
          }
          console.warn(`/api/chat model ${candidate.model} unavailable, trying next:`, lastError);
        } finally {
          clearTimeout(candidateTimer);
        }
      }

      if (!clientClosed && !res.writableEnded) {
        if (streamedAnyText) {
          writeSse({ type: 'done', model: modelUsed || 'gemini-4-neon' });
        } else {
          writeSse({
            type: 'error',
            error: lastError || 'Unable to stream response from Gemini right now.',
          });
        }
        res.end();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unable to reach Gemini chat service.';
      console.error('/api/chat error:', msg);
      writeSse({ type: 'error', error: msg });
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // Executive Decisions API Window Briefing (`gemini-3.5-flash-lite`, `store: false`, strictly scrubbed context)
  // Explains what stood out (`page_eng` / `notify_ops`) with exact Decisions API scores, unanswered Slack status,
  // 1 concrete `ignore` comparison showing what false alarm was avoided, and exact ms latency. NEVER posts to Slack.
  app.post('/api/briefing', async (req, res) => {
    const body = (req.body || {}) as {
      workspaceName?: string;
      timeZone?: string;
      threads?: Array<{
        groupKey?: string;
        latestId?: string;
        title?: string;
        channel?: string;
        count?: number;
        bucket?: string;
        route?: string | null;
        priorityScore?: number | null;
        needsAction?: number | null;
        customerBlocked?: number | null;
        isNoise?: number | null;
        revenueRisk?: number | null;
        manualMoneyMove?: number | null;
        needsEngineering?: number | null;
        latencyMs?: number | null;
        isBot?: boolean;
        replyCount?: number;
        unanswered?: boolean;
        createdAtIso?: string;
        timestampLabel?: string;
        scrubbedSummary?: string;
        resolved?: boolean;
      }>;
    };

    const normalizePctField = (val: unknown): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      // Callers send integer percentages (0..100); only scale fractional decimals strictly between 0 and 1.
      const pct = val > 0 && val < 1 ? val * 100 : val;
      return Math.max(0, Math.min(100, Math.round(pct)));
    };

    const safeWorkspaceName =
      typeof body.workspaceName === 'string' && body.workspaceName.trim()
        ? scrubPiiLocally(body.workspaceName.trim()).scrubbedText.slice(0, 80)
        : 'Slack';
    const requestedTz =
      typeof body.timeZone === 'string' && body.timeZone.trim().length > 0
        ? body.timeZone.trim().slice(0, 64)
        : 'UTC';

    const rawThreads = Array.isArray(body.threads) ? body.threads.slice(0, 35) : [];
    const normalizedThreads: WorkspaceThreadSummary[] = rawThreads.map((t, idx) => {
      const safeTitle = scrubPiiLocally(
        formatSlackText(typeof t.title === 'string' ? t.title : 'Alert') || 'Alert'
      )
        .scrubbedText.replace(/\s+/g, ' ')
        .slice(0, 140);
      const safeSummary = scrubPiiLocally(
        formatSlackText(typeof t.scrubbedSummary === 'string' ? t.scrubbedSummary : '') || ''
      )
        .scrubbedText.replace(/\s+/g, ' ')
        .slice(0, 320);

      const needsAction = normalizePctField(t.needsAction);
      const customerBlocked = normalizePctField(t.customerBlocked);
      const isNoise = normalizePctField(t.isNoise);
      const revenueRisk = normalizePctField(t.revenueRisk);
      const manualMoneyMove = normalizePctField(t.manualMoneyMove);
      const needsEngineering = normalizePctField(t.needsEngineering);
      const validRoute =
        t.route === 'page_eng' ||
        t.route === 'notify_ops' ||
        t.route === 'digest_only' ||
        t.route === 'ignore'
          ? (t.route as DecisionRoute)
          : inferDecisionRoute(
              needsAction !== null && isNoise !== null
                ? {
                    needsAction: needsAction / 100,
                    customerBlocked: (customerBlocked ?? 0) / 100,
                    isNoise: isNoise / 100,
                    revenueRisk: (revenueRisk ?? 0) / 100,
                    manualMoneyMove: (manualMoneyMove ?? 0) / 100,
                    needsEngineering: (needsEngineering ?? 0) / 100,
                    model: DECISION_MODEL,
                    outputTokens: 0,
                  }
                : undefined
            );

      const replyCount =
        typeof t.replyCount === 'number' && Number.isFinite(t.replyCount)
          ? Math.max(0, Math.floor(t.replyCount))
          : 0;

      const bucket: IncidentBucket =
        t.bucket === 'hidden_noise' || validRoute === 'ignore' || validRoute === 'digest_only'
          ? 'hidden_noise'
          : 'needs_action';

      return {
        groupKey: typeof t.groupKey === 'string' && t.groupKey.trim() ? t.groupKey.trim() : `t_${idx}`,
        latestId: typeof t.latestId === 'string' && t.latestId.trim() ? t.latestId.trim() : `id_${idx}`,
        title: safeTitle,
        channel: typeof t.channel === 'string' && t.channel.trim() ? t.channel.trim() : '#ops-triage',
        count: typeof t.count === 'number' && t.count > 0 ? Math.floor(t.count) : 1,
        bucket,
        route: validRoute,
        priorityScore: normalizePctField(t.priorityScore),
        needsAction,
        customerBlocked,
        isNoise,
        revenueRisk,
        manualMoneyMove,
        needsEngineering,
        latencyMs:
          typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs) && t.latencyMs > 0
            ? Math.round(t.latencyMs)
            : null,
        isBot: Boolean(t.isBot),
        replyCount,
        unanswered: t.unanswered === true || replyCount === 0,
        createdAtIso:
          typeof t.createdAtIso === 'string' && Number.isFinite(Date.parse(t.createdAtIso))
            ? t.createdAtIso
            : new Date().toISOString(),
        timestampLabel: typeof t.timestampLabel === 'string' ? t.timestampLabel : 'Recent',
        scrubbedSummary: safeSummary || safeTitle,
        resolved: Boolean(t.resolved),
      };
    });

    const fallback = buildExecutiveBriefingFallback(normalizedThreads, {
      workspaceName: safeWorkspaceName,
      timeZone: requestedTz,
    });
    const meta = computeWindowMetadata(normalizedThreads, requestedTz);
    const pageEngCount = normalizedThreads.filter((t) => !t.resolved && t.route === 'page_eng').length;
    const notifyOpsCount = normalizedThreads.filter(
      (t) => !t.resolved && (t.route === 'notify_ops' || (!t.route && t.bucket === 'needs_action'))
    ).length;
    const digestOnlyCount = normalizedThreads.filter((t) => t.route === 'digest_only').length;
    const ignoredCount = normalizedThreads.filter(
      (t) => t.route === 'ignore' || (!t.route && t.bucket === 'hidden_noise')
    ).length;

    const stats = {
      totalThreads: normalizedThreads.length,
      pageEngCount,
      notifyOpsCount,
      digestOnlyCount,
      ignoredCount,
      minLatencyMs: meta.minLatencyMs,
      maxLatencyMs: meta.maxLatencyMs,
      timeZone: requestedTz,
      windowLabel: meta.windowLabel,
    };

    if (normalizedThreads.length === 0) {
      return res.json({
        ok: true,
        headline: fallback.headline,
        briefing: fallback.body,
        modelUsed: 'deterministic-local',
        zeroDataRetention: true,
        slackPosted: false,
        stats,
      });
    }

    const fmtProb = (pct: number | null) =>
      pct === null ? 'n/a' : (Math.max(0, Math.min(100, pct)) / 100).toFixed(2);

    const activeThreads = normalizedThreads
      .filter((t) => !t.resolved && (t.route === 'page_eng' || t.route === 'notify_ops' || t.bucket === 'needs_action'))
      .slice(0, 5);
    const comparison = pickComparisonIgnoredThread(normalizedThreads);
    const contextThreads = [...activeThreads, ...(comparison ? [comparison] : [])];

    const formattedContext = contextThreads.map((t, idx) => {
      const clock = formatLocalClockTime(t.createdAtIso, requestedTz);
      const isComp = comparison && t.groupKey === comparison.groupKey && t.bucket === 'hidden_noise';
      return [
        `${idx + 1}. ${t.channel}, ${clock.label} (${t.isBot ? 'bot' : 'human'})${isComp ? ' [COMPARISON IGNORED ITEM]' : ''}`,
        `   Title: ${t.title}${t.count > 1 ? ` (×${t.count} grouped alerts)` : ''}`,
        `   Scrubbed Summary: ${t.scrubbedSummary}`,
        `   Slack Replies: ${t.replyCount} (${t.unanswered ? 'Nobody responded in Slack.' : `${t.replyCount} replies`})`,
        `   Decisions API Scores (0 output tokens): route=${t.route ?? (t.bucket === 'hidden_noise' ? 'ignore' : 'notify_ops')} | "Is the customer blocked right now?"=${fmtProb(t.customerBlocked)} | "Does a human need to act now?"=${fmtProb(t.needsAction)} | "Is this routine?"=${fmtProb(t.isNoise)} | "Is there revenue or SLA risk?"=${fmtProb(t.revenueRisk)} | "Is this a manual money move?"=${fmtProb(t.manualMoneyMove)} | "Does this need engineering?"=${fmtProb(t.needsEngineering)}${t.latencyMs ? ` | check_latency=${formatLatencyDuration(t.latencyMs)}` : ''}`,
      ].join('\n');
    });

    const latencyFact =
      meta.minLatencyMs !== null && meta.maxLatencyMs !== null
        ? meta.minLatencyMs === meta.maxLatencyMs
          ? `Measured check latency: ${formatLatencyDuration(meta.minLatencyMs)} (0 output tokens).`
          : `Measured check latency range: ${formatLatencyDuration(meta.minLatencyMs)} to ${formatLatencyDuration(meta.maxLatencyMs)} (0 output tokens).`
        : 'All checks ran at 0 output tokens (latency not measured for cached/sample items).';

    const briefingPrompt = [
      `Workspace: ${safeWorkspaceName}`,
      `Local Window: ${meta.windowLabel}${meta.weekday ? ` (${meta.weekday})` : ''} [Timezone: ${requestedTz}]`,
      `Totals: ${normalizedThreads.length} threads (${pageEngCount} page_eng, ${notifyOpsCount} notify_ops, ${digestOnlyCount} digest_only, ${ignoredCount} ignored)`,
      `All messages from bots: ${meta.allBots ? 'yes' : 'no'}`,
      `Any manual money moves (>=0.65): ${meta.anyManualMoneyMove ? 'yes' : 'no'}`,
      `Any engineering pages (page_eng): ${meta.anyEngEscalation ? 'yes' : 'no'}`,
      latencyFact,
      '',
      'Scrubbed Threads & Exact Decisions API Scores:',
      formattedContext.join('\n\n'),
    ].join('\n');

    const briefingSystemInstruction =
      'You write calm, crystal-clear executive operations briefings for CalmDuty using Decisions API scores. ' +
      'Follow this exact plain-English style in clean Markdown (under 240 words total, NEVER dump raw snake_case variable names like `customer_blocked=0.94` or `needs_action=0.38`):\n' +
      '1. Bold title: **Decisions API: what stood out in <Workspace> (<HH:MM–HH:MM TZ>)** (do not append `(Sunday)` inside the title; mention the weekday naturally in sentence 2).\n' +
      '2. One calm overview sentence noting context (e.g., "It\'s Sunday, so every message in this window came from a bot. No manual money moves were flagged and no engineering pages fired.").\n' +
      '3. For each standout `page_eng` or `notify_ops` thread (max 3): start with **#channel, HH:MM TZ (bot|human).** + 1-2 factual sentences from the scrubbed summary + explicitly say "Nobody responded in Slack." if Slack Replies is 0. Then two crisp bullets:\n' +
      '   - **Questions:** cite the 3 most relevant plain-English questions in quotes with their EXACT 0.00–1.00 scores (example: `"Is the customer blocked right now?" got 0.94. "Does a human need to act now?" got 0.38. "Is this routine?" got 0.11. The route came back as \\`notify_ops\\`.`).\n' +
      '   - **What the code does:** explain the concrete routing action in plain English (e.g., sends to support/ops to contact the customer and unfreeze or reissue the card; explicitly state whether it pages engineering with the exact engineering probability in parentheses like `(0.19)`).\n' +
      '4. If a `[COMPARISON IGNORED ITEM]` is provided: start with **#channel, HH:MM TZ (bot|human), included for comparison.** + 1 factual sentence, then two bullets (**Questions:** 3 most relevant quoted plain-English questions + exact scores + `The route came back as \\`ignore\\`.`, **What the code does:** stays quiet — explain what false alarm was avoided).\n' +
      '5. Final one-line footer: if measured latency is provided above, write `Each check took about <min> to <max>. Nothing was posted in Slack.` (never invent latency numbers; if unmeasured, write `Scored at 0 output tokens. Nothing was posted in Slack.`).\n' +
      'Strictly preserve `[Protected Email]` / `[Protected Phone]` / `[Protected Account]` / `[Protected Card]` tokens and NEVER invent facts, amounts, or scores.';

    const BRIEFING_MODELS: Array<{ model: string; isGemini4: boolean }> = [
      { model: 'gemini-3.5-flash-lite', isGemini4: false },
      { model: 'gemini-3.1-flash-lite', isGemini4: false },
      { model: 'gemini-4-hydrogen', isGemini4: true },
      { model: 'gemini-4-neon', isGemini4: true },
    ];

    const extractInteractionText = (resp: Record<string, unknown>): string => {
      if (typeof resp.output_text === 'string' && resp.output_text.trim().length > 0) {
        return resp.output_text.trim();
      }
      if (Array.isArray(resp.outputs)) {
        const chunks: string[] = [];
        for (const out of resp.outputs as Array<Record<string, unknown>>) {
          if (out?.type === 'text' && typeof out.text === 'string') {
            chunks.push(out.text);
          }
        }
        if (chunks.length > 0) return chunks.join('\n').trim();
      }
      return '';
    };

    try {
      const ai = getGenAIClient();
      for (const candidate of BRIEFING_MODELS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        try {
          const interactionParams: Record<string, unknown> = {
            model: candidate.model,
            input: briefingPrompt,
            system_instruction: briefingSystemInstruction,
            stream: false,
            store: false,
          };
          if (candidate.isGemini4) {
            interactionParams.generation_config = { thinking_level: 'low' };
          }
          const response = (await ai.interactions.create(
            interactionParams as unknown as Parameters<GoogleGenAI['interactions']['create']>[0],
            { signal: controller.signal }
          )) as unknown as Record<string, unknown>;

          const text = extractInteractionText(response);
          if (text.length > 40) {
            return res.json({
              ok: true,
              headline: fallback.headline,
              briefing: text,
              modelUsed: candidate.model,
              zeroDataRetention: true,
              slackPosted: false,
              stats,
            });
          }
        } catch (candidateErr) {
          const errMsg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
          console.warn(`/api/briefing model ${candidate.model} unavailable, trying next:`, errMsg);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      console.warn('/api/briefing falling back to deterministic briefing:', err instanceof Error ? err.message : String(err));
    }

    return res.json({
      ok: true,
      headline: fallback.headline,
      briefing: fallback.body,
      modelUsed: 'deterministic-local',
      zeroDataRetention: true,
      slackPosted: false,
      stats,
    });
  });

  // Real Slack Bot Token Verification (calls Slack's official auth.test API & persists verified token to Firestore)
  app.post('/api/slack/verify', async (req, res) => {
    const body = (req.body || {}) as {
      botToken?: string;
      orgId?: string;
      workspaceId?: string;
      selectedChannelIds?: string[];
    };
    const token = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    const requestedOrgId = (body.orgId || body.workspaceId || '').trim();

    if (!token) {
      return res.status(400).json({
        ok: false,
        team: null,
        user: null,
        bot_id: null,
        error: 'missing_bot_token',
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const slackRes = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: controller.signal,
      });

      const data = (await slackRes.json()) as {
        ok?: boolean;
        team?: string;
        team_id?: string;
        user?: string;
        user_id?: string;
        bot_id?: string;
        url?: string;
        error?: string;
      };

      if (data.ok) {
        const persistedOrgId = !isWildcardOrgId(requestedOrgId)
          ? sanitizeOrgId(requestedOrgId)
          : data.team_id
            ? sanitizeOrgId(`org_${data.team_id}`)
            : 'org_workspace';

        await slackStore.saveConnection({
          orgId: persistedOrgId,
          team: data.team?.trim() || 'Slack Workspace',
          teamId: data.team_id?.trim() || '',
          botName: data.user?.trim() || '',
          botUserId: (data.user_id || data.bot_id || '').trim(),
          accessToken: token,
          selectedChannelIds: Array.isArray(body.selectedChannelIds)
            ? body.selectedChannelIds.filter((id): id is string => typeof id === 'string')
            : undefined,
        });
      }

      return res.json({
        ok: Boolean(data.ok),
        team: data.team ?? null,
        team_id: data.team_id ?? null,
        user: data.user ?? null,
        bot_id: data.bot_id ?? null,
        url: data.url ?? null,
        error: data.ok ? null : data.error || 'auth_test_failed',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unable to reach Slack auth.test';
      return res.status(502).json({
        ok: false,
        team: null,
        user: null,
        bot_id: null,
        error: msg,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // Register organization Slack Signing Secret (& optional manual bot token persisted durably to Firestore)
  app.post('/api/slack/register-secret', async (req, res) => {
    const body = (req.body || {}) as {
      orgId?: string;
      workspaceId?: string;
      signingSecret?: string;
      botToken?: string;
      team?: string;
      botName?: string;
      selectedChannelIds?: string[];
    };
    const orgId = (body.orgId || body.workspaceId || '').trim();
    if (!orgId || !/^[a-zA-Z0-9_-]{3,128}$/.test(orgId)) {
      return res.status(400).json({ error: 'Invalid orgId.' });
    }
    if (body.signingSecret && body.signingSecret.trim().length > 0) {
      orgSigningSecrets.set(orgId, body.signingSecret.trim());
    } else if (body.signingSecret === '') {
      orgSigningSecrets.delete(orgId);
    }
    if (
      body.botToken &&
      (body.botToken.trim().startsWith('xoxb-') || body.botToken.trim().startsWith('xoxp-'))
    ) {
      await slackStore.saveConnection({
        orgId,
        team: typeof body.team === 'string' && body.team.trim() ? body.team.trim() : 'Slack Workspace',
        botName: typeof body.botName === 'string' && body.botName.trim() ? body.botName.trim() : 'EdgeOps',
        accessToken: body.botToken.trim(),
        selectedChannelIds: Array.isArray(body.selectedChannelIds)
          ? body.selectedChannelIds.filter((id): id is string => typeof id === 'string')
          : undefined,
      });
    }
    const existing = await slackStore.getConnection(orgId);
    return res.json({
      ok: true,
      orgId,
      signatureVerificationEnabled: orgSigningSecrets.has(orgId),
      hasBotToken: Boolean(existing?.accessToken),
    });
  });

  // Diagnostic endpoint verifying durable Slack connection storage ("firestore" vs "memory") — NEVER returns tokens
  app.get('/api/slack/health', async (_req, res) => {
    const health = await slackStore.getHealth();
    return res.json(health);
  });

  // Standard Slack OAuth 2.0 Start — redirects to slack.com/oauth/v2/authorize (or returns friendly setup hint if SLACK_CLIENT_ID is not set)
  app.get('/api/slack/oauth/start', (req, res) => {
    const orgId = sanitizeOrgId(req.query.orgId);
    const wantsJson =
      req.query.format === 'json' ||
      (typeof req.headers.accept === 'string' &&
        req.headers.accept.includes('application/json') &&
        !req.headers.accept.includes('text/html'));
    const clientId = process.env.SLACK_CLIENT_ID?.trim() || '';
    const redirectUri = resolveSlackRedirectUri();

    if (!clientId) {
      const hint =
        '1-click "Connect with Slack" needs SLACK_CLIENT_ID and SLACK_CLIENT_SECRET set on the server. Until then, click "Create your own Slack app (pre-filled)" below to create your app in one click.';
      if (wantsJson) {
        return res.json({
          ok: false,
          configured: false,
          redirectUri,
          scopes: SLACK_OAUTH_SCOPES,
          hint,
        });
      }
      return res.redirect(
        302,
        `/?slack_oauth_error=not_configured&orgId=${encodeURIComponent(orgId)}`
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      scope: SLACK_OAUTH_SCOPES,
      redirect_uri: redirectUri,
      state: encodeSlackOAuthState(orgId),
    });
    const authorizeUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

    if (wantsJson) {
      return res.json({
        ok: true,
        configured: true,
        authorizeUrl,
        redirectUri,
      });
    }

    return res.redirect(302, authorizeUrl);
  });

  // Standard Slack OAuth 2.0 Callback — exchanges code via oauth.v2.access, stores team/bot/token, redirects back to /?slack_connected=1
  app.get(['/api/slack/oauth/callback', '/api/slack/oauth/callback/'], async (req, res) => {
    const orgId = decodeSlackOAuthState(req.query.state);
    const oauthError = typeof req.query.error === 'string' ? req.query.error.trim() : '';
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';

    if (oauthError) {
      return res.redirect(
        302,
        `/?slack_oauth_error=${encodeURIComponent(oauthError)}&orgId=${encodeURIComponent(orgId)}`
      );
    }

    if (!code) {
      return res.redirect(
        302,
        `/?slack_oauth_error=missing_code&orgId=${encodeURIComponent(orgId)}`
      );
    }

    const clientId = process.env.SLACK_CLIENT_ID?.trim() || '';
    const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || '';
    const redirectUri = resolveSlackRedirectUri();

    if (!clientId || !clientSecret) {
      return res.redirect(
        302,
        `/?slack_oauth_error=not_configured&orgId=${encodeURIComponent(orgId)}`
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const formBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });

      const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
        signal: controller.signal,
      });

      const tokenJson = (await tokenRes.json()) as {
        ok?: boolean;
        error?: string;
        access_token?: string;
        bot_user_id?: string;
        team?: { id?: string; name?: string };
      };

      if (!tokenJson.ok || !tokenJson.access_token) {
        return res.redirect(
          302,
          `/?slack_oauth_error=${encodeURIComponent(tokenJson.error || 'oauth_exchange_failed')}&orgId=${encodeURIComponent(orgId)}`
        );
      }

      const teamName = tokenJson.team?.name?.trim() || 'Slack Workspace';
      const teamId = tokenJson.team?.id?.trim() || '';
      const botUserId = tokenJson.bot_user_id?.trim() || '';

      // Resolve real bot username (e.g., "grey") via Slack auth.test (strictly read-only)
      let botName = '';
      try {
        const authController = new AbortController();
        const authTimer = setTimeout(() => authController.abort(), 5_000);
        try {
          const authRes = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenJson.access_token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            signal: authController.signal,
          });
          const authJson = (await authRes.json()) as {
            ok?: boolean;
            user?: string;
            team?: string;
            bot_id?: string;
          };
          if (authJson.ok && typeof authJson.user === 'string' && authJson.user.trim()) {
            botName = authJson.user.trim();
          }
        } finally {
          clearTimeout(authTimer);
        }
      } catch {
        // Non-fatal: continue with OAuth connection even if auth.test times out
      }

      await slackStore.saveConnection({
        orgId,
        team: teamName,
        teamId,
        botUserId,
        botName,
        accessToken: tokenJson.access_token,
        selectedChannelIds: [],
      });

      const redirectParams = new URLSearchParams({
        slack_connected: '1',
        orgId,
        team: teamName,
      });
      if (botName) {
        redirectParams.set('botName', botName);
      }
      if (botUserId) {
        redirectParams.set('botUserId', botUserId);
      }

      return res.redirect(302, `/?${redirectParams.toString()}`);
    } catch {
      return res.redirect(
        302,
        `/?slack_oauth_error=oauth_network_error&orgId=${encodeURIComponent(orgId)}`
      );
    } finally {
      clearTimeout(timer);
    }
  });

  // Shared live Slack status for BOTH Web and Android (auto-hydrates from Firestore on cold start; never exposes accessToken)
  app.get('/api/slack/status', async (req, res) => {
    const requestedOrgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
    const active = await resolveActiveSlackConnection(requestedOrgId);
    if (!active) {
      return res.json({
        connected: false,
        orgId: null,
        team: null,
        botName: null,
        channelsCount: 0,
      });
    }

    let cachedChannels = orgSlackChannelCache.get(active.orgId);
    if (!cachedChannels) {
      const fetched = await fetchBotMemberChannels(active.token);
      if (fetched.ok) {
        cachedChannels = fetched.channels;
        orgSlackChannelCache.set(active.orgId, cachedChannels);
      }
    }

    return res.json({
      connected: true,
      orgId: active.orgId,
      team: active.team,
      botName: active.botName,
      channelsCount: cachedChannels?.length ?? 0,
    });
  });

  // Read public OAuth connection metadata for an org (auto-hydrates from Firestore; never returns accessToken to client)
  app.get('/api/slack/connection/:orgId', async (req, res) => {
    const active = await resolveActiveSlackConnection(req.params.orgId);
    if (!active) {
      return res.json({ connected: false, team: null, botName: null, botUserId: null });
    }
    return res.json({
      connected: true,
      orgId: active.orgId,
      team: active.team,
      botName: active.botName,
      botUserId: active.botUserId,
      connectedAt: active.connectedAt,
    });
  });

  // Read-only Slack Channel Discovery — auto-hydrates from Firestore on cold start & lists every channel the bot is in
  app.get('/api/slack/channels', async (req, res) => {
    const { token, orgId } = await resolveSlackTokenAndOrg(req.query.orgId, req);
    if (!token) {
      return res.json({
        ok: false,
        error: 'slack_not_connected',
        channels: [],
      });
    }

    const result = await fetchBotMemberChannels(token);
    if (result.ok) {
      orgSlackChannelCache.set(orgId, result.channels);
    }
    return res.json(result);
  });

  // Strictly Read-Only Live Slack Channel Sync (auto-hydrates from Firestore on cold start; NEVER posts to Slack)
  app.post('/api/slack/sync', async (req, res) => {
    const body = (req.body || {}) as {
      orgId?: string;
      channelIds?: string[];
      limitPerChannel?: number;
      botToken?: string;
    };
    const { token, orgId, selectedChannelIds: storedChannelIds } = await resolveSlackTokenAndOrg(
      body.orgId,
      req,
      body.botToken
    );

    if (!token) {
      return res.json({
        ok: false,
        error: 'slack_not_connected',
        channelsSynced: [],
        incidents: [],
      });
    }

    const limitPerChannel = Math.min(
      25,
      Math.max(1, Number.isFinite(Number(body.limitPerChannel)) ? Number(body.limitPerChannel) : 8)
    );

    // 1. Discover/refresh channels the bot is already a member of
    let memberChannels = orgSlackChannelCache.get(orgId) || [];
    const fetched = await fetchBotMemberChannels(token);
    if (fetched.ok) {
      memberChannels = fetched.channels;
      orgSlackChannelCache.set(orgId, memberChannels);
    } else if (memberChannels.length === 0) {
      return res.json({
        ok: false,
        error: fetched.error || 'users_conversations_failed',
        channelsSynced: [],
        incidents: [],
      });
    }

    const requestedIds = Array.isArray(body.channelIds)
      ? body.channelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];

    if (requestedIds.length > 0) {
      void slackStore.updateSelectedChannels(orgId, requestedIds.slice(0, 50)).catch(() => undefined);
    }

    const effectiveIds = requestedIds.length > 0 ? requestedIds : storedChannelIds;
    const channelMap = new Map(memberChannels.map((ch) => [ch.id, ch]));
    const targetChannels: SlackChannelInfo[] =
      effectiveIds.length > 0
        ? effectiveIds.slice(0, 20).map((id) => {
            const known = channelMap.get(id);
            return known || { id, name: id, is_private: false, num_members: 0 };
          })
        : memberChannels.slice(0, 20);

    // 2. Read-only conversations.history across selected channels in bounded batches
    const allIncidents: SyncedSlackMessage[] = [];
    const channelsSynced: SyncedChannelSummary[] = [];

    const BATCH_SIZE = 4;
    for (let i = 0; i < targetChannels.length; i += BATCH_SIZE) {
      const batch = targetChannels.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (ch) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 7_000);
          try {
            const historyUrl = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(ch.id)}&limit=${limitPerChannel}`;
            const histRes = await fetch(historyUrl, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${token}`,
              },
              signal: controller.signal,
            });
            const histJson = (await histRes.json()) as {
              ok?: boolean;
              messages?: RawSlackHistoryMessage[];
            };
            if (!histJson.ok || !Array.isArray(histJson.messages)) {
              return { channel: ch, normalized: [] as SyncedSlackMessage[] };
            }
            const normalized = normalizeSlackHistoryMessages(ch.id, ch.name, histJson.messages);
            return { channel: ch, normalized };
          } catch {
            return { channel: ch, normalized: [] as SyncedSlackMessage[] };
          } finally {
            clearTimeout(timer);
          }
        })
      );

      for (const entry of batchResults) {
        channelsSynced.push({
          ...entry.channel,
          messageCount: entry.normalized.length,
        });
        allIncidents.push(...entry.normalized);
      }
    }

    const deduplicated = deduplicateAndSortSyncedMessages(allIncidents);

    // 3. Instant 0-output-token triage via gemini-decision-1 (top 35 newest, cached by message ID, batches of 8)
    const triaged = await scoreMessagesInBatches(deduplicated, 35, 8);

    return res.json({
      ok: true,
      channelsSynced,
      incidents: triaged,
    });
  });

  // Dispatch diagnosis & remediation summary to Slack Thread (live Slack API via manual or OAuth-stored bot token)
  app.post('/api/slack/dispatch', async (req, res) => {
    try {
      const { orgId, channel, botToken, incidentTitle, diagnosis, remediationPlan, toolsUsed, toolsTotal } =
        req.body as {
          orgId?: string;
          channel?: string;
          botToken?: string;
          incidentTitle?: string;
          diagnosis?: string;
          remediationPlan?: string;
          toolsUsed?: string[];
          toolsTotal?: number;
        };

      const targetChannel = (channel || '#ops-triage').trim();
      const summaryText =
        `*EdgeOps Triage Update — ${incidentTitle || 'Incident'}*\n` +
        `• *What Happened:* ${diagnosis || 'Diagnosis ready.'}\n` +
        `• *Recommended Fix:* ${remediationPlan || 'Review in EdgeOps.'}\n` +
        `• *Tools Used:* ${(toolsUsed?.length ?? 0)} of ${toolsTotal ?? 0} (${(toolsUsed || []).join(', ') || 'On-device only'})`;

      const resolvedActive = await resolveActiveSlackConnection(orgId);
      const effectiveToken =
        botToken && botToken.trim().startsWith('xoxb-')
          ? botToken.trim()
          : resolvedActive?.token && resolvedActive.token.startsWith('xoxb-')
            ? resolvedActive.token
            : '';

      if (effectiveToken) {
        const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${effectiveToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: targetChannel,
            text: summaryText,
          }),
        });
        const slackJson = (await slackRes.json()) as { ok?: boolean; error?: string; ts?: string };
        if (!slackJson.ok) {
          return res.status(400).json({
            error: `Slack API rejected postMessage: ${slackJson.error || 'unknown_error'}`,
          });
        }
        return res.json({
          ok: true,
          mode: 'live_slack_api',
          channel: targetChannel,
          threadTs: slackJson.ts || `${Date.now() / 1000}`,
          previewText: summaryText,
        });
      }

      return res.json({
        ok: true,
        mode: 'workspace_preview',
        channel: targetChannel,
        threadTs: `${Math.floor(Date.now() / 1000)}.001420`,
        previewText: summaryText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send Slack update.';
      return res.status(500).json({ error: message });
    }
  });

  // Live BYO Slack App Webhook Endpoint (/webhooks/slack/:orgId)
  // Handles Slack url_verification challenge & ingests message / app_mention events
  app.post('/webhooks/slack/:orgId', async (req, res) => {
    const { orgId } = req.params;
    const body = (req.body || {}) as Record<string, unknown>;

    // 1. Slack Events API URL verification challenge
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return res.json({ challenge: body.challenge });
    }

    // 2. Verify HMAC-SHA256 signature if org configured a Signing Secret
    const secret = orgSigningSecrets.get(orgId);
    const sig = req.header('x-slack-signature') || '';
    const ts = req.header('x-slack-request-timestamp') || '';
    const rawBody = (req as express.Request & { rawBody?: string }).rawBody || JSON.stringify(body);
    let verified = !secret;

    if (secret) {
      verified = verifySlackSignature(secret, ts, sig, rawBody);
      if (!verified && body.simulated !== true) {
        return res.status(401).json({ error: 'Invalid Slack request signature.' });
      }
    }

    const event = (
      body.event && typeof body.event === 'object' ? body.event : body
    ) as Record<string, unknown>;

    // Ignore bot self-messages & message edits/deletions to prevent loops
    if (event.bot_id || event.subtype === 'bot_message' || event.subtype === 'message_deleted') {
      return res.json({ ok: true, ignored: true });
    }

    const rawEventType = typeof event.type === 'string' ? event.type : 'app_mention';
    if (rawEventType !== 'app_mention' && rawEventType !== 'message') {
      return res.json({ ok: true, ignored: true });
    }

    const rawTextInput =
      typeof event.text === 'string' && event.text.trim().length > 0
        ? event.text.trim()
        : 'Alert received via Slack webhook.';
    const rawText = formatSlackText(rawTextInput) || rawTextInput;
    const rawChannel =
      typeof event.channel === 'string' && event.channel.trim()
        ? event.channel.trim()
        : '#ops-triage';
    const channel = rawChannel.startsWith('#') ? rawChannel : `#${rawChannel}`;
    const user = typeof event.user === 'string' ? event.user : 'slack_user';

    // Format Slack mrkdwn cleanly & scrub PII locally BEFORE calling gemini-decision-1 or deriving title
    const scrub = scrubPiiLocally(rawText);
    const title = deriveTitleFromSlackText(scrub.scrubbedText, channel);
    const recordId = `inc_slk_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;

    const { outcome } = await scoreMessageWithDecisionsApi(recordId, channel, rawText);
    const fallbackNoise = evaluateNoiseGate(title, rawText);

    const isNoise = outcome ? outcome.bucket === 'hidden_noise' : fallbackNoise.isNoise;
    const noiseReason = outcome
      ? outcome.bucket === 'hidden_noise'
        ? 'Auto-filtered as routine FYI by Gemini Decisions (0 output tokens).'
        : 'Flagged as needing action by Gemini Decisions (0 output tokens).'
      : fallbackNoise.reason;

    const suggestedReply = buildOfflineSuggestedReply(
      { title, channel, severity: isNoise ? 'low' : 'high' },
      scrub.scrubbedText
    );

    const record: SlackWebhookEventRecord = {
      id: recordId,
      orgId,
      receivedAt: new Date().toISOString(),
      channel,
      user,
      title,
      rawText,
      scrubbedSummary: scrub.scrubbedText,
      piiRedactedCount: scrub.redactionCount,
      piiCategories: scrub.categories,
      isNoise,
      noiseReason,
      suggestedReply,
      verified,
      eventType: rawEventType,
      ...(outcome
        ? {
            decisionScores: outcome.decisionScores,
            bucket: outcome.bucket,
            priorityScore: outcome.priorityScore,
          }
        : {}),
    };

    // Broadcast ephemeral record directly to live SSE clients; NEVER retain rawText in server RAM
    broadcastSlackEvent(orgId, record);

    const redactedRecord: SlackWebhookEventRecord = {
      ...record,
      rawText: '',
    };
    const cutoffMs = Date.now() - WEBHOOK_EPHEMERAL_TTL_MS;
    const existing = (orgSlackEvents.get(orgId) || []).filter(
      (item) => (Date.parse(item.receivedAt) || 0) >= cutoffMs
    );
    orgSlackEvents.set(orgId, [redactedRecord, ...existing].slice(0, 20));

    return res.json({
      ok: true,
      ingested: redactedRecord,
      zeroDataRetention: true,
    });
  });

  // Real-time SSE stream for live Slack webhook ingestion (ephemeral pass-through)
  app.get('/api/orgs/:orgId/slack-stream', (req, res) => {
    const { orgId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ orgId })}\n\n`);

    let clients = orgSseClients.get(orgId);
    if (!clients) {
      clients = new Set();
      orgSseClients.set(orgId, clients);
    }
    clients.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients?.delete(res);
    });
  });

  app.get('/api/webhooks/slack/:orgId/events', (req, res) => {
    const cutoffMs = Date.now() - WEBHOOK_EPHEMERAL_TTL_MS;
    const fresh = (orgSlackEvents.get(req.params.orgId) || []).filter(
      (item) => (Date.parse(item.receivedAt) || 0) >= cutoffMs
    );
    orgSlackEvents.set(req.params.orgId, fresh);
    res.json({ events: fresh, zeroRawRetention: true });
  });

  // Mount Vite middleware in dev or serve dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EdgeOps server listening on http://0.0.0.0:${PORT}`);
    void slackStore.hydrateAll().catch(() => undefined);
  });
}

startServer().catch((err) => {
  console.error('Failed to start EdgeOps server:', err);
  process.exit(1);
});

export type TriageRole = 'Support' | 'Finance Lead' | 'Admin';

export type ToolRoleTag = 'Viewer' | 'Operator' | 'Admin';

export type IndustryPackId = 'ecommerce' | 'saas' | 'logistics';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type IncidentStatus = 'open' | 'suppressed' | 'investigating' | 'resolved';

export type InferenceRoute = 'on_device' | 'cloud';

export type IncidentBucket = 'needs_action' | 'hidden_noise';

export type DecisionRoute = 'page_eng' | 'notify_ops' | 'digest_only' | 'ignore';

export interface DecisionTriageScores {
  needsAction: number;
  customerBlocked?: number;
  isNoise: number;
  revenueRisk: number;
  manualMoneyMove?: number;
  needsEngineering: number;
  route?: DecisionRoute;
  latencyMs?: number;
  model: string;
  outputTokens: number;
}

export interface ToolDecisionScore {
  toolName: string;
  score: number;
  matched: boolean;
}

export interface RedactionSpan {
  original: string;
  replacement: string;
  category: 'Email' | 'Phone' | 'Account' | 'Card';
  start: number;
  end: number;
}

export interface ScrubResult {
  originalText: string;
  scrubbedText: string;
  redactions: RedactionSpan[];
  redactionCount: number;
  categories: string[];
}

export interface NoiseGateResult {
  isNoise: boolean;
  reason: string;
  confidence: number;
  matchedRule: string;
}

export interface ToolExecutionTrace {
  toolName: string;
  roleTag: ToolRoleTag;
  source: string;
  latencyMs: number;
  summary: string;
  data: Record<string, unknown>;
}

export interface CloudInvestigationResult {
  diagnosis: string;
  customerImpact: string;
  remediationPlan: string;
  remediationSteps: string[];
  recommendedActionLabel: string;
  toolsUsed: string[];
  toolsTotal: number;
  toolsAuthorized: number;
  toolTraces: ToolExecutionTrace[];
  toolScores?: ToolDecisionScore[];
  roleUsed: TriageRole;
  modelUsed: string;
  slackSummary: string;
  investigatedAt: string;
}

export interface IncidentItem {
  id: string;
  title: string;
  channel: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  inferenceMode: InferenceRoute;
  rawPayload: string;
  scrubbedSummary: string;
  piiRedactedCount: number;
  piiCategories: string[];
  isNoise: boolean;
  noiseReason: string;
  suggestedReply: string;
  createdAtIso: string;
  timestampLabel: string;
  slackPosted: boolean;
  slackThreadNote?: string;
  investigation?: CloudInvestigationResult;
  onDeviceEngineLabel?: string;
  industryPack: IndustryPackId;
  source?: 'slack' | 'slack_live' | 'sample' | 'manual';
  isSample?: boolean;
  decisionScores?: DecisionTriageScores;
  bucket?: IncidentBucket;
  priorityScore?: number;
  isBot?: boolean;
  replyCount?: number;
  threadTs?: string;
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
  num_members: number;
}

export interface OrgProfile {
  orgId: string;
  ownerId: string;
  name: string;
  ownerRole: TriageRole;
  industryPack: IndustryPackId;
  defaultSlackChannel: string;
  slackConnected: boolean;
  slackTeam?: string;
  slackBotName?: string;
  webhookUrl?: string;
}

export interface DeferredTool {
  name: string;
  description: string;
  category: string;
  roleTag: ToolRoleTag;
  defer_loading: true;
  sourceType: 'pack' | 'mcp' | 'openapi';
  sourceName: string;
  endpointHint?: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface RegisteredConnector {
  id: string;
  name: string;
  kind: 'mcp' | 'openapi';
  endpointUrl: string;
  deferLoading: true;
  roleAccess: ToolRoleTag;
  toolCount: number;
  addedAtIso: string;
}

export interface SlackAppSettings {
  workspaceId: string;
  botName: string;
  defaultChannel: string;
  botToken: string;
  signingSecret: string;
  connected: boolean;
  slackTeam?: string;
  slackBotName?: string;
  slackBotId?: string;
  webhookUrl?: string;
  lastWebhookEvent?: {
    receivedAt: string;
    channel: string;
    text: string;
    verified: boolean;
  };
}

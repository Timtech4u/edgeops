import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOfflineSuggestedReply,
  evaluateNoiseGate,
  scrubPiiLocally,
} from './privacyShield';
import {
  SlackConnectionStore,
  decryptTokenForOrg,
  encryptTokenForOrg,
  fromFirestoreDocument,
  isEncryptedTokenValue,
  resolveFirestoreTarget,
  toFirestoreFields,
  toPublicSlackConnection,
} from './slackStore';
import {
  INDUSTRY_PACKS,
  createMcpServerTools,
  filterToolsByRole,
  generateSlackManifestYaml,
  humanizeToolName,
  humanizeToolTitle,
  parseOpenApiToTools,
  SAMPLE_OPENAPI_SPEC,
} from './toolRegistry';
import { createSimulatedAlertBurst, getInitialIncidentsForPack } from './sampleAlerts';
import {
  TRIAGE_DECISION_QUESTIONS,
  buildToolDecisionQuestions,
  computeTriageDecision,
  getPriorityBadge,
  getRouteBadge,
  selectMatchedToolsFromDecisions,
  sortIncidentsByTriage,
} from './decisions';
import {
  deduplicateAndSortSyncedMessages,
  formatLocalClockTime,
  formatSlackText,
  normalizeSlackHistoryMessages,
  syncedSlackMessageToIncident,
} from './slackSync';
import {
  computeOccurrenceDiffNote,
  extractEntityKey,
  groupIncidents,
} from './incidentGroups';
import {
  buildExecutiveBriefingFallback,
  buildOfflineWorkspaceReply,
  buildWorkspaceThreadSummaries,
  detectProactiveBriefing,
  matchReferencedThreadsInText,
} from './copilotBriefing';
import type { IncidentItem } from '../types/edgeops';

test('Local PII Firewall scrubs emails, phones, cards, and account/wallet IDs cleanly', () => {
  const input =
    'Contact maya.chen@northstar-goods.io or (415) 890-2341 for acct_9948210K and wallet 0x71C7656EC7ab88b098defB751B7401B5f6d8976F on card 4532-8910-4421-9004.';
  const result = scrubPiiLocally(input);

  assert.equal(result.redactionCount, 5);
  assert.doesNotMatch(result.scrubbedText, /maya\.chen@northstar-goods\.io/);
  assert.doesNotMatch(result.scrubbedText, /415.*890.*2341/);
  assert.doesNotMatch(result.scrubbedText, /acct_9948210K/);
  assert.doesNotMatch(result.scrubbedText, /4532-8910-4421-9004/);
  assert.match(result.scrubbedText, /\[Protected Email\]/);
  assert.match(result.scrubbedText, /\[Protected Phone\]/);
  assert.match(result.scrubbedText, /\[Protected Account\]/);
  assert.match(result.scrubbedText, /\[Protected Card\]/);

  const wrapped = scrubPiiLocally('VIP contact (312-555-0194, cus_441092X) escalated.');
  assert.equal(wrapped.scrubbedText, 'VIP contact ([Protected Phone], [Protected Account]) escalated.');
});

test('Local Noise Gate suppresses transient frontend/network noise while passing real alerts', () => {
  const noisy = evaluateNoiseGate(
    'ResizeObserver loop completed with undelivered notifications',
    'Safari layout resize'
  );
  assert.equal(noisy.isNoise, true);

  const signal = evaluateNoiseGate(
    'Duplicate checkout charge hold on EU payment gateway',
    'Gateway returned 504 during capture'
  );
  assert.equal(signal.isNoise, false);
});

test('Industry Packs each ship 45+ vendor-agnostic deferred tools with RBAC filtering', () => {
  for (const packId of ['ecommerce', 'saas', 'logistics'] as const) {
    const pack = INDUSTRY_PACKS[packId];
    assert.ok(pack.tools.length >= 45, `${packId} should have >= 45 tools, got ${pack.tools.length}`);
    assert.ok(pack.tools.every((t) => t.defer_loading === true));

    const supportTools = filterToolsByRole(pack.tools, 'Support');
    const financeTools = filterToolsByRole(pack.tools, 'Finance Lead');
    const adminTools = filterToolsByRole(pack.tools, 'Admin');

    assert.ok(supportTools.every((t) => t.roleTag === 'Viewer'));
    assert.ok(financeTools.every((t) => t.roleTag === 'Viewer' || t.roleTag === 'Operator'));
    assert.equal(adminTools.length, pack.tools.length);
    assert.ok(supportTools.length < financeTools.length);
    assert.ok(financeTools.length < adminTools.length);
  }
});

test('OpenAPI JSON importer converts paths to deferred tools with inferred RBAC tags and rejects invalid JSON', () => {
  const parsed = parseOpenApiToTools(SAMPLE_OPENAPI_SPEC, 'Operator');
  assert.equal(parsed.connectorName, 'Internal Billing & Ledger API');
  assert.equal(parsed.tools.length, 3);
  assert.ok(parsed.tools.every((t) => t.defer_loading === true));
  assert.equal(parsed.tools.find((t) => t.name === 'ledger_get_transaction_state')?.roleTag, 'Viewer');
  assert.equal(parsed.tools.find((t) => t.name === 'ledger_trigger_reconciliation')?.roleTag, 'Operator');
  assert.equal(parsed.tools.find((t) => t.name === 'admin_revoke_compromised_webhook_key')?.roleTag, 'Admin');

  assert.throws(() => parseOpenApiToTools('{ invalid json'), /Invalid JSON/);
  assert.throws(() => parseOpenApiToTools('{"openapi":"3.0.0"}'), /paths/);
});

test('Remote MCP Server helper & Slack Manifest generator produce valid deferred outputs', () => {
  const { connector, tools } = createMcpServerTools('Warehouse Telemetry MCP', 'https://mcp.internal.example/sse', 'Admin');
  assert.equal(connector.deferLoading, true);
  assert.equal(tools.length, 3);
  assert.ok(tools.every((t) => t.defer_loading === true));

  const yaml = generateSlackManifestYaml('ws_demo_01', 'https://edgeops.example.com/', 'OpsPilot');
  assert.match(yaml, /request_url: https:\/\/edgeops\.example\.com\/webhooks\/slack\/ws_demo_01/);
  assert.match(yaml, /display_name: OpsPilot/);
});

test('Sample alerts & simulated burst include suppressed noise and offline replies with zero PII', () => {
  const initial = getInitialIncidentsForPack('ecommerce');
  const suppressed = initial.filter((i) => i.isNoise);
  const active = initial.filter((i) => !i.isNoise);
  assert.equal(suppressed.length, 5);
  assert.ok(active.length >= 3);

  const burst = createSimulatedAlertBurst('ecommerce', 1);
  assert.equal(burst.length, 3);
  assert.equal(burst.filter((b) => b.isNoise).length, 2);

  const reply = buildOfflineSuggestedReply(active[0], active[0].scrubbedSummary);
  assert.ok(reply.length > 40);
  assert.doesNotMatch(reply, /maya\.chen@northstar-goods\.io/);
});

test('Human-readable tool formatter converts raw snake_case IDs into plain English labels', () => {
  assert.equal(humanizeToolName('payments_check_duplicate_holds'), 'Checked duplicate payment holds');
  assert.equal(humanizeToolName('payments_inspect_gateway_timeouts'), 'Inspected gateway payment timeouts');
  assert.equal(humanizeToolName('billing_reconcile_invoice'), 'Reconciled billing invoice');
  assert.equal(humanizeToolTitle('payments_check_duplicate_holds'), 'Check duplicate payment holds');
  assert.doesNotMatch(humanizeToolName('orders_lookup_order_status'), /_/);
});

test('Read-only Slack sync normalizes messages, ignores join/empty events, deduplicates, and runs on-device Privacy Shield', () => {
  const normalized = normalizeSlackHistoryMessages('C01OPS', 'ops-team', [
    { type: 'message', subtype: 'channel_join', ts: '1732200100.000100', text: '<@U1> has joined the channel' },
    { type: 'message', ts: '1732200105.000200', text: '   ' },
    {
      type: 'message',
      ts: '1732200200.000300',
      user: 'U_FIN',
      text: 'Customer billing@acme-shop.io (phone 415-555-0199) hit a 504 duplicate checkout charge.',
    },
    {
      type: 'message',
      ts: '1732200300.000400',
      bot_id: 'B_SENTRY',
      text: '',
      attachments: [
        {
          title: 'Sentry Alert: PaymentCaptureTimeout',
          text: 'Checkout API returned 504 on EU cluster for acct_99123K',
        },
      ],
    },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, 'slk_C01OPS_1732200200.000300');
  assert.equal(normalized[0].channel, '#ops-team');
  assert.equal(normalized[0].source, 'slack_live');
  assert.equal(normalized[1].id, 'slk_C01OPS_1732200300.000400');
  assert.match(normalized[1].rawText, /Sentry Alert: PaymentCaptureTimeout/);

  const deduped = deduplicateAndSortSyncedMessages([...normalized, normalized[0]]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].id, 'slk_C01OPS_1732200300.000400'); // newest first

  const incident = syncedSlackMessageToIncident(normalized[0], 'ecommerce');
  assert.equal(incident.source, 'slack_live');
  assert.equal(incident.inferenceMode, 'on_device');
  assert.equal(incident.piiRedactedCount, 2);
  assert.doesNotMatch(incident.scrubbedSummary, /billing@acme-shop\.io/);
  assert.doesNotMatch(incident.scrubbedSummary, /415-555-0199/);
  assert.match(incident.scrubbedSummary, /\[Protected Email\]/);
  assert.match(incident.scrubbedSummary, /\[Protected Phone\]/);
});

test('formatSlackText strips Slack mailto/URL/bold/divider markup cleanly before Privacy Shield runs', () => {
  const rawSlack = [
    '*Urgent Billing Alert* in <#C01FIN|finance-ops>',
    '----------',
    'Customer <mailto:maya.chen@northstar.io|maya.chen@northstar.io> reported a duplicate charge on `acct_88412K`.',
    'See <https://sentry.io/issues/991|Sentry Issue #991> or <https://status.northstar.io>.',
    '==========',
    '<!here> Please review _immediately_.',
  ].join('\n');

  const cleaned = formatSlackText(rawSlack);
  assert.doesNotMatch(cleaned, /mailto:/);
  assert.doesNotMatch(cleaned, /----------/);
  assert.doesNotMatch(cleaned, /==========/);
  assert.doesNotMatch(cleaned, /\*Urgent/);
  assert.doesNotMatch(cleaned, /<!here>/);
  assert.match(cleaned, /Urgent Billing Alert in #finance-ops/);
  assert.match(cleaned, /Customer maya\.chen@northstar\.io reported a duplicate charge on acct_88412K\./);
  assert.match(cleaned, /See Sentry Issue #991 or https:\/\/status\.northstar\.io\./);
  assert.match(cleaned, /Please review immediately\./);

  const normalized = normalizeSlackHistoryMessages('C01FIN', 'finance-ops', [
    { type: 'message', ts: '1732200500.000500', user: 'U_OPS', text: rawSlack },
  ]);
  assert.equal(normalized.length, 1);

  const incident = syncedSlackMessageToIncident(normalized[0], 'ecommerce');
  assert.equal(incident.title, 'Urgent Billing Alert in #finance-ops');
  assert.equal(incident.piiRedactedCount, 2);
  assert.doesNotMatch(incident.scrubbedSummary, /mailto:/);
  assert.doesNotMatch(incident.scrubbedSummary, /maya\.chen@northstar\.io/);
  assert.doesNotMatch(incident.scrubbedSummary, /acct_88412K/);
  // Must produce exactly ONE [Protected Email] token, never duplicated inside <mailto:...|...>
  assert.equal((incident.scrubbedSummary.match(/\[Protected Email\]/g) || []).length, 1);
  assert.equal((incident.scrubbedSummary.match(/\[Protected Account\]/g) || []).length, 1);
});

test('Gemini Decisions triage buckets urgent fires vs routine noise, computes priority badges, and sorts highest priority first', () => {
  const urgentOutcome = computeTriageDecision({
    needs_action: { type: 'noul', noul: 0.96, confidence: 0.92 },
    is_fyi_or_digest: { type: 'noul', noul: 0.04, confidence: 0.92 },
    revenue_or_sla_risk: { type: 'noul', noul: 0.91, confidence: 0.88 },
    needs_engineering: { type: 'noul', noul: 0.62, confidence: 0.74 },
  });
  assert.ok(urgentOutcome);
  assert.equal(urgentOutcome.bucket, 'needs_action');
  assert.equal(urgentOutcome.priorityScore, 96);
  assert.equal(urgentOutcome.decisionScores.outputTokens, 0);
  assert.equal(urgentOutcome.decisionScores.model, 'gemini-decision-1');

  const actionOutcome = computeTriageDecision({
    needs_action: { type: 'noul', noul: 0.78, confidence: 0.8 },
    is_fyi_or_digest: { type: 'noul', noul: 0.18, confidence: 0.8 },
    revenue_or_sla_risk: { type: 'noul', noul: 0.42, confidence: 0.7 },
    needs_engineering: { type: 'noul', noul: 0.25, confidence: 0.7 },
  });
  assert.ok(actionOutcome);
  assert.equal(actionOutcome.bucket, 'needs_action');
  assert.equal(actionOutcome.priorityScore, 78);

  const noiseOutcome = computeTriageDecision({
    needs_action: { type: 'noul', noul: 0.12, confidence: 0.9 },
    is_fyi_or_digest: { type: 'noul', noul: 0.94, confidence: 0.95 },
    revenue_or_sla_risk: { type: 'noul', noul: 0.03, confidence: 0.9 },
    needs_engineering: { type: 'noul', noul: 0.02, confidence: 0.9 },
  });
  assert.ok(noiseOutcome);
  assert.equal(noiseOutcome.bucket, 'hidden_noise');
  assert.equal(noiseOutcome.priorityScore, 12);

  // Missing answers cleanly return null (no fabricated scores)
  assert.equal(computeTriageDecision(undefined), null);

  assert.deepEqual(
    getPriorityBadge({
      bucket: urgentOutcome.bucket,
      isNoise: false,
      priorityScore: urgentOutcome.priorityScore,
      decisionScores: urgentOutcome.decisionScores,
    }),
    { label: 'Urgent · 96%', tone: 'urgent' }
  );
  assert.deepEqual(
    getPriorityBadge({
      bucket: actionOutcome.bucket,
      isNoise: false,
      priorityScore: actionOutcome.priorityScore,
      decisionScores: actionOutcome.decisionScores,
    }),
    { label: 'Action · 78%', tone: 'action' }
  );
  assert.equal(
    getPriorityBadge({
      bucket: noiseOutcome.bucket,
      isNoise: true,
      priorityScore: noiseOutcome.priorityScore,
      decisionScores: noiseOutcome.decisionScores,
    }),
    null
  );

  // Sorting puts urgent Needs Action fires before lower-priority items and Hidden Noise last
  const sorted = sortIncidentsByTriage([
    { id: 'digest_new', bucket: 'hidden_noise' as const, priorityScore: 12, ts: '1732200900.0001' },
    { id: 'kyc_action', bucket: 'needs_action' as const, priorityScore: 78, ts: '1732200800.0001' },
    { id: 'adpay_fail', bucket: 'needs_action' as const, priorityScore: 96, ts: '1732200100.0001' },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['adpay_fail', 'kyc_action', 'digest_new']
  );
});

test('Gemini Decisions client-side tool retriever builds valid keys and filters tools at >= 0.50 threshold', () => {
  const { tools } = parseOpenApiToTools(SAMPLE_OPENAPI_SPEC, 'Admin');
  const { questions, keyToTool } = buildToolDecisionQuestions(tools);

  const keys = Object.keys(questions);
  assert.equal(keys.length, tools.length);
  for (const key of keys) {
    assert.match(key, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(questions[key].type, 'noul');
  }

  const { matchedTools, toolScores } = selectMatchedToolsFromDecisions(keyToTool, {
    tool_0: { type: 'noul', noul: 0.89, confidence: 0.9 },
    tool_1: { type: 'noul', noul: 0.61, confidence: 0.7 },
    tool_2: { type: 'noul', noul: 0.14, confidence: 0.9 },
  });

  assert.equal(matchedTools.length, 2);
  assert.equal(matchedTools[0].name, tools[0].name);
  assert.equal(matchedTools[1].name, tools[1].name);
  assert.equal(toolScores.length, 3);
  assert.equal(toolScores[0].matched, true);
  assert.equal(toolScores[2].matched, false);
});

test('SlackConnectionStore reads firebase-applet-config.json target and round-trips Firestore REST documents without exposing tokens', () => {
  const target = resolveFirestoreTarget();
  assert.equal(target.projectId, 'your-firebase-project-id');
  assert.equal(target.databaseId, '(default)');

  const conn = {
    orgId: 'org_northstar_01',
    team: 'Northstar Ops',
    teamId: 'T01NORTHSTAR',
    botName: 'edgeops',
    botUserId: 'U01EDGE',
    accessToken: 'xoxb-secret-test-token-1234',
    selectedChannelIds: ['C01OPS', 'C02FIN'],
    updatedAt: '2026-11-22T08:00:00.000Z',
  };

  const fields = toFirestoreFields(conn);
  // Stored Firestore accessToken MUST be encrypted at rest (never plaintext xoxb-)
  const storedRaw = (fields.accessToken as { stringValue?: string }).stringValue || '';
  assert.ok(isEncryptedTokenValue(storedRaw), 'Firestore accessToken must be AES-256-GCM encrypted');
  assert.doesNotMatch(storedRaw, /xoxb-secret-test-token-1234/);
  // Cross-tenant AAD mismatch fails decryption
  assert.equal(decryptTokenForOrg('org_other_tenant', storedRaw), '');
  // Legacy plaintext tokens remain readable for zero-downtime migration
  assert.equal(decryptTokenForOrg(conn.orgId, 'xoxb-legacy-plain'), 'xoxb-legacy-plain');
  assert.ok(isEncryptedTokenValue(encryptTokenForOrg(conn.orgId, 'xoxb-new')));

  const decoded = fromFirestoreDocument({
    name: `projects/${target.projectId}/databases/${target.databaseId}/documents/server_slack_connections/${conn.orgId}`,
    fields,
  });
  assert.deepEqual(decoded, conn);

  const pub = toPublicSlackConnection(conn);
  assert.equal((pub as unknown as Record<string, unknown>).accessToken, undefined);
  assert.equal(pub.orgId, 'org_northstar_01');
  assert.equal(pub.botName, 'edgeops');
  assert.deepEqual(pub.selectedChannelIds, ['C01OPS', 'C02FIN']);
});

test('Slack manifest defaults to strictly read-only scopes with optional Socket Mode support', () => {
  const manifest = generateSlackManifestYaml('org_northstar_01', 'https://example.run.app', 'EdgeOps');
  assert.match(manifest, /channels:history/);
  assert.match(manifest, /groups:history/);
  assert.doesNotMatch(manifest, /chat:write/);
  assert.doesNotMatch(manifest, /reactions:write/);
  assert.match(manifest, /socket_mode_enabled: false/);

  const socketManifest = generateSlackManifestYaml('org_northstar_01', 'https://example.run.app', 'EdgeOps', {
    socketMode: true,
  });
  assert.match(socketManifest, /socket_mode_enabled: true/);
});

test('SlackConnectionStore persists to Firestore REST via Metadata ADC and auto-hydrates after Cloud Run cold start', async () => {
  const remoteDocs = new Map<string, { name: string; fields: Record<string, unknown> }>();

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // 1. Metadata Server ADC Token endpoint
    if (url.includes('metadata.google.internal')) {
      const headers = (init?.headers || {}) as Record<string, string>;
      assert.equal(headers['Metadata-Flavor'], 'Google');
      return new Response(JSON.stringify({ access_token: 'ya29.mock-adc-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Firestore REST API endpoint
    if (url.includes('firestore.googleapis.com/v1/projects/your-firebase-project-id/databases/(default)/documents/server_slack_connections')) {
      const headers = (init?.headers || {}) as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer ya29.mock-adc-token');
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'PATCH') {
        const docId = decodeURIComponent(url.split('/').pop() || '');
        const body = JSON.parse(String(init?.body || '{}')) as { fields: Record<string, unknown> };
        const doc = { name: `.../server_slack_connections/${docId}`, fields: body.fields };
        remoteDocs.set(docId, doc);
        return new Response(JSON.stringify(doc), { status: 200 });
      }

      if (method === 'GET' && url.includes('?pageSize=')) {
        return new Response(JSON.stringify({ documents: Array.from(remoteDocs.values()) }), { status: 200 });
      }

      if (method === 'GET') {
        const docId = decodeURIComponent(url.split('/').pop() || '');
        const found = remoteDocs.get(docId);
        if (!found) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
        return new Response(JSON.stringify(found), { status: 200 });
      }
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const store = new SlackConnectionStore({
    target: {
      projectId: 'your-firebase-project-id',
      databaseId: '(default)',
    },
    fetchImpl: mockFetch,
  });

  await store.saveConnection({
    orgId: 'org_northstar_prod',
    team: 'Northstar Ops',
    teamId: 'T999',
    botName: 'edgeops',
    botUserId: 'U999',
    accessToken: 'xoxb-real-persisted-token',
    selectedChannelIds: ['C01ALERTS'],
    updatedAt: '2026-11-22T08:10:00.000Z',
  });

  // Simulate Cloud Run scaling to zero (complete wipe of in-memory Map)
  store.clearMemoryCacheForTest();

  // Resolving by exact orgId auto-hydrates from Firestore
  const resolvedExact = await store.resolveConnection('org_northstar_prod');
  assert.ok(resolvedExact);
  assert.equal(resolvedExact.team, 'Northstar Ops');
  assert.equal(resolvedExact.botName, 'edgeops');
  assert.equal(resolvedExact.accessToken, 'xoxb-real-persisted-token');

  // Wipe again and resolve with omitted/wildcard orgId -> lists Firestore and returns most recently updated workspace
  store.clearMemoryCacheForTest();
  const resolvedDefault = await store.resolveConnection(undefined);
  assert.ok(resolvedDefault);
  assert.equal(resolvedDefault.orgId, 'org_northstar_prod');

  const health = await store.getHealth();
  assert.equal(health.storage, 'firestore');
  assert.equal(health.tokenEncryption, 'aes-256-gcm');
  assert.equal(health.connectedWorkspaces, 1);
  assert.equal(health.latestOrgId, 'org_northstar_prod');
  assert.equal((health as unknown as Record<string, unknown>).accessToken, undefined);
});

test('SlackConnectionStore falls back cleanly to local .data file when Metadata ADC is unavailable in dev', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgeops-slack-store-'));
  const localFile = path.join(tempDir, 'slack-connections.json');

  const offlineFetch = (async () => {
    throw new Error('Metadata server unreachable in local dev');
  }) as unknown as typeof fetch;

  try {
    const store1 = new SlackConnectionStore({
      localFilePath: localFile,
      fetchImpl: offlineFetch,
    });

    await store1.saveConnection({
      orgId: 'org_dev_local',
      team: 'Local Dev Team',
      botName: 'edgeops',
      botUserId: 'U_DEV',
      accessToken: 'xoxb-local-dev-token',
      selectedChannelIds: ['C_LOCAL'],
    });

    const health = await store1.getHealth();
    assert.equal(health.storage, 'memory');

    // Simulate dev server restart with brand new store instance reading same fallback file
    const store2 = new SlackConnectionStore({
      localFilePath: localFile,
      fetchImpl: offlineFetch,
    });
    const hydrated = await store2.resolveConnection('org_dev_local');
    assert.ok(hydrated);
    assert.equal(hydrated.team, 'Local Dev Team');
    assert.equal(hydrated.accessToken, 'xoxb-local-dev-token');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeTestIncident(overrides: Partial<IncidentItem>): IncidentItem {
  return {
    id: overrides.id || 'inc_1',
    title: overrides.title || '[NORTHSTAR] Compliance alert digest',
    channel: overrides.channel || '#compliance-alerts',
    severity: overrides.severity || 'high',
    status: overrides.status || 'open',
    inferenceMode: 'on_device',
    rawPayload: overrides.rawPayload || 'Compliance alert digest body',
    scrubbedSummary: overrides.scrubbedSummary || 'Compliance alert digest body',
    piiRedactedCount: 0,
    piiCategories: [],
    isNoise: overrides.isNoise ?? false,
    noiseReason: 'Actionable signal',
    suggestedReply: 'Checking this now.',
    createdAtIso: overrides.createdAtIso || '2026-11-22T08:00:00.000Z',
    timestampLabel: overrides.timestampLabel || 'Just now',
    slackPosted: false,
    industryPack: 'ecommerce',
    source: 'slack_live',
    bucket: overrides.bucket || 'needs_action',
    priorityScore: overrides.priorityScore ?? 92,
  };
}

test('Smart Duplicate Incident Grouping collapses repeated alerts by channel + base title + business/entity into ×N threads', () => {
  // 6 repeated [NORTHSTAR] Compliance alert digest messages across timestamps
  const northstarDigests = Array.from({ length: 6 }, (_, idx) =>
    makeTestIncident({
      id: `northstar_${idx + 1}`,
      channel: '#compliance-alerts',
      title: `[NORTHSTAR] Compliance alert digest (Nov ${16 + idx})`,
      scrubbedSummary: `[NORTHSTAR] Compliance alert digest\nPending reviews: ${idx + 2}`,
      createdAtIso: `2026-11-${16 + idx}T09:00:00.000Z`,
      priorityScore: idx === 5 ? 99 : 88,
    })
  );

  // 2 repeated AdPay reconciliation alerts with different operation IDs
  const adpayAlerts = [
    makeTestIncident({
      id: 'adpay_1',
      channel: '#finance-ops',
      title: 'AdPay budget operation awaiting reconciliation #4821',
      scrubbedSummary: 'AdPay budget operation #4821 ($1,400.00) awaiting reconciliation.',
      createdAtIso: '2026-11-22T07:10:00.000Z',
      priorityScore: 95,
    }),
    makeTestIncident({
      id: 'adpay_2',
      channel: '#finance-ops',
      title: 'AdPay budget operation awaiting reconciliation #4829',
      scrubbedSummary: 'AdPay budget operation #4829 ($2,150.00) awaiting reconciliation.',
      createdAtIso: '2026-11-22T07:45:00.000Z',
      priorityScore: 96,
    }),
  ];

  // Compliance overdue alerts for 2 DIFFERENT businesses should stay in 2 separate threads,
  // while 2 alerts for the SAME business collapse into 1 thread!
  const kycAlerts = [
    makeTestIncident({
      id: 'kyc_acme_1',
      channel: '#compliance-alerts',
      title: 'Compliance verification overdue for Acme Logistics',
      scrubbedSummary: 'Business: Acme Logistics — KYB verification overdue by 3 days.',
      createdAtIso: '2026-11-21T10:00:00.000Z',
      priorityScore: 86,
    }),
    makeTestIncident({
      id: 'kyc_acme_2',
      channel: '#compliance-alerts',
      title: 'Compliance verification overdue for Acme Logistics',
      scrubbedSummary: 'Business: Acme Logistics — KYB verification overdue by 4 days.',
      createdAtIso: '2026-11-22T10:00:00.000Z',
      priorityScore: 90,
    }),
    makeTestIncident({
      id: 'kyc_globex_1',
      channel: '#compliance-alerts',
      title: 'Compliance verification overdue for Globex Corp',
      scrubbedSummary: 'Business: Globex Corp — KYB verification overdue by 2 days.',
      createdAtIso: '2026-11-22T11:00:00.000Z',
      priorityScore: 84,
    }),
  ];

  const groups = groupIncidents([...northstarDigests, ...adpayAlerts, ...kycAlerts]);

  assert.equal(groups.length, 4);

  const northstarGroup = groups.find((g) => g.latest.id === 'northstar_6');
  assert.ok(northstarGroup);
  assert.equal(northstarGroup.count, 6);
  assert.equal(northstarGroup.occurrences.length, 6);
  assert.equal(northstarGroup.priorityScore, 99);
  // Newest occurrence is first
  assert.equal(northstarGroup.occurrences[0].id, 'northstar_6');
  assert.equal(northstarGroup.occurrences[5].id, 'northstar_1');

  const adpayGroup = groups.find((g) => g.latest.id === 'adpay_2');
  assert.ok(adpayGroup);
  assert.equal(adpayGroup.count, 2);

  const acmeGroup = groups.find((g) => g.latest.id === 'kyc_acme_2');
  const globexGroup = groups.find((g) => g.latest.id === 'kyc_globex_1');
  assert.ok(acmeGroup && globexGroup);
  assert.equal(acmeGroup.count, 2);
  assert.equal(globexGroup.count, 1);
  assert.notEqual(acmeGroup.groupKey, globexGroup.groupKey);
  assert.equal(extractEntityKey(acmeGroup.latest.title, acmeGroup.latest.scrubbedSummary).key, 'acme logistics');

  // Diff note highlights changed lines cleanly
  const diffNote = computeOccurrenceDiffNote(northstarGroup.occurrences[0], northstarGroup.occurrences[1]);
  assert.match(diffNote, /Pending reviews: 7/);
});

test('Proactive Copilot detects urgent (>=90%) alerts and ×2+ spikes, deduplicates unchanged syncs, scrubs PII, and matches thread links', () => {
  const alerts = [
    makeTestIncident({
      id: 'rev_1',
      channel: '#finance-ops',
      title: 'AdPay budget operation awaiting reconciliation #4821',
      scrubbedSummary: 'Contact billing@secret-client.io about $1,400 hold.',
      rawPayload: 'Contact billing@secret-client.io about $1,400 hold.',
      priorityScore: 98,
      decisionScores: {
        needsAction: 0.98,
        isNoise: 0.01,
        revenueRisk: 0.94,
        needsEngineering: 0.55,
        model: 'gemini-decision-1',
        outputTokens: 0,
      },
      createdAtIso: '2026-11-22T08:00:00.000Z',
    }),
    makeTestIncident({
      id: 'rev_2',
      channel: '#finance-ops',
      title: 'AdPay budget operation awaiting reconciliation #4829',
      scrubbedSummary: 'Contact finance@secret-client.io about $2,150 hold.',
      rawPayload: 'Contact finance@secret-client.io about $2,150 hold.',
      priorityScore: 98,
      decisionScores: {
        needsAction: 0.98,
        isNoise: 0.01,
        revenueRisk: 0.95,
        needsEngineering: 0.55,
        model: 'gemini-decision-1',
        outputTokens: 0,
      },
      createdAtIso: '2026-11-22T08:10:00.000Z',
    }),
    makeTestIncident({
      id: 'routine_1',
      channel: '#general',
      title: 'Weekly digest summary',
      bucket: 'hidden_noise',
      isNoise: true,
      priorityScore: 10,
      createdAtIso: '2026-11-22T08:05:00.000Z',
    }),
  ];

  const groups = groupIncidents(alerts);
  const summaries = buildWorkspaceThreadSummaries(groups);
  assert.equal(summaries.length, 2);
  // Strictly scrubbed — zero raw emails ever enter workspace summaries
  assert.doesNotMatch(summaries[0].scrubbedSummary, /secret-client\.io/);
  assert.match(summaries[0].scrubbedSummary, /\[Protected Email\]/);

  const briefing = detectProactiveBriefing(groups, null);
  assert.ok(briefing);
  assert.equal(briefing.urgentCount, 1);
  assert.equal(briefing.spikeCount, 1);
  assert.equal(briefing.referencedThreads.length, 1);
  assert.equal(briefing.referencedThreads[0].count, 2);
  assert.match(briefing.body, /AdPay budget operation awaiting reconciliation/);

  // Unchanged sync signature must NOT re-trigger duplicate briefing
  assert.equal(detectProactiveBriefing(groups, briefing.signature), null);

  // Matching referenced threads from assistant prose
  const matched = matchReferencedThreadsInText(
    'You should first check AdPay budget operation awaiting reconciliation in #finance-ops.',
    summaries
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].channel, '#finance-ops');

  // Offline workspace summary works cleanly with zero PII
  const offlineText = buildOfflineWorkspaceReply("What's blocking revenue?", summaries);
  assert.match(offlineText, /Revenue/);
  assert.doesNotMatch(offlineText, /secret-client\.io/);
});

test('6-signal Decisions API routes auto-frozen virtual card to notify_ops (not page_eng) and high-value Paystack top-up to ignore', () => {
  // Verify all 6 parallel noul questions are defined
  assert.deepEqual(Object.keys(TRIAGE_DECISION_QUESTIONS).sort(), [
    'customer_blocked',
    'is_fyi_or_digest',
    'manual_money_move',
    'needs_action',
    'needs_engineering',
    'revenue_or_sla_risk',
  ]);

  // 1. Sunday auto-frozen virtual card: customer_blocked=0.94, needs_action=0.38, is_fyi_or_digest=0.11, needs_engineering=0.19
  const frozenCard = computeTriageDecision(
    {
      customer_blocked: { type: 'noul', noul: 0.94 },
      needs_action: { type: 'noul', noul: 0.38 },
      is_fyi_or_digest: { type: 'noul', noul: 0.11 },
      revenue_or_sla_risk: { type: 'noul', noul: 0.34 },
      manual_money_move: { type: 'noul', noul: 0.02 },
      needs_engineering: { type: 'noul', noul: 0.19 },
    },
    0,
    1200
  );
  assert.ok(frozenCard);
  assert.equal(frozenCard.route, 'notify_ops');
  assert.equal(frozenCard.bucket, 'needs_action');
  assert.equal(frozenCard.priorityScore, 94);
  assert.equal(frozenCard.decisionScores.customerBlocked, 0.94);
  assert.equal(frozenCard.decisionScores.latencyMs, 1200);
  assert.equal(getRouteBadge(frozenCard.decisionScores)?.shortLabel, 'Notify Ops');

  // 2. Routine high-value Paystack top-up (₦1,129,000 paid, ₦1,000,000 credited): must ignore (zero false alarms)
  const routineTopup = computeTriageDecision(
    {
      customer_blocked: { type: 'noul', noul: 0.02 },
      needs_action: { type: 'noul', noul: 0.03 },
      is_fyi_or_digest: { type: 'noul', noul: 0.78 },
      revenue_or_sla_risk: { type: 'noul', noul: 0.04 },
      manual_money_move: { type: 'noul', noul: 0.03 },
      needs_engineering: { type: 'noul', noul: 0.01 },
    },
    0,
    240
  );
  assert.ok(routineTopup);
  assert.equal(routineTopup.route, 'ignore');
  assert.equal(routineTopup.bucket, 'hidden_noise');
  assert.equal(routineTopup.decisionScores.latencyMs, 240);
  assert.equal(getRouteBadge(routineTopup.decisionScores)?.shortLabel, 'Ignored');

  // 3. Manual wallet debit routes to notify_ops even when needs_action alone is moderate
  const manualDebit = computeTriageDecision({
    customer_blocked: { type: 'noul', noul: 0.1 },
    needs_action: { type: 'noul', noul: 0.45 },
    is_fyi_or_digest: { type: 'noul', noul: 0.12 },
    revenue_or_sla_risk: { type: 'noul', noul: 0.4 },
    manual_money_move: { type: 'noul', noul: 0.89 },
    needs_engineering: { type: 'noul', noul: 0.15 },
  });
  assert.ok(manualDebit);
  assert.equal(manualDebit.route, 'notify_ops');
  assert.equal(manualDebit.bucket, 'needs_action');

  // 4. Backend gateway 504 spike routes to page_eng
  const backendOutage = computeTriageDecision({
    customer_blocked: { type: 'noul', noul: 0.85 },
    needs_action: { type: 'noul', noul: 0.96 },
    is_fyi_or_digest: { type: 'noul', noul: 0.03 },
    revenue_or_sla_risk: { type: 'noul', noul: 0.92 },
    manual_money_move: { type: 'noul', noul: 0.04 },
    needs_engineering: { type: 'noul', noul: 0.84 },
  });
  assert.ok(backendOutage);
  assert.equal(backendOutage.route, 'page_eng');
  assert.equal(backendOutage.bucket, 'needs_action');
  assert.equal(getRouteBadge(backendOutage.decisionScores)?.shortLabel, 'Page Eng');
});

test('Slack metadata (isBot, replyCount, CAT clock) powers calm executive window briefings with comparison ignore and latency range', () => {
  // 2026-11-22 is a Sunday; 08:52 UTC = 10:52 CAT, 09:17 UTC = 11:17 CAT
  const normalized = normalizeSlackHistoryMessages('C_CARDS', 'virtual_cards', [
    {
      type: 'message',
      ts: String(Date.parse('2026-11-22T08:52:00.000Z') / 1000),
      bot_id: 'B_CARDS',
      reply_count: 0,
      text: 'Customer card declined on $22.23 Google One charge; system auto-froze card 4532-8910-4421-9004.',
    },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].isBot, true);
  assert.equal(normalized[0].replyCount, 0);

  const catClock = formatLocalClockTime('2026-11-22T08:52:00.000Z', 'Africa/Harare');
  assert.equal(catClock.hhmm, '10:52');
  assert.equal(catClock.tzShort, 'CAT');
  assert.equal(catClock.weekday, 'Sunday');

  const cardDecision = computeTriageDecision(
    {
      customer_blocked: { type: 'noul', noul: 0.94 },
      needs_action: { type: 'noul', noul: 0.38 },
      is_fyi_or_digest: { type: 'noul', noul: 0.11 },
      revenue_or_sla_risk: { type: 'noul', noul: 0.34 },
      manual_money_move: { type: 'noul', noul: 0.02 },
      needs_engineering: { type: 'noul', noul: 0.19 },
    },
    0,
    1200
  )!;

  const topupDecision = computeTriageDecision(
    {
      customer_blocked: { type: 'noul', noul: 0.02 },
      needs_action: { type: 'noul', noul: 0.03 },
      is_fyi_or_digest: { type: 'noul', noul: 0.78 },
      revenue_or_sla_risk: { type: 'noul', noul: 0.04 },
      manual_money_move: { type: 'noul', noul: 0.03 },
      needs_engineering: { type: 'noul', noul: 0.01 },
    },
    0,
    240
  )!;

  const cardIncident = syncedSlackMessageToIncident(
    {
      ...normalized[0],
      decisionScores: cardDecision.decisionScores,
      bucket: cardDecision.bucket,
      priorityScore: cardDecision.priorityScore,
    },
    'ecommerce'
  );
  const topupIncident = syncedSlackMessageToIncident(
    {
      id: 'slk_C_WALLET_topup',
      channelId: 'C_WALLET',
      channel: '#wallet_funding',
      rawText: 'Paystack AdPay top-up received: ₦1,129,000 paid, ₦1,000,000 credited.',
      timestamp: '2026-11-22T09:17:00.000Z',
      ts: String(Date.parse('2026-11-22T09:17:00.000Z') / 1000),
      user: 'B_WALLET',
      isBot: true,
      replyCount: 0,
      source: 'slack_live',
      decisionScores: topupDecision.decisionScores,
      bucket: topupDecision.bucket,
      priorityScore: topupDecision.priorityScore,
    },
    'ecommerce'
  );

  const groups = groupIncidents([cardIncident, topupIncident]);
  const summaries = buildWorkspaceThreadSummaries(groups);
  const exec = buildExecutiveBriefingFallback(summaries, {
    workspaceName: 'Northstar Slack',
    timeZone: 'Africa/Harare',
  });

  assert.match(exec.body, /Decisions API: what stood out in Northstar Slack \(10:52–11:17 CAT\)/);
  assert.match(exec.body, /Sunday, so every message in this window came from a bot/);
  assert.match(exec.body, /#virtual_cards, 10:52 CAT \(bot\)/);
  assert.match(exec.body, /Nobody responded in Slack\./);
  assert.match(exec.body, /0\.94/);
  assert.match(exec.body, /`notify_ops`/);
  assert.match(exec.body, /doesn't page engineering \(0\.19\)/);
  assert.match(exec.body, /#wallet_funding, 11:17 CAT \(bot\), included for comparison/);
  assert.match(exec.body, /`ignore`/);
  assert.match(exec.body, /240 ms to 1\.2 s/);
  assert.match(exec.body, /Nothing was posted in Slack\./);
  // Zero raw card PII in executive briefing
  assert.doesNotMatch(exec.body, /4532-8910-4421-9004/);
});






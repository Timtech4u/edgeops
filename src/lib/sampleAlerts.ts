import type { IncidentItem, IncidentSeverity, IndustryPackId } from '../types/edgeops';
import { buildOfflineSuggestedReply, evaluateNoiseGate, scrubPiiLocally } from './privacyShield';

interface RawAlertSeed {
  id: string;
  title: string;
  channel: string;
  severity: IncidentSeverity;
  rawPayload: string;
  timestampLabel: string;
  minutesAgo: number;
}

const PACK_INITIAL_ALERTS: Record<IndustryPackId, RawAlertSeed[]> = {
  ecommerce: [
    {
      id: 'inc_ec_01',
      title: 'Duplicate checkout charge hold on EU payment gateway',
      channel: '#payments-ops',
      severity: 'critical',
      rawPayload:
        'Customer maya.chen@northstar-goods.io (phone 415-890-2341, account acct_9948210K) reported two pending charges on card 4532-8910-4421-9004 during EU checkout timeout. Gateway pool eu-west-2 returned 504 after 12.4s while order #ORD-88214 remained payment_pending.',
      timestampLabel: '2m ago',
      minutesAgo: 2,
    },
    {
      id: 'inc_ec_02',
      title: 'Shipping label queue stalled at Midwest fulfillment node',
      channel: '#fulfillment-feed',
      severity: 'high',
      rawPayload:
        '42 priority orders waiting for carrier thermal labels at node MW-04. VIP buyer contact david.miller@brightshop.co (312-555-0194, cus_441092X) escalated delivery cutoff risk for afternoon pickup wave.',
      timestampLabel: '9m ago',
      minutesAgo: 9,
    },
    {
      id: 'inc_ec_03',
      title: 'Cart session lock contention during flash promo launch',
      channel: '#checkout-alerts',
      severity: 'medium',
      rawPayload:
        'Shard cart-us-03 showing 18% lock wait timeouts on promo code AUTUMN25. Sample affected session belongs to elena.rodriguez@examplemail.com (acct_77219A) retrying checkout 4 times.',
      timestampLabel: '16m ago',
      minutesAgo: 16,
    },
    {
      id: 'inc_ec_noise_1',
      title: 'ResizeObserver loop completed with undelivered notifications',
      channel: '#checkout-alerts',
      severity: 'low',
      rawPayload: 'Browser frontend telemetry: ResizeObserver loop completed with undelivered notifications on /cart mobile Safari.',
      timestampLabel: '4m ago',
      minutesAgo: 4,
    },
    {
      id: 'inc_ec_noise_2',
      title: 'HTTP 499 client closed connection before response',
      channel: '#checkout-alerts',
      severity: 'low',
      rawPayload: 'Edge gateway log: 499 client closed connection before response on GET /api/recommendations during tab close.',
      timestampLabel: '7m ago',
      minutesAgo: 7,
    },
    {
      id: 'inc_ec_noise_3',
      title: 'Synthetic healthcheck heartbeat timeout 1/3',
      channel: '#payments-ops',
      severity: 'low',
      rawPayload: 'Single-sample synthetic healthcheck probe jitter from us-east pop; next two checks returned 200 OK.',
      timestampLabel: '12m ago',
      minutesAgo: 12,
    },
    {
      id: 'inc_ec_noise_4',
      title: 'Third-party extension Script error on storefront',
      channel: '#checkout-alerts',
      severity: 'low',
      rawPayload: 'Uncaught exception from chrome-extension://coupon-helper-xyz/inject.js: Script error.',
      timestampLabel: '19m ago',
      minutesAgo: 19,
    },
    {
      id: 'inc_ec_noise_5',
      title: 'Static asset favicon.ico 404 from crawler',
      channel: '#fulfillment-feed',
      severity: 'low',
      rawPayload: 'CDN edge log: favicon.ico 404 requested by automated preview bot.',
      timestampLabel: '24m ago',
      minutesAgo: 24,
    },
  ],
  saas: [
    {
      id: 'inc_saas_01',
      title: 'Enterprise SAML SSO assertion failures after IdP key rotation',
      channel: '#enterprise-support',
      severity: 'critical',
      rawPayload:
        'Workspace admin priya.patel@acmecorp.io (650-555-0188, acct_ent8821) reports all 140 employees blocked at SSO login with signature mismatch. Cached JWKS keyset for tenant_acme_prod appears stale by 45 minutes.',
      timestampLabel: '3m ago',
      minutesAgo: 3,
    },
    {
      id: 'inc_saas_02',
      title: 'Mid-cycle seat proration mismatch on annual enterprise invoice',
      channel: '#billing-ops',
      severity: 'high',
      rawPayload:
        'Finance contact marcus.reed@finscale.co (212-555-0147, cus_910442B) flagged duplicate proration line item on invoice INV-40912 after SCIM synced 25 seats twice during webhook retry.',
      timestampLabel: '11m ago',
      minutesAgo: 11,
    },
    {
      id: 'inc_saas_03',
      title: 'Customer webhook circuit breaker tripped on event delivery',
      channel: '#api-reliability',
      severity: 'medium',
      rawPayload:
        'Webhook subscription sub_882019K auto-paused after 15 consecutive 502 responses. Account owner liam.oconnor@cloudmesh.dev confirmed their receiver recovered and requested dead-letter replay.',
      timestampLabel: '21m ago',
      minutesAgo: 21,
    },
    {
      id: 'inc_saas_noise_1',
      title: 'ResizeObserver loop limit exceeded in analytics table',
      channel: '#api-reliability',
      severity: 'low',
      rawPayload: 'Client warning: ResizeObserver loop limit exceeded while resizing dashboard split pane.',
      timestampLabel: '5m ago',
      minutesAgo: 5,
    },
    {
      id: 'inc_saas_noise_2',
      title: 'AbortError on canceled typeahead search request',
      channel: '#api-reliability',
      severity: 'low',
      rawPayload: 'Browser fetch AbortError: ERR_ABORTED as user typed next filter character.',
      timestampLabel: '8m ago',
      minutesAgo: 8,
    },
    {
      id: 'inc_saas_noise_3',
      title: 'Synthetic healthcheck keepalive ping retry',
      channel: '#enterprise-support',
      severity: 'low',
      rawPayload: 'edge-probe-ok recovered after single keepalive ping jitter on eu-central monitor.',
      timestampLabel: '14m ago',
      minutesAgo: 14,
    },
    {
      id: 'inc_saas_noise_4',
      title: 'Browser extension Script error injected in settings',
      channel: '#enterprise-support',
      severity: 'low',
      rawPayload: 'Unhandled error originating from moz-extension://password-fill/content.js.',
      timestampLabel: '18m ago',
      minutesAgo: 18,
    },
    {
      id: 'inc_saas_noise_5',
      title: 'Source map 404 warning from headless bot',
      channel: '#billing-ops',
      severity: 'low',
      rawPayload: 'CDN warning: source map 404 for vendor.bundle.js.map.',
      timestampLabel: '27m ago',
      minutesAgo: 27,
    },
  ],
  logistics: [
    {
      id: 'inc_log_01',
      title: 'Cold-chain trailer temperature excursion & stalled manifest lock',
      channel: '#dispatch-hub',
      severity: 'critical',
      rawPayload:
        'Trailer TRL-408 at Hub CHI-02 logged +6.4C spike while outbound manifest MAN-9921 stayed locked. Dispatcher hannah.brooks@freshfreight.io (312-555-0172, acct_hub4082) needs immediate QA hold and dock re-assignment.',
      timestampLabel: '1m ago',
      minutesAgo: 1,
    },
    {
      id: 'inc_log_02',
      title: 'Customs broker hold on cross-border commercial invoice packet',
      channel: '#wms-alerts',
      severity: 'high',
      rawPayload:
        'Shipment SHP-77310 held at border crossing for missing HS tariff line. Shipper ops lead carlos.mendez@pacificsupply.com (206-555-0139, cus_773109L) requested digital invoice resubmission before 16:00 cutoff.',
      timestampLabel: '10m ago',
      minutesAgo: 10,
    },
    {
      id: 'inc_log_03',
      title: 'Duplicate freight bill accessorial charge flagged in audit',
      channel: '#freight-finance',
      severity: 'medium',
      rawPayload:
        'Carrier invoice FRT-2026-884 billed detention twice for load LD-5541. Billing coordinator nina.kowalski@apexdist.co (404-555-0166, ACC-554109) asked to verify GPS dock timestamps and open dispute.',
      timestampLabel: '18m ago',
      minutesAgo: 18,
    },
    {
      id: 'inc_log_noise_1',
      title: 'Handheld UI ResizeObserver loop warning',
      channel: '#wms-alerts',
      severity: 'low',
      rawPayload: 'Tablet scanner browser logged ResizeObserver loop completed with undelivered notifications.',
      timestampLabel: '3m ago',
      minutesAgo: 3,
    },
    {
      id: 'inc_log_noise_2',
      title: 'Client closed connection 499 on map tile prefetch',
      channel: '#dispatch-hub',
      severity: 'low',
      rawPayload: 'Dispatch map tile prefetch canceled with HTTP 499 when operator switched hub view.',
      timestampLabel: '6m ago',
      minutesAgo: 6,
    },
    {
      id: 'inc_log_noise_3',
      title: 'Synthetic healthcheck heartbeat timeout 1/3',
      channel: '#dispatch-hub',
      severity: 'low',
      rawPayload: 'Single synthetic healthcheck ping jitter on telematics ingest VIP; auto-cleared.',
      timestampLabel: '13m ago',
      minutesAgo: 13,
    },
    {
      id: 'inc_log_noise_4',
      title: 'Extension script noise on shipper portal',
      channel: '#freight-finance',
      severity: 'low',
      rawPayload: 'Browser extension error from chrome-extension://grammar-assist/main.js.',
      timestampLabel: '22m ago',
      minutesAgo: 22,
    },
    {
      id: 'inc_log_noise_5',
      title: 'robots.txt 404 from external uptime checker',
      channel: '#wms-alerts',
      severity: 'low',
      rawPayload: 'Public tracking edge logged robots.txt 404.',
      timestampLabel: '29m ago',
      minutesAgo: 29,
    },
  ],
};

export function buildIncidentFromRaw(
  seed: { id: string; title: string; channel: string; severity: IncidentSeverity; rawPayload: string; timestampLabel: string; minutesAgo?: number },
  industryPack: IndustryPackId
): IncidentItem {
  const noise = evaluateNoiseGate(seed.title, seed.rawPayload);
  const scrub = scrubPiiLocally(seed.rawPayload);
  const suggestedReply = buildOfflineSuggestedReply(
    { title: seed.title, channel: seed.channel, severity: seed.severity },
    scrub.scrubbedText
  );
  const createdAtIso = new Date(Date.now() - (seed.minutesAgo ?? 0) * 60_000).toISOString();

  return {
    id: seed.id,
    title: seed.title,
    channel: seed.channel,
    severity: seed.severity,
    status: noise.isNoise ? 'suppressed' : 'open',
    inferenceMode: 'on_device',
    rawPayload: seed.rawPayload,
    scrubbedSummary: scrub.scrubbedText,
    piiRedactedCount: scrub.redactionCount,
    piiCategories: scrub.categories,
    isNoise: noise.isNoise,
    noiseReason: noise.reason,
    suggestedReply,
    createdAtIso,
    timestampLabel: seed.timestampLabel,
    slackPosted: false,
    onDeviceEngineLabel: 'Local Privacy Shield · PREFER_ON_DEVICE',
    industryPack,
  };
}

export function isSampleIncident(incident: Pick<IncidentItem, 'id' | 'source' | 'isSample'>): boolean {
  return (
    incident.isSample === true ||
    incident.source === 'sample' ||
    incident.id.startsWith('inc_ec_') ||
    incident.id.startsWith('inc_saas_') ||
    incident.id.startsWith('inc_log_') ||
    incident.id.startsWith('inc_burst_')
  );
}

export function getInitialIncidentsForPack(industryPack: IndustryPackId): IncidentItem[] {
  return PACK_INITIAL_ALERTS[industryPack].map((seed) => ({
    ...buildIncidentFromRaw(seed, industryPack),
    source: 'sample' as const,
    isSample: true,
  }));
}

export function createSimulatedAlertBurst(industryPack: IndustryPackId, burstIndex: number): IncidentItem[] {
  const stamp = `${Date.now().toString(36)}_${burstIndex}`;
  const burstSeeds: Record<IndustryPackId, RawAlertSeed[]> = {
    ecommerce: [
      {
        id: `inc_burst_ec_sig_${stamp}`,
        title: `Gift card ledger debit mismatch on voided order #ORD-${9100 + burstIndex}`,
        channel: '#payments-ops',
        severity: 'high',
        rawPayload: `Shopper jordan.lee@shoppermail.org (phone 415-555-0199, wallet wal_88412K) saw $120 gift card balance stuck at $0 after gateway void. Account acct_51290M retrying checkout.`,
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_ec_n1_${stamp}`,
        title: 'ResizeObserver loop completed with undelivered notifications',
        channel: '#checkout-alerts',
        severity: 'low',
        rawPayload: 'Frontend warning: ResizeObserver loop completed with undelivered notifications on PDP gallery.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_ec_n2_${stamp}`,
        title: 'HTTP 499 client closed connection before response',
        channel: '#checkout-alerts',
        severity: 'low',
        rawPayload: 'Storefront edge logged 499 ERR_ABORTED during rapid browser back navigation.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
    ],
    saas: [
      {
        id: `inc_burst_saas_sig_${stamp}`,
        title: `API 429 burst throttling enterprise sync for tenant_orbit_${burstIndex}`,
        channel: '#api-reliability',
        severity: 'high',
        rawPayload: `Integration engineer sam.rivera@orbitdata.io (650-555-0122, acct_orb9012) hit 429 rate-limit cap during scheduled warehouse import. Customer wallet/billing ref sub_44910P is on Enterprise tier.`,
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_saas_n1_${stamp}`,
        title: 'Synthetic healthcheck keepalive ping jitter',
        channel: '#api-reliability',
        severity: 'low',
        rawPayload: 'Monitoring node reported heartbeat timeout 1/3; subsequent healthcheck returned 200 OK.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_saas_n2_${stamp}`,
        title: 'Browser extension Script error on workspace modal',
        channel: '#enterprise-support',
        severity: 'low',
        rawPayload: 'Ignored chrome-extension://adguard-helper/injected.js Script error.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
    ],
    logistics: [
      {
        id: `inc_burst_log_sig_${stamp}`,
        title: `WMS handheld scanner drop-outs on dock wave WV-${300 + burstIndex}`,
        channel: '#wms-alerts',
        severity: 'high',
        rawPayload: `Shift supervisor alex.torres@metrohub-logistics.com (312-555-0181, acct_wms3021) reported 14 RF scanners failing label confirmation sync at Facility DAL-01.`,
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_log_n1_${stamp}`,
        title: 'Map tile prefetch canceled (HTTP 499)',
        channel: '#dispatch-hub',
        severity: 'low',
        rawPayload: 'Operator zoomed out; browser sent ERR_ABORTED 499 on tile prefetch.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
      {
        id: `inc_burst_log_n2_${stamp}`,
        title: 'Static asset favicon.ico 404 on tracking portal',
        channel: '#dispatch-hub',
        severity: 'low',
        rawPayload: 'External bot triggered favicon.ico 404 on shipper portal.',
        timestampLabel: 'Just now',
        minutesAgo: 0,
      },
    ],
  };

  return burstSeeds[industryPack].map((seed) => ({
    ...buildIncidentFromRaw(seed, industryPack),
    source: 'sample' as const,
    isSample: true,
  }));
}

/**
 * Curated zero-real-PII synthetic agent stream for the 1-click Judge Sandbox Workspace.
 * Demonstrates ×N duplicate grouping, local PII scrubbing, calibrated gemini-decision-1 scores,
 * Hidden Noise auto-filtering, and Dynamic Tool Retrieval with zero real company data.
 */
export function getSandboxWorkspaceIncidents(): IncidentItem[] {
  const seeds: Array<{
    seed: RawAlertSeed;
    priorityScore: number;
    bucket: 'needs_action' | 'hidden_noise';
    route: 'page_eng' | 'notify_ops' | 'digest_only' | 'ignore';
    needsAction: number;
    customerBlocked: number;
    isNoise: number;
    revenueRisk: number;
    manualMoneyMove: number;
    needsEngineering: number;
    latencyMs: number;
    isBot: boolean;
    replyCount: number;
  }> = [
    {
      seed: {
        id: 'inc_sandbox_eu_3',
        title: '[NORTHSTAR] Duplicate checkout charge hold on EU payment gateway #88219',
        channel: '#payments-ops',
        severity: 'critical',
        rawPayload:
          'Customer maya.chen@northstar-demo.io (phone 415-890-2341, account acct_9948210K) hit duplicate pending charges on card 4532-8910-4421-9004 during EU gateway pool eu-west-2 timeout (504 after 12.4s). Affected orders: 14.',
        timestampLabel: '1m ago',
        minutesAgo: 1,
      },
      priorityScore: 96,
      bucket: 'needs_action',
      route: 'page_eng',
      needsAction: 0.96,
      customerBlocked: 0.88,
      isNoise: 0.02,
      revenueRisk: 0.94,
      manualMoneyMove: 0.05,
      needsEngineering: 0.84,
      latencyMs: 420,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_eu_2',
        title: '[NORTHSTAR] Duplicate checkout charge hold on EU payment gateway #88216',
        channel: '#payments-ops',
        severity: 'critical',
        rawPayload:
          'Retry burst #2 on EU gateway pool eu-west-2 (504 after 11.9s). Account acct_9948210K and 9 other checkouts remain payment_pending.',
        timestampLabel: '6m ago',
        minutesAgo: 6,
      },
      priorityScore: 94,
      bucket: 'needs_action',
      route: 'page_eng',
      needsAction: 0.94,
      customerBlocked: 0.84,
      isNoise: 0.03,
      revenueRisk: 0.91,
      manualMoneyMove: 0.04,
      needsEngineering: 0.81,
      latencyMs: 390,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_eu_1',
        title: '[NORTHSTAR] Duplicate checkout charge hold on EU payment gateway #88214',
        channel: '#payments-ops',
        severity: 'critical',
        rawPayload:
          'Initial 504 timeout on EU gateway pool eu-west-2. Customer maya.chen@northstar-demo.io reported duplicate card hold on 4532-8910-4421-9004.',
        timestampLabel: '11m ago',
        minutesAgo: 11,
      },
      priorityScore: 92,
      bucket: 'needs_action',
      route: 'page_eng',
      needsAction: 0.92,
      customerBlocked: 0.82,
      isNoise: 0.04,
      revenueRisk: 0.89,
      manualMoneyMove: 0.04,
      needsEngineering: 0.78,
      latencyMs: 460,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_card_freeze',
        title: 'Virtual card auto-frozen after repeated declines ($22.23 Google One)',
        channel: '#virtual-cards',
        severity: 'high',
        rawPayload:
          'Customer virtual card was declined on a $22.23 Google One charge. Five seconds later the system auto-froze card 4532-8910-4421-9004 due to repeated declines for acct_77219B.',
        timestampLabel: '5m ago',
        minutesAgo: 5,
      },
      priorityScore: 94,
      bucket: 'needs_action',
      route: 'notify_ops',
      needsAction: 0.38,
      customerBlocked: 0.94,
      isNoise: 0.11,
      revenueRisk: 0.34,
      manualMoneyMove: 0.02,
      needsEngineering: 0.19,
      latencyMs: 310,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_kyb_2',
        title: 'Compliance verification overdue for Acme Logistics',
        channel: '#kyb-compliance',
        severity: 'high',
        rawPayload:
          'Business: Acme Logistics — KYB verification overdue by 4 days. Compliance contact ops@acmelogistics-demo.io (312-555-0194, cus_441092X) awaiting ledger settlement unblock.',
        timestampLabel: '8m ago',
        minutesAgo: 8,
      },
      priorityScore: 86,
      bucket: 'needs_action',
      route: 'notify_ops',
      needsAction: 0.86,
      customerBlocked: 0.72,
      isNoise: 0.08,
      revenueRisk: 0.78,
      manualMoneyMove: 0.06,
      needsEngineering: 0.24,
      latencyMs: 520,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_kyb_1',
        title: 'Compliance verification overdue for Acme Logistics',
        channel: '#kyb-compliance',
        severity: 'high',
        rawPayload:
          'Business: Acme Logistics — KYB verification overdue by 3 days. Pending secondary address proof from ops@acmelogistics-demo.io.',
        timestampLabel: '3h ago',
        minutesAgo: 180,
      },
      priorityScore: 81,
      bucket: 'needs_action',
      route: 'notify_ops',
      needsAction: 0.81,
      customerBlocked: 0.65,
      isNoise: 0.11,
      revenueRisk: 0.72,
      manualMoneyMove: 0.04,
      needsEngineering: 0.22,
      latencyMs: 490,
      isBot: true,
      replyCount: 1,
    },
    {
      seed: {
        id: 'inc_sandbox_topup_ok',
        title: 'Automated wallet funding top-up credited ($1,129 paid / $1,000 credited)',
        channel: '#wallet-funding',
        severity: 'low',
        rawPayload:
          'Automated Paystack wallet top-up completed for merchant Northstar Demo: $1,129.00 paid, $1,000.00 credited after fees.',
        timestampLabel: '4m ago',
        minutesAgo: 4,
      },
      priorityScore: 5,
      bucket: 'hidden_noise',
      route: 'ignore',
      needsAction: 0.03,
      customerBlocked: 0.02,
      isNoise: 0.78,
      revenueRisk: 0.04,
      manualMoneyMove: 0.03,
      needsEngineering: 0.01,
      latencyMs: 240,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_noise_1',
        title: 'ResizeObserver loop completed with undelivered notifications',
        channel: '#ops-noise',
        severity: 'low',
        rawPayload:
          'Browser frontend telemetry: ResizeObserver loop completed with undelivered notifications on /cart mobile Safari.',
        timestampLabel: '3m ago',
        minutesAgo: 3,
      },
      priorityScore: 8,
      bucket: 'hidden_noise',
      route: 'ignore',
      needsAction: 0.08,
      customerBlocked: 0.01,
      isNoise: 0.95,
      revenueRisk: 0.04,
      manualMoneyMove: 0.01,
      needsEngineering: 0.06,
      latencyMs: 270,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_noise_2',
        title: 'Synthetic healthcheck heartbeat timeout 1/3',
        channel: '#ops-noise',
        severity: 'low',
        rawPayload:
          'Single-sample synthetic healthcheck probe jitter from us-east pop; next two checks returned 200 OK.',
        timestampLabel: '9m ago',
        minutesAgo: 9,
      },
      priorityScore: 6,
      bucket: 'hidden_noise',
      route: 'ignore',
      needsAction: 0.06,
      customerBlocked: 0.01,
      isNoise: 0.97,
      revenueRisk: 0.02,
      manualMoneyMove: 0.01,
      needsEngineering: 0.04,
      latencyMs: 290,
      isBot: true,
      replyCount: 0,
    },
    {
      seed: {
        id: 'inc_sandbox_noise_3',
        title: 'HTTP 499 client closed connection before response',
        channel: '#ops-noise',
        severity: 'low',
        rawPayload:
          'Edge gateway log: 499 client closed connection before response on GET /api/recommendations during tab close.',
        timestampLabel: '14m ago',
        minutesAgo: 14,
      },
      priorityScore: 9,
      bucket: 'hidden_noise',
      route: 'ignore',
      needsAction: 0.09,
      customerBlocked: 0.02,
      isNoise: 0.94,
      revenueRisk: 0.03,
      manualMoneyMove: 0.01,
      needsEngineering: 0.05,
      latencyMs: 310,
      isBot: true,
      replyCount: 0,
    },
  ];

  return seeds.map(
    ({
      seed,
      priorityScore,
      bucket,
      route,
      needsAction,
      customerBlocked,
      isNoise,
      revenueRisk,
      manualMoneyMove,
      needsEngineering,
      latencyMs,
      isBot,
      replyCount,
    }) => {
      const base = buildIncidentFromRaw(seed, 'ecommerce');
      return {
        ...base,
        isNoise: bucket === 'hidden_noise',
        status: bucket === 'hidden_noise' ? 'suppressed' : 'open',
        bucket,
        priorityScore,
        isBot,
        replyCount,
        decisionScores: {
          needsAction,
          customerBlocked,
          isNoise,
          revenueRisk,
          manualMoneyMove,
          needsEngineering,
          route,
          latencyMs,
          model: 'gemini-decision-1',
          outputTokens: 0,
        },
        source: 'sample' as const,
        isSample: true,
      };
    }
  );
}

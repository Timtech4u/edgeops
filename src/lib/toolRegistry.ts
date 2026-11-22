import type {
  DeferredTool,
  IndustryPackId,
  RegisteredConnector,
  ToolRoleTag,
  TriageRole,
} from '../types/edgeops.ts';

export interface IndustryPackMeta {
  id: IndustryPackId;
  name: string;
  tagline: string;
  channels: string[];
  tools: DeferredTool[];
}

function makePackTool(
  packLabel: string,
  name: string,
  category: string,
  roleTag: ToolRoleTag,
  description: string,
  paramName: string,
  paramDesc: string
): DeferredTool {
  return {
    name,
    description,
    category,
    roleTag,
    defer_loading: true,
    sourceType: 'pack',
    sourceName: packLabel,
    parameters: {
      type: 'object',
      properties: {
        [paramName]: { type: 'string', description: paramDesc },
      },
      required: [paramName],
    },
  };
}

const ECOMMERCE_TOOLS: DeferredTool[] = [
  // Payments & Checkout (12)
  makePackTool('E-Commerce Pack', 'payments_inspect_gateway_timeouts', 'Payments', 'Viewer', 'Inspect payment gateway timeout spikes and status code distribution for a region.', 'region', 'Region code or gateway pool'),
  makePackTool('E-Commerce Pack', 'payments_check_duplicate_holds', 'Payments', 'Viewer', 'Check for duplicate card authorization holds tied to a protected account token.', 'reference_id', 'Order or tokenized account reference'),
  makePackTool('E-Commerce Pack', 'payments_verify_settlement_batch', 'Payments', 'Operator', 'Verify daily settlement batch totals against captured checkout orders.', 'batch_id', 'Settlement batch identifier'),
  makePackTool('E-Commerce Pack', 'payments_issue_partial_refund', 'Payments', 'Operator', 'Draft or execute a verified partial refund for an impacted order.', 'order_id', 'Order identifier'),
  makePackTool('E-Commerce Pack', 'payments_void_duplicate_auth', 'Payments', 'Operator', 'Release a duplicate pending payment authorization hold.', 'auth_id', 'Authorization hold ID'),
  makePackTool('E-Commerce Pack', 'payments_failover_processor_route', 'Payments', 'Admin', 'Shift checkout traffic to the secondary payment processor route.', 'region', 'Checkout region'),
  makePackTool('E-Commerce Pack', 'checkout_inspect_cart_locks', 'Checkout', 'Viewer', 'Inspect active distributed cart session locks causing checkout stalls.', 'shard', 'Cart service shard'),
  makePackTool('E-Commerce Pack', 'checkout_audit_promo_rules', 'Checkout', 'Viewer', 'Check discount and promo code evaluation latency and rule conflicts.', 'promo_code', 'Promo code or campaign ID'),
  makePackTool('E-Commerce Pack', 'checkout_check_tax_calculator', 'Checkout', 'Viewer', 'Check real-time sales tax calculation service latency and fallback cache.', 'jurisdiction', 'Tax jurisdiction code'),
  makePackTool('E-Commerce Pack', 'checkout_flush_stale_locks', 'Checkout', 'Admin', 'Flush orphaned cart lock entries older than threshold.', 'shard', 'Cart service shard'),
  makePackTool('E-Commerce Pack', 'checkout_toggle_guest_fallback', 'Checkout', 'Admin', 'Enable stateless guest checkout fallback during identity degradation.', 'enabled', 'true or false'),
  makePackTool('E-Commerce Pack', 'fraud_inspect_velocity_blocks', 'Risk', 'Viewer', 'Review automated fraud velocity rule triggers and false-positive rate.', 'rule_id', 'Risk rule identifier'),
  // Orders & Inventory (12)
  makePackTool('E-Commerce Pack', 'orders_get_timeline', 'Orders', 'Viewer', 'Retrieve step-by-step order state transitions without exposing raw PII.', 'order_id', 'Order identifier'),
  makePackTool('E-Commerce Pack', 'orders_check_webhook_backlog', 'Orders', 'Viewer', 'Check outbound order confirmation webhook queue depth and retry rate.', 'topic', 'Webhook event topic'),
  makePackTool('E-Commerce Pack', 'orders_replay_failed_events', 'Orders', 'Operator', 'Replay dead-lettered order confirmation events safely with idempotency keys.', 'topic', 'Webhook event topic'),
  makePackTool('E-Commerce Pack', 'orders_reconcile_stuck_pending', 'Orders', 'Operator', 'Reconcile orders stuck in payment_pending after confirmed capture.', 'window_minutes', 'Lookback window in minutes'),
  makePackTool('E-Commerce Pack', 'inventory_check_sku_reservation', 'Inventory', 'Viewer', 'Inspect available stock vs reserved hold counts for a SKU.', 'sku', 'Product SKU'),
  makePackTool('E-Commerce Pack', 'inventory_audit_warehouse_sync', 'Inventory', 'Viewer', 'Check inventory feed lag between regional warehouses and storefront cache.', 'warehouse_id', 'Warehouse code'),
  makePackTool('E-Commerce Pack', 'inventory_release_expired_holds', 'Inventory', 'Operator', 'Release expired checkout inventory reservations older than 20 minutes.', 'sku', 'Product SKU'),
  makePackTool('E-Commerce Pack', 'inventory_force_catalog_reindex', 'Inventory', 'Admin', 'Trigger incremental catalog search and availability reindex.', 'collection', 'Catalog collection name'),
  makePackTool('E-Commerce Pack', 'returns_inspect_rma_status', 'Returns', 'Viewer', 'Check return merchandise authorization (RMA) approval and inspection state.', 'rma_id', 'RMA identifier'),
  makePackTool('E-Commerce Pack', 'returns_approve_instant_credit', 'Returns', 'Operator', 'Approve instant store credit for verified return scan.', 'rma_id', 'RMA identifier'),
  makePackTool('E-Commerce Pack', 'loyalty_check_points_ledger', 'Loyalty', 'Viewer', 'Verify customer loyalty points accrual and redemption entries.', 'account_token', 'Protected account reference'),
  makePackTool('E-Commerce Pack', 'loyalty_adjust_missing_points', 'Loyalty', 'Operator', 'Post corrective loyalty points entry for failed order credit.', 'order_id', 'Order identifier'),
  // Fulfillment & Shipping (12)
  makePackTool('E-Commerce Pack', 'shipping_inspect_rate_quotes', 'Shipping', 'Viewer', 'Inspect live shipping rate quote failures and carrier API error codes.', 'carrier_pool', 'Carrier pool name'),
  makePackTool('E-Commerce Pack', 'shipping_check_label_queue', 'Shipping', 'Viewer', 'Inspect thermal shipping label generation queue and failure count.', 'facility_id', 'Fulfillment facility ID'),
  makePackTool('E-Commerce Pack', 'shipping_regenerate_label_batch', 'Shipping', 'Operator', 'Re-queue failed shipping label jobs using backup carrier endpoint.', 'batch_id', 'Fulfillment batch ID'),
  makePackTool('E-Commerce Pack', 'shipping_enable_flat_rate_fallback', 'Shipping', 'Admin', 'Switch storefront checkout to flat-rate shipping fallback during carrier outage.', 'region', 'Storefront region'),
  makePackTool('E-Commerce Pack', 'fulfillment_check_pick_pack_sla', 'Fulfillment', 'Viewer', 'Check pick-and-pack SLA backlog across active fulfillment nodes.', 'node_id', 'Fulfillment node'),
  makePackTool('E-Commerce Pack', 'fulfillment_reroute_order_node', 'Fulfillment', 'Operator', 'Reroute unshipped order to secondary in-stock fulfillment node.', 'order_id', 'Order identifier'),
  makePackTool('E-Commerce Pack', 'notifications_check_email_bounces', 'Messaging', 'Viewer', 'Check transactional order confirmation delivery and bounce rates.', 'template_id', 'Message template ID'),
  makePackTool('E-Commerce Pack', 'notifications_resend_receipt', 'Messaging', 'Operator', 'Trigger tokenized receipt resend without exposing raw email address.', 'order_id', 'Order identifier'),
  makePackTool('E-Commerce Pack', 'storefront_check_edge_cache', 'Storefront', 'Viewer', 'Inspect storefront edge CDN hit ratio and origin 5xx errors.', 'path_prefix', 'URL path prefix'),
  makePackTool('E-Commerce Pack', 'storefront_purge_stale_pricing', 'Storefront', 'Admin', 'Purge stale product pricing cache entries across edge nodes.', 'sku', 'Product SKU'),
  makePackTool('E-Commerce Pack', 'storefront_inspect_search_latency', 'Storefront', 'Viewer', 'Measure product search index p95 latency and zero-result spikes.', 'locale', 'Storefront locale'),
  makePackTool('E-Commerce Pack', 'storefront_check_mobile_api_health', 'Storefront', 'Viewer', 'Inspect mobile checkout BFF error rate by app version.', 'app_version', 'Mobile app version'),
  // Finance, Subscriptions & Platform (12)
  makePackTool('E-Commerce Pack', 'billing_reconcile_giftcard_balance', 'Finance', 'Operator', 'Reconcile gift card debit ledger against voided orders.', 'card_ref', 'Tokenized gift card ID'),
  makePackTool('E-Commerce Pack', 'billing_check_chargeback_alerts', 'Finance', 'Operator', 'Inspect open dispute evidence deadlines and automated representment state.', 'dispute_id', 'Dispute reference'),
  makePackTool('E-Commerce Pack', 'billing_export_tax_audit_diff', 'Finance', 'Operator', 'Compare collected checkout tax vs jurisdiction rate table.', 'date_range', 'ISO date range'),
  makePackTool('E-Commerce Pack', 'subscriptions_inspect_renewal_queue', 'Subscriptions', 'Viewer', 'Inspect recurring box subscription renewal failure codes.', 'cycle_id', 'Billing cycle ID'),
  makePackTool('E-Commerce Pack', 'subscriptions_retry_soft_declines', 'Subscriptions', 'Operator', 'Schedule smart retry for soft-declined subscription renewals.', 'cycle_id', 'Billing cycle ID'),
  makePackTool('E-Commerce Pack', 'subscriptions_pause_impacted_batch', 'Subscriptions', 'Admin', 'Temporarily pause automated dunning notifications during gateway incident.', 'cycle_id', 'Billing cycle ID'),
  makePackTool('E-Commerce Pack', 'platform_check_db_connection_pool', 'Platform', 'Viewer', 'Inspect primary order database connection pool saturation and lock waits.', 'cluster', 'Database cluster name'),
  makePackTool('E-Commerce Pack', 'platform_inspect_worker_deadletters', 'Platform', 'Viewer', 'List top failing async worker job types and stack signatures.', 'queue_name', 'Worker queue name'),
  makePackTool('E-Commerce Pack', 'platform_restart_stalled_consumer', 'Platform', 'Admin', 'Gracefully cycle stalled event stream consumer pods.', 'consumer_group', 'Consumer group ID'),
  makePackTool('E-Commerce Pack', 'platform_rotate_webhook_secret', 'Platform', 'Admin', 'Rotate compromised signing secret with dual-verification overlap.', 'integration_id', 'Integration identifier'),
  makePackTool('E-Commerce Pack', 'platform_check_recent_deployments', 'Platform', 'Viewer', 'List deployments in the last 6 hours with commit summary and canary diff.', 'service', 'Service name'),
  makePackTool('E-Commerce Pack', 'platform_rollback_canary_release', 'Platform', 'Admin', 'Roll back an unhealthy canary service release to the prior stable build.', 'service', 'Service name'),
];

const SAAS_TOOLS: DeferredTool[] = [
  // Auth, Identity & Tenants (12)
  makePackTool('B2B SaaS Pack', 'identity_inspect_sso_assertions', 'Identity', 'Viewer', 'Inspect SAML/OIDC assertion validation errors and clock skew for a tenant.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'identity_check_scim_sync_errors', 'Identity', 'Viewer', 'Review SCIM directory provisioning failures and seat-cap mismatches.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'identity_refresh_jwks_cache', 'Identity', 'Admin', 'Force refresh of cached OIDC JWKS signing keys for an identity provider.', 'provider_id', 'IdP configuration ID'),
  makePackTool('B2B SaaS Pack', 'identity_check_session_revocations', 'Identity', 'Viewer', 'Inspect recent mass session invalidation or token refresh failures.', 'region', 'Auth region'),
  makePackTool('B2B SaaS Pack', 'identity_enable_emergency_magic_link', 'Identity', 'Admin', 'Temporarily allow fallback email verification for locked-out tenant admins.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'tenants_check_quota_utilization', 'Tenants', 'Viewer', 'Check API request, storage, and seat quota utilization for a workspace.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'tenants_grant_temporary_burst_quota', 'Tenants', 'Operator', 'Grant 24-hour temporary API burst allowance during customer migration.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'tenants_inspect_feature_flags', 'Tenants', 'Viewer', 'List active feature flag overrides and recent rollouts for a tenant.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'tenants_revert_feature_flag', 'Tenants', 'Admin', 'Disable a newly rolled-out feature flag causing errors for a tenant.', 'flag_key', 'Feature flag key'),
  makePackTool('B2B SaaS Pack', 'tenants_check_audit_log_stream', 'Tenants', 'Viewer', 'Verify enterprise SIEM audit log delivery status and last checkpoint.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'tenants_check_custom_domain_tls', 'Tenants', 'Viewer', 'Check TLS certificate expiration and DNS validation for white-label domains.', 'domain', 'Custom domain'),
  makePackTool('B2B SaaS Pack', 'tenants_renew_custom_domain_cert', 'Tenants', 'Admin', 'Trigger automated ACME TLS certificate renewal for a custom domain.', 'domain', 'Custom domain'),
  // Billing, Usage & Subscriptions (12)
  makePackTool('B2B SaaS Pack', 'billing_inspect_usage_metering', 'Billing', 'Viewer', 'Inspect usage-based metering ingestion lag and duplicate event detection.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'billing_audit_invoice_proration', 'Billing', 'Operator', 'Audit mid-cycle seat upgrade proration line items on draft or open invoices.', 'invoice_id', 'Invoice identifier'),
  makePackTool('B2B SaaS Pack', 'billing_issue_sla_credit_memo', 'Billing', 'Operator', 'Generate an SLA service credit memo for verified downtime.', 'invoice_id', 'Invoice identifier'),
  makePackTool('B2B SaaS Pack', 'billing_check_ach_settlement', 'Billing', 'Operator', 'Check pending enterprise ACH/wire settlement status and clearing ETA.', 'payment_ref', 'Payment reference ID'),
  makePackTool('B2B SaaS Pack', 'billing_pause_dunning_lockout', 'Billing', 'Operator', 'Extend invoice grace period by 7 days to prevent workspace read-only lockout.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'billing_reconcile_seat_overage', 'Billing', 'Operator', 'Reconcile active licensed seats against billed subscription quantity.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'billing_check_webhook_sync', 'Billing', 'Viewer', 'Verify billing provider webhook event processing and lag.', 'event_type', 'Billing webhook event type'),
  makePackTool('B2B SaaS Pack', 'billing_replay_invoice_webhooks', 'Billing', 'Admin', 'Replay missed billing webhooks to sync subscription entitlements.', 'window_hours', 'Lookback hours'),
  makePackTool('B2B SaaS Pack', 'contracts_inspect_plan_entitlements', 'Billing', 'Viewer', 'Check contracted module entitlements and API rate tier.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'contracts_sync_crm_renewal_state', 'Billing', 'Operator', 'Sync signed annual renewal terms into active tenant entitlements.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'billing_check_tax_exemption_cert', 'Billing', 'Viewer', 'Verify uploaded VAT/tax exemption certificate validation state.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'billing_void_duplicate_invoice', 'Billing', 'Admin', 'Void a confirmed duplicate invoice generated by retry race condition.', 'invoice_id', 'Invoice identifier'),
  // API Gateway, Webhooks & Integrations (12)
  makePackTool('B2B SaaS Pack', 'api_inspect_rate_limit_spikes', 'API', 'Viewer', 'Inspect 429 rate-limit hits grouped by endpoint and token prefix.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'api_check_gateway_5xx_traces', 'API', 'Viewer', 'Fetch aggregated 5xx error signatures and upstream timeouts.', 'service', 'API microservice name'),
  makePackTool('B2B SaaS Pack', 'webhooks_inspect_delivery_failures', 'Webhooks', 'Viewer', 'Inspect customer webhook endpoint HTTP failures, TLS errors, and backoff.', 'subscription_id', 'Webhook subscription ID'),
  makePackTool('B2B SaaS Pack', 'webhooks_replay_dead_letters', 'Webhooks', 'Operator', 'Replay dead-lettered webhook events once customer endpoint recovers.', 'subscription_id', 'Webhook subscription ID'),
  makePackTool('B2B SaaS Pack', 'webhooks_reset_circuit_breaker', 'Webhooks', 'Operator', 'Reset auto-paused webhook circuit breaker after endpoint verification.', 'subscription_id', 'Webhook subscription ID'),
  makePackTool('B2B SaaS Pack', 'connectors_check_oauth_token_health', 'Integrations', 'Viewer', 'Check external connector OAuth refresh token validity and scope drift.', 'connector_id', 'Connector identifier'),
  makePackTool('B2B SaaS Pack', 'connectors_inspect_sync_cursor', 'Integrations', 'Viewer', 'Inspect incremental data sync cursor lag and last successful checkpoint.', 'connector_id', 'Connector identifier'),
  makePackTool('B2B SaaS Pack', 'connectors_trigger_backfill_sync', 'Integrations', 'Operator', 'Queue bounded incremental backfill for missed connector sync window.', 'connector_id', 'Connector identifier'),
  makePackTool('B2B SaaS Pack', 'exports_check_async_report_jobs', 'Analytics', 'Viewer', 'Inspect long-running CSV/PDF export worker status and memory spikes.', 'job_id', 'Export job ID'),
  makePackTool('B2B SaaS Pack', 'exports_retry_timed_out_report', 'Analytics', 'Operator', 'Retry failed analytics export on high-memory worker pool.', 'job_id', 'Export job ID'),
  makePackTool('B2B SaaS Pack', 'search_inspect_index_lag', 'Search', 'Viewer', 'Check full-text workspace search indexing delay and shard health.', 'cluster', 'Search cluster name'),
  makePackTool('B2B SaaS Pack', 'search_reindex_tenant_documents', 'Search', 'Admin', 'Trigger background document reindex for a workspace shard.', 'tenant_id', 'Tenant workspace identifier'),
  // Infrastructure & Reliability (12)
  makePackTool('B2B SaaS Pack', 'infra_check_recent_deployments', 'Platform', 'Viewer', 'Inspect recent production deployments and automated canary metrics.', 'service', 'Service name'),
  makePackTool('B2B SaaS Pack', 'infra_rollback_service_release', 'Platform', 'Admin', 'Roll back service deployment to last verified healthy revision.', 'service', 'Service name'),
  makePackTool('B2B SaaS Pack', 'infra_inspect_db_replica_lag', 'Platform', 'Viewer', 'Check read-replica replication lag and slow query digests.', 'shard', 'Database shard'),
  makePackTool('B2B SaaS Pack', 'infra_check_queue_consumer_lag', 'Platform', 'Viewer', 'Inspect background job queue depth and consumer throughput.', 'queue_name', 'Queue name'),
  makePackTool('B2B SaaS Pack', 'infra_scale_worker_pool', 'Platform', 'Admin', 'Temporarily increase worker pool concurrency to drain queue backlog.', 'queue_name', 'Queue name'),
  makePackTool('B2B SaaS Pack', 'infra_inspect_cache_evictions', 'Platform', 'Viewer', 'Check Redis/in-memory cache eviction rate and hot-key pressure.', 'cluster', 'Cache cluster'),
  makePackTool('B2B SaaS Pack', 'infra_flush_corrupted_tenant_cache', 'Platform', 'Admin', 'Invalidate stale cached permissions for a specific tenant namespace.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'infra_check_status_page_components', 'Status', 'Viewer', 'Check public status page component states and open incidents.', 'component', 'Status component name'),
  makePackTool('B2B SaaS Pack', 'infra_draft_status_page_update', 'Status', 'Operator', 'Prepare plain-English customer status page advisory draft.', 'component', 'Status component name'),
  makePackTool('B2B SaaS Pack', 'security_inspect_waf_blocks', 'Security', 'Viewer', 'Inspect WAF rule triggers blocking legitimate API traffic.', 'rule_id', 'WAF rule ID'),
  makePackTool('B2B SaaS Pack', 'security_allowlist_customer_cidr', 'Security', 'Admin', 'Add verified enterprise egress IP CIDR to tenant allowlist.', 'tenant_id', 'Tenant workspace identifier'),
  makePackTool('B2B SaaS Pack', 'security_rotate_tenant_api_key', 'Security', 'Admin', 'Revoke leaked API key and issue staged replacement notice.', 'key_prefix', 'API key prefix'),
];

const LOGISTICS_TOOLS: DeferredTool[] = [
  // Fleet, Routing & Dispatch (12)
  makePackTool('Logistics Pack', 'dispatch_inspect_route_delays', 'Dispatch', 'Viewer', 'Inspect active route delay alerts, weather holds, and ETA drift by hub.', 'hub_id', 'Regional hub identifier'),
  makePackTool('Logistics Pack', 'dispatch_check_manifest_locks', 'Dispatch', 'Viewer', 'Check locked outbound truck manifests blocking dock departure.', 'manifest_id', 'Manifest ID'),
  makePackTool('Logistics Pack', 'dispatch_rebalance_driver_stops', 'Dispatch', 'Operator', 'Rebalance unassigned last-mile stops across nearby active routes.', 'zone_id', 'Delivery zone ID'),
  makePackTool('Logistics Pack', 'dispatch_unlock_stalled_manifest', 'Dispatch', 'Admin', 'Force-release stalled manifest lock after verifying dock scan count.', 'manifest_id', 'Manifest ID'),
  makePackTool('Logistics Pack', 'fleet_check_telematics_stream', 'Fleet', 'Viewer', 'Inspect vehicle GPS/telematics heartbeat lag and offline transponders.', 'region', 'Operating region'),
  makePackTool('Logistics Pack', 'fleet_inspect_cold_chain_sensors', 'Cold Chain', 'Viewer', 'Read refrigerated trailer temperature excursion logs and sensor health.', 'trailer_id', 'Trailer identifier'),
  makePackTool('Logistics Pack', 'fleet_escalate_temp_excursion', 'Cold Chain', 'Operator', 'Flag cold-chain shipment for immediate QA inspection at next hub.', 'shipment_id', 'Shipment ID'),
  makePackTool('Logistics Pack', 'fleet_check_yard_gate_queue', 'Yard', 'Viewer', 'Inspect dock door congestion and average trailer check-in wait time.', 'hub_id', 'Regional hub identifier'),
  makePackTool('Logistics Pack', 'fleet_assign_overflow_dock', 'Yard', 'Operator', 'Assign arriving linehaul trailer to available overflow dock door.', 'trailer_id', 'Trailer identifier'),
  makePackTool('Logistics Pack', 'routing_check_geofence_engine', 'Routing', 'Viewer', 'Inspect address geocoding error rate and route solver latency.', 'region', 'Operating region'),
  makePackTool('Logistics Pack', 'routing_fallback_cached_matrix', 'Routing', 'Admin', 'Switch route optimizer to cached distance matrix during maps API latency.', 'region', 'Operating region'),
  makePackTool('Logistics Pack', 'routing_verify_hazmat_restrictions', 'Compliance', 'Viewer', 'Verify route compliance against hazmat tunnel and bridge restrictions.', 'route_id', 'Route identifier'),
  // Warehouse & WMS (12)
  makePackTool('Logistics Pack', 'wms_inspect_scanner_sync_lag', 'Warehouse', 'Viewer', 'Inspect handheld RF barcode scanner sync errors and dropped scans.', 'facility_id', 'Warehouse facility ID'),
  makePackTool('Logistics Pack', 'wms_check_conveyor_sorter_faults', 'Warehouse', 'Viewer', 'Read automated sortation lane divert fault counts and jam alerts.', 'facility_id', 'Warehouse facility ID'),
  makePackTool('Logistics Pack', 'wms_check_wave_release_status', 'Warehouse', 'Viewer', 'Check outbound pick-wave generation progress and stalled orders.', 'wave_id', 'Pick wave identifier'),
  makePackTool('Logistics Pack', 'wms_requeue_failed_label_prints', 'Warehouse', 'Operator', 'Re-route failed shipping label print jobs to backup dock printer.', 'station_id', 'Pack station ID'),
  makePackTool('Logistics Pack', 'wms_audit_bin_inventory_drift', 'Warehouse', 'Viewer', 'Compare cycle-count scan totals against expected WMS bin quantities.', 'bin_id', 'Warehouse bin code'),
  makePackTool('Logistics Pack', 'wms_hold_damaged_pallet', 'Warehouse', 'Operator', 'Place damaged pallet on QA quarantine hold and notify replenishment.', 'pallet_id', 'Pallet ID'),
  makePackTool('Logistics Pack', 'wms_restart_edi_intake_bridge', 'Warehouse', 'Admin', 'Restart stalled EDI 940/945 warehouse order intake bridge.', 'facility_id', 'Warehouse facility ID'),
  makePackTool('Logistics Pack', 'wms_check_dock_appointment_slots', 'Warehouse', 'Viewer', 'Inspect carrier inbound receiving appointment utilization.', 'facility_id', 'Warehouse facility ID'),
  makePackTool('Logistics Pack', 'wms_reschedule_carrier_window', 'Warehouse', 'Operator', 'Shift delayed inbound carrier appointment to next open receiving bay.', 'appointment_id', 'Appointment ID'),
  makePackTool('Logistics Pack', 'wms_check_robotics_amr_fleet', 'Automation', 'Viewer', 'Check autonomous warehouse mobile robot battery and traffic deadlocks.', 'zone_id', 'Warehouse zone'),
  makePackTool('Logistics Pack', 'wms_clear_amr_aisle_deadlock', 'Automation', 'Admin', 'Issue safe path recalculation to clear autonomous robot aisle stall.', 'zone_id', 'Warehouse zone'),
  makePackTool('Logistics Pack', 'wms_verify_pack_weight_variance', 'Quality', 'Viewer', 'Check scale weight variance alerts indicating mis-packed cartons.', 'shipment_id', 'Shipment ID'),
  // Carriers, Customs & Freight Billing (12)
  makePackTool('Logistics Pack', 'carrier_inspect_edi_214_feed', 'Carriers', 'Viewer', 'Inspect carrier EDI 214 milestone status feed latency and parse errors.', 'carrier_code', 'SCAC carrier code'),
  makePackTool('Logistics Pack', 'carrier_check_api_rate_timeouts', 'Carriers', 'Viewer', 'Check parcel/freight carrier rating and tracking API timeout metrics.', 'carrier_code', 'SCAC carrier code'),
  makePackTool('Logistics Pack', 'carrier_switch_backup_tender', 'Carriers', 'Operator', 'Re-tender unaccepted freight load to secondary contracted carrier.', 'load_id', 'Freight load ID'),
  makePackTool('Logistics Pack', 'customs_inspect_broker_holds', 'Customs', 'Viewer', 'Inspect cross-border customs clearance holds and missing HS codes.', 'shipment_id', 'Shipment ID'),
  makePackTool('Logistics Pack', 'customs_resubmit_commercial_invoice', 'Customs', 'Operator', 'Transmit corrected digital commercial invoice packet to customs broker.', 'shipment_id', 'Shipment ID'),
  makePackTool('Logistics Pack', 'customs_check_sanctions_screening', 'Compliance', 'Viewer', 'Check automated denied-party trade screening queue latency.', 'batch_id', 'Screening batch ID'),
  makePackTool('Logistics Pack', 'freight_audit_invoice_variance', 'Finance', 'Operator', 'Audit carrier freight invoice accessorial charges against quoted rate.', 'invoice_id', 'Freight invoice ID'),
  makePackTool('Logistics Pack', 'freight_approve_detention_claim', 'Finance', 'Operator', 'Review GPS arrival/departure timestamps for carrier detention billing.', 'load_id', 'Freight load ID'),
  makePackTool('Logistics Pack', 'freight_dispute_duplicate_bill', 'Finance', 'Operator', 'Open automated billing dispute for duplicate freight bill of lading.', 'invoice_id', 'Freight invoice ID'),
  makePackTool('Logistics Pack', 'claims_inspect_osnd_report', 'Claims', 'Viewer', 'Inspect overage, shortage, and damage (OS&D) intake evidence.', 'claim_id', 'Claim identifier'),
  makePackTool('Logistics Pack', 'claims_issue_freight_credit', 'Claims', 'Operator', 'Issue approved shipper credit for verified transit loss claim.', 'claim_id', 'Claim identifier'),
  makePackTool('Logistics Pack', 'carrier_rotate_edi_sftp_key', 'Security', 'Admin', 'Rotate expiring carrier EDI SFTP transport key safely.', 'carrier_code', 'SCAC carrier code'),
  // Customer Tracking & Platform (10)
  makePackTool('Logistics Pack', 'tracking_check_webhook_backlog', 'Tracking', 'Viewer', 'Check outbound customer tracking milestone webhook queue depth.', 'tenant_id', 'Shipper account ID'),
  makePackTool('Logistics Pack', 'tracking_replay_milestone_events', 'Tracking', 'Operator', 'Replay delayed delivery confirmation events to shipper webhooks.', 'tenant_id', 'Shipper account ID'),
  makePackTool('Logistics Pack', 'tracking_verify_pod_photo_upload', 'Tracking', 'Viewer', 'Verify proof-of-delivery signature and photo blob sync state.', 'shipment_id', 'Shipment ID'),
  makePackTool('Logistics Pack', 'notifications_check_sms_delivery', 'Messaging', 'Viewer', 'Check recipient delivery-window SMS notification delivery rate.', 'region', 'Operating region'),
  makePackTool('Logistics Pack', 'platform_check_recent_deployments', 'Platform', 'Viewer', 'Inspect recent dispatch/WMS backend releases and error rate delta.', 'service', 'Service name'),
  makePackTool('Logistics Pack', 'platform_rollback_service_release', 'Platform', 'Admin', 'Roll back faulty logistics microservice release to prior stable version.', 'service', 'Service name'),
  makePackTool('Logistics Pack', 'platform_check_db_connection_pool', 'Platform', 'Viewer', 'Inspect shipment tracking database pool utilization and lock contention.', 'cluster', 'Database cluster'),
  makePackTool('Logistics Pack', 'platform_scale_ingestion_workers', 'Platform', 'Admin', 'Scale EDI and telematics ingestion workers to clear peak wave backlog.', 'queue_name', 'Worker queue name'),
  makePackTool('Logistics Pack', 'platform_check_partner_api_certs', 'Platform', 'Viewer', 'Check mutual TLS client certificate expiry for carrier gateways.', 'carrier_code', 'SCAC carrier code'),
  makePackTool('Logistics Pack', 'platform_purge_stale_eta_cache', 'Platform', 'Admin', 'Clear stale transit-time ETA cache entries after weather reroute.', 'hub_id', 'Regional hub identifier'),
];

export const INDUSTRY_PACKS: Record<IndustryPackId, IndustryPackMeta> = {
  ecommerce: {
    id: 'ecommerce',
    name: 'E-Commerce',
    tagline: 'Checkout, payments, inventory holds, shipping labels & order webhooks',
    channels: ['#checkout-alerts', '#payments-ops', '#fulfillment-feed'],
    tools: ECOMMERCE_TOOLS,
  },
  saas: {
    id: 'saas',
    name: 'B2B SaaS',
    tagline: 'SSO/SCIM, usage billing, API rate limits, customer webhooks & tenants',
    channels: ['#enterprise-support', '#billing-ops', '#api-reliability'],
    tools: SAAS_TOOLS,
  },
  logistics: {
    id: 'logistics',
    name: 'Logistics',
    tagline: 'Dispatch hubs, WMS scanners, cold-chain sensors, EDI & freight billing',
    channels: ['#dispatch-hub', '#wms-alerts', '#freight-finance'],
    tools: LOGISTICS_TOOLS,
  },
};

export function getAllowedToolRoles(activeRole: TriageRole): ToolRoleTag[] {
  switch (activeRole) {
    case 'Support':
      return ['Viewer'];
    case 'Finance Lead':
      return ['Viewer', 'Operator'];
    case 'Admin':
      return ['Viewer', 'Operator', 'Admin'];
  }
}

export function filterToolsByRole(tools: DeferredTool[], activeRole: TriageRole): DeferredTool[] {
  const allowed = new Set(getAllowedToolRoles(activeRole));
  return tools.filter((tool) => allowed.has(tool.roleTag));
}

function inferRoleFromMethodAndPath(method: string, pathKey: string, fallback: ToolRoleTag): ToolRoleTag {
  const m = method.toUpperCase();
  const lowerPath = pathKey.toLowerCase();
  if (m === 'DELETE' || lowerPath.includes('admin') || lowerPath.includes('rollback') || lowerPath.includes('rotate')) {
    return 'Admin';
  }
  if (m === 'GET' || m === 'HEAD') {
    return 'Viewer';
  }
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
    return fallback === 'Admin' ? 'Admin' : 'Operator';
  }
  return fallback;
}

export function parseOpenApiToTools(
  rawJson: string,
  defaultRole: ToolRoleTag = 'Operator'
): { connectorName: string; baseUrl: string; tools: DeferredTool[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid JSON syntax. Please paste a valid OpenAPI 3.0 or Swagger 2.0 JSON document.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAPI specification must be a JSON object.');
  }

  const doc = parsed as Record<string, unknown>;
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) {
    throw new Error('OpenAPI specification must include a non-empty "paths" object.');
  }

  const info = (doc.info && typeof doc.info === 'object' ? doc.info : {}) as Record<string, unknown>;
  const connectorName =
    typeof info.title === 'string' && info.title.trim().length > 0
      ? info.title.trim().slice(0, 80)
      : 'Imported OpenAPI Service';

  let baseUrl = 'https://api.example.internal';
  if (Array.isArray(doc.servers) && doc.servers[0] && typeof (doc.servers[0] as Record<string, unknown>).url === 'string') {
    baseUrl = String((doc.servers[0] as Record<string, unknown>).url);
  } else if (typeof doc.host === 'string') {
    baseUrl = `https://${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`;
  }

  const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];
  const tools: DeferredTool[] = [];

  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of httpMethods) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (!op || typeof op !== 'object') continue;
      const operation = op as Record<string, unknown>;
      const rawId =
        typeof operation.operationId === 'string' && operation.operationId.trim()
          ? operation.operationId.trim()
          : `${method}_${pathKey.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      const safeName = rawId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
      const summary =
        typeof operation.summary === 'string' && operation.summary.trim()
          ? operation.summary.trim()
          : typeof operation.description === 'string' && operation.description.trim()
            ? operation.description.trim()
            : `${method.toUpperCase()} ${pathKey}`;

      const properties: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];
      if (Array.isArray(operation.parameters)) {
        for (const param of operation.parameters) {
          if (param && typeof param === 'object') {
            const p = param as Record<string, unknown>;
            if (typeof p.name === 'string') {
              properties[p.name] = {
                type: 'string',
                description: typeof p.description === 'string' ? p.description : `Parameter ${p.name}`,
              };
              if (p.required === true) required.push(p.name);
            }
          }
        }
      }
      if (Object.keys(properties).length === 0) {
        properties.resource_id = {
          type: 'string',
          description: `Target resource identifier for ${method.toUpperCase()} ${pathKey}`,
        };
      }

      const tags = Array.isArray(operation.tags) && typeof operation.tags[0] === 'string' ? operation.tags[0] : 'OpenAPI';
      const roleTag = inferRoleFromMethodAndPath(method, pathKey, defaultRole);

      tools.push({
        name: safeName,
        description: `${summary} (${method.toUpperCase()} ${pathKey})`,
        category: tags,
        roleTag,
        defer_loading: true,
        sourceType: 'openapi',
        sourceName: connectorName,
        endpointHint: `${method.toUpperCase()} ${baseUrl.replace(/\/$/, '')}${pathKey}`,
        parameters: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      });
    }
  }

  if (tools.length === 0) {
    throw new Error('No supported HTTP operations (GET, POST, PUT, PATCH, DELETE) were found in the OpenAPI spec.');
  }

  return { connectorName, baseUrl, tools };
}

export function createMcpServerTools(
  serverName: string,
  serverUrl: string,
  roleAccess: ToolRoleTag
): { connector: RegisteredConnector; tools: DeferredTool[] } {
  const cleanSlug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28) || 'remote_mcp';

  const tools: DeferredTool[] = [
    {
      name: `mcp_${cleanSlug}_inspect_health`,
      description: `Query diagnostic telemetry and error metrics from ${serverName} (${serverUrl}).`,
      category: 'Remote MCP',
      roleTag: 'Viewer',
      defer_loading: true,
      sourceType: 'mcp',
      sourceName: serverName,
      endpointHint: serverUrl,
      parameters: {
        type: 'object',
        properties: {
          resource_ref: { type: 'string', description: 'Protected resource or incident reference' },
        },
        required: ['resource_ref'],
      },
    },
    {
      name: `mcp_${cleanSlug}_fetch_logs`,
      description: `Fetch scrubbed recent audit and execution logs from ${serverName}.`,
      category: 'Remote MCP',
      roleTag: 'Viewer',
      defer_loading: true,
      sourceType: 'mcp',
      sourceName: serverName,
      endpointHint: serverUrl,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Scrubbed search query' },
        },
        required: ['query'],
      },
    },
    {
      name: `mcp_${cleanSlug}_run_remediation`,
      description: `Execute approved remediation action via remote MCP server ${serverName}.`,
      category: 'Remote MCP',
      roleTag: roleAccess,
      defer_loading: true,
      sourceType: 'mcp',
      sourceName: serverName,
      endpointHint: serverUrl,
      parameters: {
        type: 'object',
        properties: {
          action_id: { type: 'string', description: 'Remediation workflow ID' },
        },
        required: ['action_id'],
      },
    },
  ];

  const connector: RegisteredConnector = {
    id: `mcp_${cleanSlug}_${Date.now().toString(36)}`,
    name: serverName.trim(),
    kind: 'mcp',
    endpointUrl: serverUrl.trim(),
    deferLoading: true,
    roleAccess,
    toolCount: tools.length,
    addedAtIso: new Date().toISOString(),
  };

  return { connector, tools };
}

export function generateSlackManifestYaml(
  workspaceId: string,
  appUrl: string,
  botName = 'EdgeOps',
  options: { socketMode?: boolean } = {}
): string {
  const safeBase = appUrl.replace(/\/$/, '');
  const webhookUrl = `${safeBase}/webhooks/slack/${workspaceId}`;
  const cleanBot = botName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'EdgeOps';
  const socketMode = Boolean(options.socketMode);

  return `display_information:
  name: ${cleanBot}
  description: Zero-Data-Retention, read-only local-first Hybrid AI Ops & Incident Triage assistant
  background_color: "#2563EB"
features:
  bot_user:
    display_name: ${cleanBot}
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - channels:read
      - groups:read
settings:
  event_subscriptions:
    ${socketMode ? '# Socket Mode enabled — zero public webhook URL needed\n    ' : `request_url: ${webhookUrl}\n    `}bot_events:
      - app_mention
      - message.channels
  org_deploy_enabled: false
  socket_mode_enabled: ${socketMode ? 'true' : 'false'}
  token_rotation_enabled: false`;
}

export const SAMPLE_OPENAPI_SPEC = JSON.stringify(
  {
    openapi: '3.0.3',
    info: {
      title: 'Internal Billing & Ledger API',
      version: '1.4.0',
    },
    servers: [{ url: 'https://ops-api.yourcompany.internal/v1' }],
    paths: {
      '/ledger/transactions/{txId}': {
        get: {
          operationId: 'ledger_get_transaction_state',
          summary: 'Inspect ledger transaction state and settlement confirmations',
          tags: ['Ledger'],
          parameters: [
            { name: 'txId', in: 'path', required: true, description: 'Tokenized transaction reference' },
          ],
        },
      },
      '/ledger/reconcile': {
        post: {
          operationId: 'ledger_trigger_reconciliation',
          summary: 'Reconcile mismatched payment holds against open invoices',
          tags: ['Ledger'],
          parameters: [
            { name: 'batchId', in: 'query', required: true, description: 'Settlement batch identifier' },
          ],
        },
      },
      '/admin/webhooks/rotate-key': {
        delete: {
          operationId: 'admin_revoke_compromised_webhook_key',
          summary: 'Revoke an expired or leaked webhook signing key immediately',
          tags: ['Security'],
          parameters: [
            { name: 'keyId', in: 'query', required: true, description: 'Webhook key ID' },
          ],
        },
      },
    },
  },
  null,
  2
);

const PAST_TENSE_VERBS: Record<string, string> = {
  check: 'Checked',
  inspect: 'Inspected',
  verify: 'Verified',
  lookup: 'Looked up',
  get: 'Looked up',
  fetch: 'Checked',
  list: 'Listed',
  query: 'Checked',
  read: 'Read',
  trace: 'Traced',
  audit: 'Audited',
  monitor: 'Monitored',
  analyze: 'Analyzed',
  diagnose: 'Diagnosed',
  reconcile: 'Reconciled',
  issue: 'Issued',
  void: 'Voided',
  release: 'Released',
  refund: 'Refunded',
  retry: 'Retried',
  replay: 'Replayed',
  sync: 'Synced',
  resync: 'Resynced',
  reset: 'Reset',
  rotate: 'Rotated',
  revoke: 'Revoked',
  failover: 'Checked failover for',
  reroute: 'Rerouted',
  pause: 'Paused',
  resume: 'Resumed',
  cancel: 'Canceled',
  update: 'Updated',
  create: 'Created',
  trigger: 'Triggered',
  send: 'Sent',
  notify: 'Notified',
  escalate: 'Escalated',
  adjust: 'Adjusted',
  unlock: 'Unlocked',
  clear: 'Cleared',
  rebuild: 'Rebuilt',
  restore: 'Restored',
  validate: 'Validated',
  compare: 'Compared',
};

const DOMAIN_MODIFIERS: Record<string, string> = {
  payments: 'payment',
  orders: 'order',
  inventory: 'inventory',
  shipping: 'shipping',
  billing: 'billing',
  auth: 'sign-in',
  sso: 'SSO',
  webhooks: 'webhook',
  api: 'API',
  tenants: 'workspace',
  dispatch: 'dispatch',
  fleet: 'fleet',
  warehouse: 'warehouse',
  coldchain: 'cold-chain',
  edi: 'EDI',
  customs: 'customs',
  ledger: 'ledger',
  support: 'support',
  customers: 'customer',
};

const ACRONYMS: Record<string, string> = {
  sso: 'SSO',
  scim: 'SCIM',
  api: 'API',
  edi: 'EDI',
  wms: 'WMS',
  eu: 'EU',
  us: 'US',
  sla: 'SLA',
  id: 'ID',
  ids: 'IDs',
  ip: 'IP',
  url: 'URL',
  webhook: 'webhook',
  webhooks: 'webhooks',
  auth: 'authorization',
};

function formatHumanWords(words: string[]): string {
  return words
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ');
}

/**
 * Converts a raw snake_case tool identifier (e.g. "payments_check_duplicate_holds")
 * into a warm, plain-English past-tense check title ("Checked duplicate payment holds").
 */
export function humanizeToolName(toolName: string): string {
  const tokens = toolName
    .toLowerCase()
    .replace(/^mcp_/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (tokens.length === 0) return 'Ran smart check';

  const verbIdx = tokens.findIndex((t) => t in PAST_TENSE_VERBS);
  if (verbIdx >= 0) {
    const verb = PAST_TENSE_VERBS[tokens[verbIdx]];
    const prefix = tokens.slice(0, verbIdx).filter((t) => t !== 'admin');
    const rest = tokens.slice(verbIdx + 1);

    const modifier = prefix.length > 0 ? DOMAIN_MODIFIERS[prefix[prefix.length - 1]] ?? prefix[prefix.length - 1] : '';
    const restAlreadyMentionsDomain =
      modifier.length > 0 &&
      rest.some((w) => w === modifier.toLowerCase() || w.startsWith(modifier.toLowerCase().slice(0, 4)));

    if (modifier && !restAlreadyMentionsDomain && rest.length >= 2) {
      // Insert domain modifier naturally before the noun (e.g. "duplicate payment holds")
      const combined = [...rest.slice(0, rest.length - 1), modifier, rest[rest.length - 1]];
      return `${verb} ${formatHumanWords(combined)}`;
    }
    if (modifier && !restAlreadyMentionsDomain) {
      return `${verb} ${formatHumanWords([modifier, ...rest])}`;
    }
    return `${verb} ${formatHumanWords(rest.length > 0 ? rest : prefix)}`.trim();
  }

  const formatted = formatHumanWords(tokens);
  return `Checked ${formatted}`;
}

/**
 * Converts a raw snake_case tool identifier into a clean present-tense catalog label
 * (e.g. "payments_check_duplicate_holds" -> "Check duplicate payment holds").
 */
export function humanizeToolTitle(toolName: string): string {
  const past = humanizeToolName(toolName);
  const replacements: Array<[RegExp, string]> = [
    [/^Checked failover for /, 'Failover '],
    [/^Checked /, 'Check '],
    [/^Inspected /, 'Inspect '],
    [/^Verified /, 'Verify '],
    [/^Looked up /, 'Look up '],
    [/^Listed /, 'List '],
    [/^Traced /, 'Trace '],
    [/^Audited /, 'Audit '],
    [/^Monitored /, 'Monitor '],
    [/^Reconciled /, 'Reconcile '],
    [/^Issued /, 'Issue '],
    [/^Voided /, 'Void '],
    [/^Released /, 'Release '],
    [/^Refunded /, 'Refund '],
    [/^Retried /, 'Retry '],
    [/^Replayed /, 'Replay '],
    [/^Synced /, 'Sync '],
    [/^Rotated /, 'Rotate '],
    [/^Revoked /, 'Revoke '],
    [/^Rerouted /, 'Reroute '],
    [/^Paused /, 'Pause '],
    [/^Resumed /, 'Resume '],
    [/^Canceled /, 'Cancel '],
    [/^Updated /, 'Update '],
    [/^Created /, 'Create '],
    [/^Triggered /, 'Trigger '],
    [/^Validated /, 'Validate '],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(past)) {
      return past.replace(pattern, replacement);
    }
  }
  return past;
}


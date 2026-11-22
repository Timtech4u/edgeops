# CalmDuty Engineering Roadmap

CalmDuty follows an open-core model (MIT self-hostable core + optional managed cloud and enterprise `ee/` compliance modules).

---

## Phase 0 — Zero-Data-Retention & `#BuildHybridAI 2026` Foundation ✅ Complete
- [x] On-device Privacy Shield (`PREFER_ON_DEVICE` · Gemini Nano on Web & Pixel Android)
- [x] `gemini-decision-1` parallel 4-signal triage & Dynamic Tool Retrieval (`0` output tokens)
- [x] Smart duplicate grouping (`×N` threads with collapsible occurrence-diff timelines)
- [x] Sub-second streaming Triage Chat (`gemini-3.5-flash-lite`) + Global Proactive Copilot FAB + native Web/Android notifications
- [x] Zero-retention hardening: `store: false` on every cloud Gemini call, strictly read-only Slack OAuth scopes, AES-256-GCM tenant-bound token wrapping, `±300s` webhook replay protection, zero `rawMessage` in Android Firestore, `android:allowBackup="false"`
- [x] 1-click Judge Sandbox Workspace, `Dockerfile`, `app.json` (1-click Cloud Run), `docker-compose.yml` (with Ollama sidecar), CI workflows, and full documentation (`docs/`)
- [x] Direct downloadable Android APK published via GitHub Releases (`v0.1.0`)

---

## Phase 1 — True Zero-Storage Local Vault & Multi-Channel Ingestion *(Next)*
- [ ] **Local Encrypted Vaults:** Migrate Web incident cache to Dexie + Web Crypto `AES-256-GCM` IndexedDB and Android to Room + SQLCipher + Android Keystore (`StrongBox`/`TEE`).
- [ ] **Blind Cross-Device State Sync:** Switch Web and Android clients onto the already-tested `/orgs/{orgId}/alert_states/{alertHash}` zero-knowledge Firestore collection (30-day TTL).
- [ ] **Zero-Trust Server Auth Middleware:** Enforce server-side `firebase-admin` ID Token + `X-Firebase-AppCheck` validation on every `/api/*` endpoint.
- [ ] **Zero-Firebase Self-Host Driver & CLI:** Ship `EDGEOPS_STORAGE_DRIVER=local` (encrypted SQLite), Slack Socket Mode runner, and `npx @calmduty/cli` launcher.
- [ ] **Multi-Channel `IngestionAdapter` Pack:** Ship read-only **GitHub Actions/Issues**, **Email (IMAP / Resend)**, **Sentry**, **Linear**, and **Generic HMAC JSONPath Webhook** adapters.

---

## Phase 2 — Team Cloud & Open-Core Enterprise (`ee/`)
- [ ] **E2EE Cross-Device Team Sync:** Org-shared `AES-256-GCM` key (QR / `#k=` exchange) for encrypted shared investigation notes, assignments, and 15-min TTL X25519 offline webhook buffer.
- [ ] **Microsoft Teams Graph Delta Adapter** (`ChannelMessage.Read.All`).
- [ ] **Enterprise Compliance (`ee/`):** BYOK Google Cloud KMS kill-switch keys, SAML 2.0 / OIDC SSO + SCIM provisioning, Role-Based Approval Gates for MCP/OpenAPI write executions, Vertex AI Enterprise ZDR, and zero-PII SIEM audit streams.

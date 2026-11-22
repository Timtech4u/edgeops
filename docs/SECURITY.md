# Zero-Data-Retention Security Architecture

> **Core Principle:** *"Can't leak what you don't store."*

CalmDuty is engineered so that operational alert content stays private on your devices while cloud inference remains stateless and non-retained.

---

## 1. Enforced Security Controls (Shipped Today)

| Control | Implementation | Where to Audit |
| :--- | :--- | :--- |
| **On-Device PII Firewall** | Strips Slack markup and redacts emails, phone numbers, card digits, account IDs, and API tokens locally before any cloud call. | `src/lib/privacyShield.ts` & Android `LocalPrivacyShield.kt` |
| **Zero-Retention Cloud AI (`store: false`)** | Explicitly sets `store: false` on every `/api/chat` (Interactions API) and `/api/investigate` (`generateContent`) request. | `server.ts` (`generateContentWithTimeout` & `/api/chat`) |
| **Strictly Read-Only Slack Scopes** | Default OAuth & manifest request only `app_mentions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read` — zero write scopes. | `server.ts` (`SLACK_OAUTH_SCOPES`) & `src/lib/toolRegistry.ts` |
| **AES-256-GCM OAuth Token Encryption** | Stored Slack tokens are encrypted with per-tenant `orgId` AAD (`edgeops:v1:<orgId>`) in server-only Firestore (`allow read, write: if false` for clients); zero disk token files in production. | `src/lib/slackStore.ts` & `firestore.rules` |
| **Webhook Replay & Zero-Raw-RAM Guard** | Slack webhooks verify timing-safe HMAC-SHA256 + `±300s` replay window and stream ephemerally via SSE with zero `rawText` retained in memory. | `server.ts` (`verifySlackSignature` & `/webhooks/slack/:orgId`) |
| **Zero Raw PII in Android Firestore** | Android keeps unredacted `rawMessage` strictly in an on-device RAM vault; `firestore.rules` reject `rawMessage` and Slack tokens; `android:allowBackup="false"` disables Google Drive backups. | `EdgeOpsRepository.kt`, `AndroidManifest.xml`, Android `firestore.rules` |
| **Zero-Knowledge Sync Rules Ready** | `/orgs/{orgId}/alert_states/{alertHash}` enforces blind HMAC-SHA256 IDs + status/bucket enums only (forbidding any text/PII fields), verified across 38 Firestore Emulator assertions. | `firestore.rules` & `firestore.rules.test.ts` |

---

## 2. Verifying Privacy Yourself in 30 Seconds

1. Open CalmDuty in Chrome and press **F12 → Network**.
2. Click **Try Sandbox** → open the EU Payment Gateway alert (`4 details hidden`).
3. Click **Summarize all 3 alerts** in Triage Chat and inspect the `POST /api/chat` JSON payload:
   - You will see `[Protected Email]`, `[Protected Phone]`, and `[Protected Account]` — **zero raw customer emails, phones, or card numbers**.
4. Query `/api/health` and `/api/slack/health`:
   - Confirm `zeroDataRetention: true`, `readOnlySlackScopes: true`, and `tokenEncryption: "aes-256-gcm"` with zero secrets returned.

---

## 3. Reporting Security Issues

If you discover a vulnerability in CalmDuty, please open a private security advisory on GitHub rather than posting exploit details publicly.

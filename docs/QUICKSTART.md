# CalmDuty Quickstart Guide (60 Seconds)

Get from zero to a calm, PII-protected operations inbox using whichever path fits your team.

---

## Path 1 — Zero-Setup Sandbox (10 Seconds)

Want to test **CalmDuty** immediately without creating a Slack app or connecting real company data?

1. Open the live web app: [`https://calmduty.web.app`](https://calmduty.web.app)
2. Click **Try Sandbox** (or **Launch Sandbox**).
3. You immediately get a synthetic **Northstar Ops** stream with:
   - Repeated `×3` EU payment gateway alerts containing fictional PII (`maya.chen@northstar-demo.io`, `415-890-2341`, card digits, account IDs).
   - Auto-collapsed **Hidden Noise** heartbeats (`ResizeObserver`, `HTTP 499`, `healthcheck 1/3`).
   - Pre-registered **Northstar Ledger MCP** and **Internal Billing & Ledger API** (OpenAPI 3.x) deferred tools.
4. Click **`4 details hidden`** to inspect the local Before/After Privacy Shield diff, ask **Triage Chat** to summarize all alerts, click **Check what happened** to watch `gemini-decision-1` select only the matching tools, and open the bottom-right **CalmDuty Copilot** FAB.

---

## Path 2 — Connect Your Real Slack Workspace (45 Seconds, Read-Only)

1. Sign in with Google and enter your workspace name (e.g., `Acme Ops`).
2. On Step 2 (**Connect Slack**), pick either:
   - **Connect with Slack (1-Click OAuth 2.0)** — requests **strictly read-only scopes** (`app_mentions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read` — zero write permissions).
   - **Create your own Slack app (pre-filled)** — opens Slack with our ready-to-install read-only YAML manifest.
3. Invite your bot to any noisy alert channel in Slack:
   ```text
   /invite @your_bot_name
   ```
4. Click **Sync Slack** in CalmDuty. Messages are scrubbed on-device, ranked by `gemini-decision-1` at `0` output tokens, and grouped into `×N` threads automatically.

---

## Path 3 — Connect MCP Servers & OpenAPI Specs

1. Open the **Connections** tab in the top navigation bar.
2. Under **MCP Servers**, enter any Remote MCP server URL and role access level (`Viewer`, `Operator`, or `Admin`).
3. Under **OpenAPI Specs**, paste any OpenAPI 3.x JSON specification (or click **Load sample Billing API**).
4. CalmDuty registers every operation with `defer_loading: true`. When you run **Check what happened** on an alert, `gemini-decision-1` scores your tools in parallel and injects only the relevant schemas (`>= 0.50`) into `gemini-4-neon`.

---

## Next Guides
- [Self-Hosting Guide (Cloud Run, Docker, Custom Domains)](./SELF_HOSTING.md)
- [Zero-Data-Retention Security Architecture](./SECURITY.md)
- [Android Companion APK Install Guide](https://github.com/Timtech4u/edgeops-android/blob/main/docs/INSTALL_APK.md)

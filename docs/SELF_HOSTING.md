# Self-Hosting CalmDuty

CalmDuty is MIT open-source and designed to run 100% inside your own infrastructure so **zero OAuth tokens, zero webhooks, and zero alert bodies ever touch third-party servers**.

---

## Option 1 — 1-Click Deploy to Your Own Google Cloud Run (2 Minutes)

[![Deploy to Google Cloud Run](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run?git_repo=https://github.com/Timtech4u/edgeops)

1. Click the button above while signed into your own Google Cloud account.
2. Cloud Run reads [`app.json`](../app.json) and builds the multi-stage [`Dockerfile`](../Dockerfile).
3. Enter your `GEMINI_API_KEY` (Cloud Run auto-generates a fresh 32-byte `EDGEOPS_TOKEN_ENCRYPTION_KEY` for AES-256-GCM Slack token wrapping).
4. Optional: add `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` to enable 1-click Slack OAuth on your private URL.
5. Verify your instance is live:
   ```bash
   curl https://<your-cloud-run-url>/api/health
   # Expected: { "ok": true, "zeroDataRetention": true, "readOnlySlackScopes": true, ... }
   ```

---

## Option 2 — Docker Compose on Localhost or Private VPC (30 Seconds)

```bash
git clone https://github.com/Timtech4u/edgeops.git
cd edgeops
cp .env.example .env
```

Edit `.env` and fill in at minimum:
```bash
GEMINI_API_KEY="your-gemini-api-key"
EDGEOPS_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

Start the container:
```bash
docker compose up -d
```

CalmDuty is now running on `http://localhost:8080`.

### Optional Air-Gapped Local AI Sidecar
To boot an accompanying local Ollama container alongside CalmDuty:
```bash
docker compose --profile local-ai up -d
```

### Firewall-Friendly Slack Ingestion (Zero Public Ports)
When self-hosting behind a corporate NAT or firewall without ngrok:
- Generate your Slack manifest with **Socket Mode enabled** (`socket_mode_enabled: true` in `generateSlackManifestYaml`), OR use read-only pull sync (`POST /api/slack/sync`), which requires zero inbound webhook ports.

---

## Option 3 — Local Node.js 22 Development

```bash
git clone https://github.com/Timtech4u/edgeops.git
cd edgeops
npm install --legacy-peer-deps
cp .env.example .env
npm test
npm run dev
```

---

## Connecting a Custom Domain (Works With Any Registrar)

You can point any domain (including low-cost registrars like Cloudflare Registrar, Spaceship, Porkbun, or Namecheap) straight to your Cloud Run deployment with free automatic HTTPS:

### Via Cloud Run Domain Mappings (Direct GCP)
1. Open **Google Cloud Console → Cloud Run → Manage Custom Domains**.
2. Click **Add Mapping**, select your `calmduty` / `edgeops` Cloud Run service, and enter your domain.
3. Verify domain ownership with the single DNS `TXT` record at your registrar, then add the `A`/`AAAA` (or `CNAME`) records Cloud Run provides.
4. Add your custom domain to:
   - **Firebase Console → Authentication → Settings → Authorized domains** (for Google Sign-In)
   - **Firebase Console → App Check** (reCAPTCHA Enterprise allowlisted domains)
   - **Slack App → OAuth & Permissions → Redirect URLs** (`https://<your-domain>/api/slack/oauth/callback`)

### Via Firebase Hosting Rewrite (Global CDN + Instant SSL)
Add a rewrite in `firebase.json` pointing `**` to your Cloud Run service ID in `europe-west1`, then attach your custom domain under **Firebase Console → Hosting → Add custom domain**.

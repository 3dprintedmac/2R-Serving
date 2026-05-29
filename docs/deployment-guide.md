# Deployment Guide — 2Rivers Serve Finder

## Overview

The Serve Finder is a Cloudflare Worker that accepts form submissions from the public embed and creates Planning Center workflow cards routed to the correct ministry team lead. This guide covers the full setup and maintenance cycle.

---

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js 18+ | https://nodejs.org |
| Wrangler CLI | `npm install -g wrangler` |
| A Cloudflare account with access to 2riverschurch.com | — |
| A Planning Center account with API credentials | — |

---

## 1. Clone the repository

```bash
git clone https://github.com/3dprintedmac/2R-Serving.git
cd 2R-Serving
```

---

## 2. Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser window — log in with the Cloudflare account that manages 2riverschurch.com.

---

## 3. Local development

### 3a. Set up local secrets

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and fill in your actual Planning Center credentials. This file is git-ignored and should never be committed.

### 3b. Start the local dev server

```bash
wrangler dev --env development
```

The worker runs at `http://localhost:8787` by default.

### 3c. Test with curl

```bash
curl -s -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "Person",
    "email": "test@example.com",
    "ministryArea": "Worship"
  }' | jq .
```

Expected response:
```json
{ "success": true, "message": "Your interest has been received. Someone will be in touch soon!" }
```

---

## 4. Required Cloudflare environment variables

Set these in the Cloudflare Dashboard → Workers & Pages → serve-intake → Settings → Variables.

| Variable | Value | Encrypted? |
|----------|-------|------------|
| `PC_APP_ID` | Your Planning Center OAuth App ID | No |
| `PC_SECRET` | Your Planning Center OAuth Secret | **YES — mark as secret** |
| `WORKFLOW_ID` | `56729` | No |
| `WORKFLOW_STEP_ID` | `159351` | No |
| `ALLOWED_ORIGIN` | `https://2riverschurch.com` | No |
| `MINISTRY_ROUTING` | Paste contents of `config/ministry-routing.json` as a single-line JSON string | No |

### MINISTRY_ROUTING format

Paste the contents of `config/ministry-routing.json` — minified to a single line — into the Cloudflare variable value field. Example:

```
{"Guest Experience":{"assigneeId":"12345678","leadName":"Jane Smith"},"Worship":{"assigneeId":"87654321","leadName":"Nate Siecinski"}}
```

Do not include newlines or comments in the value.

---

## 5. Deploy manually

```bash
wrangler deploy --env production
```

---

## 6. Set up automatic deployment (GitHub Actions)

### 6a. Generate a Cloudflare API token

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. Use the **Edit Cloudflare Workers** template
3. Scope the token to your account and the 2riverschurch.com zone
4. Copy the token — you won't see it again

### 6b. Add the token to GitHub

1. GitHub repo → Settings → Secrets and variables → Actions
2. Click **New repository secret**
3. Name: `CLOUDFLARE_API_TOKEN`
4. Value: the token from step 6a

### 6c. Deploy trigger

The workflow in `.github/workflows/deploy.yml` fires automatically on any push to `main` that touches:
- `worker/**`
- `config/**`
- `wrangler.toml`
- `.github/workflows/deploy.yml`

You can also trigger a deploy manually from the Actions tab.

---

## 7. Embed setup (Weebly)

1. Open `embed/serve-finder.html`
2. Verify the `WORKER_URL` constant near the top of the `<script>` block matches your deployed Worker URL:
   ```js
   const WORKER_URL = 'https://api.2riverschurch.com/serve-intake';
   ```
3. In Weebly: add an **Embed Code** HTML block
4. Paste the full contents of `serve-finder.html` into the block
5. Save and publish

---

## 8. End-to-end test checklist

After deploying, run through this checklist:

- [ ] Submit the form with valid data for each ministry area
- [ ] Confirm a new workflow card appears in Planning Center under the correct workflow (`56729`)
- [ ] Confirm the card is assigned to the correct team lead for each ministry
- [ ] Confirm the card note includes the ministry area and any notes submitted
- [ ] Submit with an invalid email — confirm the form rejects it client-side
- [ ] Submit with a missing required field — confirm validation prevents submission
- [ ] Test from a non-allowed origin — confirm the Worker returns a CORS error

---

## 9. Updating ministry routing

When a team lead changes:

1. Update `config/ministry-routing.json` with the new PC Person ID and name
2. Commit and push → GitHub Actions deploys the Worker automatically
3. **Also update** the `MINISTRY_ROUTING` environment variable in the Cloudflare Dashboard with the new JSON (this is the one step that can't be automated without storing secrets)

For help finding a PC Person ID:
- In Planning Center → People → search for the person → the ID is in the URL: `/people/123456789`

---

## 10. Secrets that must never be committed

| Secret | Where it lives |
|--------|---------------|
| `PC_SECRET` | Cloudflare Worker environment variables (encrypted) |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secrets |

If either is ever accidentally committed, rotate immediately:
- PC: Planning Center → API → Applications → regenerate
- Cloudflare: My Profile → API Tokens → roll the affected token

---

*2Rivers Communications — Serve Finder Project*
*Workflow ID: 56729 | Entry step: 159351 (First Contact)*

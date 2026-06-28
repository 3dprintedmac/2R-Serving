# 2Rivers Serve Finder

A Cloudflare Worker + embeddable HTML form that lets people at 2Rivers Church express interest in serving. Submissions are routed to the correct ministry team lead in Planning Center automatically.

---

## 🔗 Live form preview & testing

**Preview the actual form, rendered live from GitHub — no setup needed (this repo is public):**

- **Latest work-in-progress (this branch / PR #5):**
  <https://raw.githack.com/3dprintedmac/2R-Serving/claude/serving-teams-source-truth-9n8aiz/embed/serve-finder.html>
- **Stable (`main`):**
  <https://raw.githack.com/3dprintedmac/2R-Serving/main/embed/serve-finder.html>

Open either link and walk the whole flow — *Find My Fit* (the 3-question quiz) or
*Browse Roles*. `raw.githack.com` is a free CDN that serves GitHub files with the
right `text/html` content-type, so the browser **renders** the page instead of showing
source. (Plain `raw.githubusercontent.com` links won't render — they serve as text.)

> **Heads-up — the preview is for _viewing/clicking_, not yet for real submissions.**
> Submitting from a preview URL will **not** create a Planning Center card, because:
> 1. the Worker only accepts requests from `ALLOWED_ORIGIN` (`https://2riverschurch.com`),
>    and a githack page sends a different origin — the browser blocks it via CORS; and
> 2. the Worker must be deployed with `PC_APP_ID`, `PC_SECRET`, and the `MINISTRY_ROUTING`
>    env var populated.

### Testing a real submission (the areas that have a lead + PC ID)

Areas currently wired with **both** a confirmed lead and a PC Person ID:
**Production · Creative & Communications · 2Rivers Youth · Outreach & Missions · Admin / General**.
(First Impressions, Worship, 2Rivers Kids, and all the newly added areas still need PC IDs — see `config/ministry-routing.json`.)

The cleanest way to test these end-to-end — no browser, no CORS — is a direct `curl`
against the deployed Worker:

```bash
curl -s -X POST https://api.2riverschurch.com/serve-intake \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "Submission",
    "email": "you+test@example.com",
    "ministryArea": "Production",
    "roleTitle": "Audio Operator"
  }' | jq .
```

Swap `ministryArea` for any of the five areas above. A success creates a workflow card
in PC workflow `56729` (Step 1 — First Contact) assigned to that area's lead. This
requires the Worker to be **deployed** and `MINISTRY_ROUTING` to contain those IDs
(paste in the contents of `config/ministry-routing.json`).

> Want to click-test in a *browser* (not curl) before go-live? We can temporarily add
> the preview origin (`https://raw.githack.com`) to `ALLOWED_ORIGIN`, or run the embed
> against a local `wrangler dev` Worker. Ask and we'll wire it up.

---

## Repository structure

```
2R-Serving/
├── worker/
│   └── serve-intake.js          ← Cloudflare Worker (entry point)
├── embed/
│   └── serve-finder.html        ← Self-contained embed for Weebly
├── config/
│   ├── ministry-routing.json    ← Ministry area → PC Person ID mapping
│   └── roles.json               ← Role descriptions (source of truth)
├── docs/
│   └── deployment-guide.md      ← Full operational runbook
├── .github/
│   └── workflows/
│       └── deploy.yml           ← Auto-deploy on push to main
├── .dev.vars.example            ← Template for local secrets
├── wrangler.toml                ← Cloudflare Workers config
├── .gitignore
└── README.md
```

---

## How it works

1. A person visits the 2Rivers website and fills out the serve interest form
2. The embed (`serve-finder.html`) posts their data to the Cloudflare Worker
3. The Worker validates the submission, resolves the ministry lead from `MINISTRY_ROUTING` (a server-side env variable), and creates a Planning Center workflow card assigned to that lead
4. The person sees a friendly confirmation; the team lead sees a new card in PC

---

## Local development

### Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`

### Setup

```bash
# Authenticate with Cloudflare
wrangler login

# Copy secrets template
cp .dev.vars.example .dev.vars
# Fill in PC_APP_ID, PC_SECRET, and MINISTRY_ROUTING in .dev.vars

# Start local dev server
wrangler dev --env development
```

The Worker runs at `http://localhost:8787`.

### Test with curl

```bash
curl -s -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "email": "test@example.com",
    "ministryArea": "Worship"
  }' | jq .
```

---

## Deployment

### Manual

```bash
wrangler deploy --env production
```

### Automatic (recommended)

Push to `main` and GitHub Actions deploys automatically when `worker/`, `config/`, or `wrangler.toml` change. See `.github/workflows/deploy.yml`.

---

## Required secrets and environment variables

| Variable | Where to set | Encrypted? |
|----------|-------------|------------|
| `PC_APP_ID` | Cloudflare Dashboard → Worker → Variables | No |
| `PC_SECRET` | Cloudflare Dashboard → Worker → Variables | **YES** |
| `WORKFLOW_ID` | Cloudflare Dashboard (or `wrangler.toml` fallback) | No |
| `WORKFLOW_STEP_ID` | Cloudflare Dashboard (or `wrangler.toml` fallback) | No |
| `ALLOWED_ORIGIN` | Cloudflare Dashboard (or `wrangler.toml` fallback) | No |
| `MINISTRY_ROUTING` | Cloudflare Dashboard → Worker → Variables | No |
| `CLOUDFLARE_API_TOKEN` | GitHub repo → Settings → Secrets → Actions | **YES** |

See `docs/deployment-guide.md` for full setup instructions.

---

## Maintenance workflow

```
1. Something changes (new lead, new role, role description update)
         ↓
2. Open Claude Code in this repo directory
         ↓
3. Describe the change in plain language
         ↓
4. Review the diff
         ↓
5. Commit and push to main
         ↓
6. GitHub Actions deploys to Cloudflare (~30 seconds)
         ↓
7. For routing changes: also update MINISTRY_ROUTING env var in Cloudflare Dashboard
```

### Example prompts for future updates

- *"Update the Guest Experience assigneeId in ministry-routing.json to 12345678"*
- *"Tristan is no longer the Production lead — update all references to use person ID 87654321"*
- *"Add a new role called 'Prayer Team' to the Behind the Scenes area in roles.json"*

---

## Confirmed Planning Center values

| Field | Value |
|-------|-------|
| Workflow ID | `56729` |
| First Contact step ID | `159351` |
| Worker route | `api.2riverschurch.com/serve-intake` |

---

## What still needs manual setup before going live

- [ ] PC Person IDs confirmed for each ministry lead (from team review sheet)
- [ ] `config/ministry-routing.json` `assigneeId` fields filled in
- [ ] `MINISTRY_ROUTING` env variable populated in Cloudflare Dashboard
- [ ] `PC_APP_ID` and `PC_SECRET` created in Planning Center and added to Cloudflare
- [ ] `CLOUDFLARE_API_TOKEN` added to GitHub Actions secrets
- [ ] Worker deployed and tested end-to-end with curl
- [ ] `embed/serve-finder.html` pasted into Weebly HTML block
- [ ] End-to-end test: submit form → verify PC workflow card created with correct assignee

---

*2Rivers Communications — Serve Finder Project*

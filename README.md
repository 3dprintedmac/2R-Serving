# 2Rivers Serve Finder

A Cloudflare Worker + embeddable HTML form that lets people at 2Rivers Church express interest in serving. Submissions are routed to the correct ministry team lead in Planning Center automatically.

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

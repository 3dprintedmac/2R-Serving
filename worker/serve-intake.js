/**
 * 2Rivers Serve Finder — Cloudflare Worker
 *
 * Accepts a serve interest form submission, resolves the ministry lead
 * from trusted server-side routing, and creates a Planning Center workflow
 * card assigned to the correct team lead.
 *
 * Required Cloudflare environment variables (set these on the Worker):
 *   PC_APP_ID        — Planning Center application ID
 *   PC_SECRET        — Planning Center secret  (mark as secret/encrypted)
 *
 * Optional overrides — all have safe built-in defaults, so you do NOT need to
 * set these unless you want to change them:
 *   WORKFLOW_ID      — PC workflow ID (default: 56729)
 *   WORKFLOW_STEP_ID — PC workflow step ID for "First Contact" (default: 159351)
 *   ALLOWED_ORIGIN   — comma-separated list of allowed site origins
 *                      (default: the 2riverschurch.com origins below)
 *   MINISTRY_ROUTING — JSON string of ministry-area → assignee mapping
 *                      (default: bundled from config/ministry-routing.json)
 */

// Routing is bundled from the committed source of truth so it deploys with the
// Worker automatically — no need to paste it into a dashboard env var.
import bundledRouting from '../config/ministry-routing.json';

// Non-secret fallbacks — safe to be in source
const DEFAULT_WORKFLOW_ID      = '56729';
const DEFAULT_WORKFLOW_STEP_ID = '159351';

// Site origins allowed to call this Worker when ALLOWED_ORIGIN is not set.
// Covers both the apex and www forms of the church site.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://2riverschurch.com',
  'https://www.2riverschurch.com',
];

const PC_API_BASE = 'https://api.planningcenteronline.com';
const MAX_PAYLOAD_BYTES = 8_192;

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    // Resolved to the request origin when it is on the allow-list, else '' (blocked).
    const allowedOrigin = resolveAllowedOrigin(origin, env);

    // Preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(origin, allowedOrigin);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin, allowedOrigin);
    }

    // Validate environment before doing any work
    const envError = validateEnv(env);
    if (envError) {
      console.error('Worker misconfiguration:', envError);
      return jsonResponse({ error: 'Service configuration error.' }, 503, origin, allowedOrigin);
    }

    // Guard payload size
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: 'Payload too large.' }, 413, origin, allowedOrigin);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_PAYLOAD_BYTES) {
        return jsonResponse({ error: 'Payload too large.' }, 413, origin, allowedOrigin);
      }
      body = JSON.parse(text);
    } catch {
      return jsonResponse({ error: 'Invalid request body.' }, 400, origin, allowedOrigin);
    }

    // Validate and sanitize inputs
    const validation = validatePayload(body);
    if (validation.error) {
      return jsonResponse({ error: validation.error }, 400, origin, allowedOrigin);
    }
    const { firstName, lastName, email, phone, notes, grade6to12, roles, answers, recommended } = validation.data;

    // Resolve routing (trusted, server-side) and decide who owns this card.
    const routing = resolveRouting(env);
    const coordinatorId = getCoordinatorId(routing);

    // The set of distinct ministry areas across the selected roles drives the
    // assignee:  none  → coordinator (help request),
    //            one   → that area's ministry lead,
    //            many  → coordinator (Lillian discerns; one card, no duplicates).
    const uniqueAreas = [...new Set(roles.map((r) => r.ministryArea))];

    let assigneeId;
    if (uniqueAreas.length === 1) {
      const leadConfig = routing[uniqueAreas[0]];
      assigneeId = (leadConfig && leadConfig.assigneeId) || coordinatorId;
    } else {
      assigneeId = coordinatorId;
    }

    const workflowId = env.WORKFLOW_ID || DEFAULT_WORKFLOW_ID;

    try {
      // 1. Find or create the person in Planning Center
      const personId = await findOrCreatePerson(env, { firstName, lastName, email, phone });

      // 2. Create a single workflow card for this submission
      await createWorkflowCard(env, {
        personId,
        workflowId,
        assigneeId: assigneeId || null,
        note: buildNote({ firstName, roles, uniqueAreas, notes, grade6to12, answers, recommended }),
      });

      return jsonResponse(
        { success: true, message: 'Your interest has been received. Someone will be in touch soon!' },
        200,
        origin,
        allowedOrigin
      );
    } catch (err) {
      console.error('PC API error:', err.message);
      return jsonResponse(
        { error: 'We were unable to process your request. Please try again or contact us directly.' },
        502,
        origin,
        allowedOrigin
      );
    }
  },
};

// ─── Input validation ─────────────────────────────────────────────────────────

const VALID_MINISTRY_AREAS = [
  'First Impressions',
  'Worship',
  'Production',
  'Creative & Communications',
  '2Rivers Kids',
  '2Rivers Youth',
  'Outreach & Missions',
  'Admin / General',
  'Not Sure Yet',
];

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request format.' };
  }

  const firstName    = sanitizeString(body.firstName,    50);
  const lastName     = sanitizeString(body.lastName,     50);
  const email        = sanitizeString(body.email,       254);
  const phone        = sanitizeString(body.phone,        30);
  const notes        = sanitizeString(body.notes,       500);
  const grade6to12   = body.grade6to12 === true || body.grade6to12 === 'true';
  const roles        = parseRoles(body.roles);
  const answers      = parseAnswers(body.answers);
  const recommended  = parseStringList(body.recommended, 10, 120);

  if (!firstName) return { error: 'First name is required.' };
  if (!lastName)  return { error: 'Last name is required.' };
  if (!email)     return { error: 'Email address is required.' };
  if (!isValidEmail(email)) return { error: 'Please provide a valid email address.' };

  // roles may legitimately be empty — that's a "help me find a fit" request.

  return { data: { firstName, lastName, email, phone, notes, grade6to12, roles, answers, recommended } };
}

// Each role carries a title and a ministry area. Entries with an unknown area
// are dropped (defense-in-depth) rather than failing the whole submission.
function parseRoles(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const ministryArea = sanitizeString(r.ministryArea, 80);
    const roleTitle    = sanitizeString(r.roleTitle, 120);
    if (!ministryArea || !VALID_MINISTRY_AREAS.includes(ministryArea)) return null;
    return { ministryArea, roleTitle };
  }).filter(Boolean);
}

function parseAnswers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((a) => {
    if (!a || typeof a !== 'object') return null;
    const question = sanitizeString(a.question, 200);
    const answer   = sanitizeString(a.answer, 120);
    if (!question || !answer) return null;
    return { question, answer };
  }).filter(Boolean);
}

function parseStringList(value, maxItems, itemMaxLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((s) => sanitizeString(s, itemMaxLength)).filter(Boolean);
}

// Lillian Good coordinates anyone who is unsure or interested in multiple areas.
// Pull her PC id from routing so there is a single source of truth.
function getCoordinatorId(routing) {
  return (
    (routing['Not Sure Yet'] && routing['Not Sure Yet'].assigneeId) ||
    (routing['Admin / General'] && routing['Admin / General'].assigneeId) ||
    (routing['Outreach & Missions'] && routing['Outreach & Missions'].assigneeId) ||
    null
  );
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Environment validation ───────────────────────────────────────────────────

function validateEnv(env) {
  // Only the Planning Center credentials are truly required — routing and the
  // allowed origins both fall back to safe built-in defaults.
  if (!env.PC_APP_ID) return 'Missing PC_APP_ID';
  if (!env.PC_SECRET) return 'Missing PC_SECRET';
  return null;
}

// ─── Ministry routing ─────────────────────────────────────────────────────────

// Use the MINISTRY_ROUTING env var if it is set and valid; otherwise fall back
// to the routing bundled from config/ministry-routing.json at build time.
function resolveRouting(env) {
  if (env.MINISTRY_ROUTING) {
    const parsed = parseMinistryRouting(env.MINISTRY_ROUTING);
    if (Object.keys(parsed).length) return parsed;
  }
  return bundledRouting;
}

function parseMinistryRouting(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    console.error('Failed to parse MINISTRY_ROUTING env var');
    return {};
  }
}

// ─── CORS origin allow-list ────────────────────────────────────────────────────

// Returns the request origin when it is allowed, or '' to block it.
// ALLOWED_ORIGIN (comma-separated) overrides the built-in defaults when set.
function resolveAllowedOrigin(origin, env) {
  if (!origin) return '';
  const list = (env.ALLOWED_ORIGIN
    ? env.ALLOWED_ORIGIN.split(',')
    : DEFAULT_ALLOWED_ORIGINS
  ).map((o) => o.trim()).filter(Boolean);
  return list.includes(origin) ? origin : '';
}

// ─── Planning Center API calls ────────────────────────────────────────────────

function pcAuthHeader(env) {
  const credentials = btoa(`${env.PC_APP_ID}:${env.PC_SECRET}`);
  return `Basic ${credentials}`;
}

async function pcFetch(env, path, options = {}) {
  const url = `${PC_API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': pcAuthHeader(env),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`PC API ${response.status} at ${path}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function findOrCreatePerson(env, { firstName, lastName, email, phone }) {
  // Search by email first
  const searchResult = await pcFetch(
    env,
    `/people/v2/people?where[search_name_or_email]=${encodeURIComponent(email)}&per_page=1`
  );

  if (searchResult.data?.length > 0) {
    return searchResult.data[0].id;
  }

  // Create a new person record
  const createPayload = {
    data: {
      type: 'Person',
      attributes: { first_name: firstName, last_name: lastName },
    },
  };

  const created = await pcFetch(env, '/people/v2/people', {
    method: 'POST',
    body: JSON.stringify(createPayload),
  });
  const personId = created.data.id;

  // Add email
  await pcFetch(env, `/people/v2/people/${personId}/emails`, {
    method: 'POST',
    body: JSON.stringify({
      data: { type: 'Email', attributes: { address: email, location: 'Home' } },
    }),
  });

  // Add phone if provided
  if (phone) {
    await pcFetch(env, `/people/v2/people/${personId}/phone_numbers`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'PhoneNumber',
          attributes: { number: phone, location: 'Mobile' },
        },
      }),
    });
  }

  return personId;
}

async function createWorkflowCard(env, { personId, workflowId, assigneeId, note }) {
  // Planning Center rejects both `note` and `workflow_step_id` as WorkflowCard
  // attributes on creation. New cards automatically enter at the workflow's
  // first step (First Contact), so we only set the person + optional assignee,
  // then add the note afterward as a separate WorkflowCardNote sub-resource.
  const attributes = {};
  if (assigneeId) attributes.assignee_id = assigneeId;

  const payload = {
    data: {
      type: 'WorkflowCard',
      attributes,
      relationships: {
        person: { data: { type: 'Person', id: personId } },
      },
    },
  };

  const created = await pcFetch(env, `/people/v2/workflows/${workflowId}/cards`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  // Best-effort: attach the submission details as a card note. A note failure
  // must not fail the whole submission — the assigned card is what matters.
  const cardId = created?.data?.id;
  if (cardId && note) {
    try {
      await pcFetch(env, `/people/v2/workflows/${workflowId}/cards/${cardId}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          data: { type: 'WorkflowCardNote', attributes: { note } },
        }),
      });
    } catch (err) {
      console.error('Card created, but failed to add note:', err.message);
    }
  }
}

function buildNote({ firstName, roles, uniqueAreas, notes, grade6to12, answers, recommended }) {
  const lines = ['Source: 2Rivers Serve Finder'];
  let nextStep;

  if (roles.length === 0) {
    // Scenario 3 — submitted via "Help me find a good fit" with no roles picked.
    lines.push('Status: Needs help determining fit');
    if (recommended && recommended.length) {
      lines.push('', 'Recommended roles generated:');
      recommended.forEach((t) => lines.push(`  • ${t}`));
    }
    if (answers && answers.length) {
      lines.push('', 'Their answers to the 3 questions:');
      answers.forEach((a) => lines.push(`  • ${a.question} → ${a.answer}`));
    }
    nextStep = 'Help them explore opportunities and determine the first team to visit.';
  } else if (uniqueAreas.length === 1) {
    // Scenario 1 — one ministry area. Assigned directly to that area's lead.
    lines.push('Status: Single-role interest');
    lines.push(`Ministry area: ${uniqueAreas[0]}`);
    lines.push('Role(s):');
    roles.forEach((r) => lines.push(`  • ${r.roleTitle}`));
    nextStep = 'Invite them to learn more or shadow.';
  } else {
    // Scenario 2 — multiple ministry areas. Assigned to Lillian to discern.
    lines.push('Status: Multiple interests');
    lines.push('Selected roles:');
    roles.forEach((r) => lines.push(`  • ${r.roleTitle} (${r.ministryArea})`));
    lines.push(`Selected ministry areas: ${uniqueAreas.join(', ')}`);
    nextStep = 'Help them determine which team they would like to explore first.';
  }

  if (grade6to12) lines.push('', '*** STUDENT (Grade 6–12) — please follow up appropriately. ***');
  if (notes) lines.push('', `Message from ${firstName}:`, notes);
  lines.push('', `Suggested next step: ${nextStep}`);

  return lines.join('\n');
}

// ─── CORS / response helpers ──────────────────────────────────────────────────

function corsHeaders(origin, allowedOrigin) {
  // allowedOrigin is already resolved (the request origin if allowed, else '').
  return {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function corsPreflightResponse(origin, allowedOrigin) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, allowedOrigin),
  });
}

function jsonResponse(body, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, allowedOrigin),
    },
  });
}

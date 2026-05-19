/**
 * 2Rivers Serve Finder — Cloudflare Worker
 *
 * Accepts a serve interest form submission, resolves the ministry lead
 * from trusted server-side routing, and creates a Planning Center workflow
 * card assigned to the correct team lead.
 *
 * Required Cloudflare environment variables:
 *   PC_APP_ID        — Planning Center OAuth application ID
 *   PC_SECRET        — Planning Center OAuth secret  (mark as secret/encrypted)
 *   WORKFLOW_ID      — PC workflow ID (default: 56729)
 *   WORKFLOW_STEP_ID — PC workflow step ID for "First Contact" (default: 159351)
 *   ALLOWED_ORIGIN   — CORS allowed origin (e.g. https://2riverschurch.com)
 *   MINISTRY_ROUTING — JSON string of ministry-area → assignee mapping
 */

// Non-secret fallbacks — safe to be in source
const DEFAULT_WORKFLOW_ID      = '56729';
const DEFAULT_WORKFLOW_STEP_ID = '159351';

const PC_API_BASE = 'https://api.planningcenteronline.com';
const MAX_PAYLOAD_BYTES = 8_192;

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '';

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
    const { firstName, lastName, email, phone, ministryArea, notes } = validation.data;

    // Resolve assignee from trusted server-side routing
    const routing = parseMinistryRouting(env.MINISTRY_ROUTING);
    const ministryConfig = routing[ministryArea];
    if (!ministryConfig) {
      return jsonResponse({ error: 'Unknown ministry area.' }, 400, origin, allowedOrigin);
    }

    const workflowId     = env.WORKFLOW_ID      || DEFAULT_WORKFLOW_ID;
    const workflowStepId = env.WORKFLOW_STEP_ID || DEFAULT_WORKFLOW_STEP_ID;

    try {
      // 1. Find or create the person in Planning Center
      const personId = await findOrCreatePerson(env, { firstName, lastName, email, phone });

      // 2. Create the workflow card
      await createWorkflowCard(env, {
        personId,
        workflowId,
        workflowStepId,
        assigneeId: ministryConfig.assigneeId || null,
        note: buildNote({ firstName, ministryArea, notes }),
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
  'Guest Experience',
  'Worship',
  'Production',
  'Creative & Communications',
  'Kids & Students',
  'Outreach & Missions',
  'Behind the Scenes',
];

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request format.' };
  }

  const firstName    = sanitizeString(body.firstName,    50);
  const lastName     = sanitizeString(body.lastName,     50);
  const email        = sanitizeString(body.email,       254);
  const phone        = sanitizeString(body.phone,        30);
  const ministryArea = sanitizeString(body.ministryArea, 80);
  const notes        = sanitizeString(body.notes,       500);

  if (!firstName) return { error: 'First name is required.' };
  if (!lastName)  return { error: 'Last name is required.' };
  if (!email)     return { error: 'Email address is required.' };
  if (!isValidEmail(email)) return { error: 'Please provide a valid email address.' };
  if (!ministryArea) return { error: 'Ministry area is required.' };
  if (!VALID_MINISTRY_AREAS.includes(ministryArea)) {
    return { error: 'Please select a valid ministry area.' };
  }

  return { data: { firstName, lastName, email, phone, ministryArea, notes } };
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
  if (!env.PC_APP_ID)        return 'Missing PC_APP_ID';
  if (!env.PC_SECRET)        return 'Missing PC_SECRET';
  if (!env.MINISTRY_ROUTING) return 'Missing MINISTRY_ROUTING';
  if (!env.ALLOWED_ORIGIN)   return 'Missing ALLOWED_ORIGIN';
  return null;
}

// ─── Ministry routing ─────────────────────────────────────────────────────────

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

async function createWorkflowCard(env, { personId, workflowId, workflowStepId, assigneeId, note }) {
  const attributes = {
    assignee_id: assigneeId,
    note,
  };

  const payload = {
    data: {
      type: 'WorkflowCard',
      attributes,
      relationships: {
        person:          { data: { type: 'Person',       id: personId } },
        workflow_step:   { data: { type: 'WorkflowStep', id: workflowStepId } },
      },
    },
  };

  await pcFetch(env, `/people/v2/workflows/${workflowId}/cards`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function buildNote({ firstName, ministryArea, notes }) {
  let text = `Serve interest submitted via 2Rivers Serve Finder.\nMinistry area: ${ministryArea}`;
  if (notes) text += `\n\nAdditional notes from ${firstName}:\n${notes}`;
  return text;
}

// ─── CORS / response helpers ──────────────────────────────────────────────────

function corsHeaders(origin, allowedOrigin) {
  // Allow only the configured origin; fall back to same-site if origin matches
  const allow = origin === allowedOrigin ? allowedOrigin : '';
  return {
    'Access-Control-Allow-Origin':  allow,
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

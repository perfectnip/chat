/**
 * OpenClaw ↔ jchat bridge.
 *
 * Connects OUT to the jchat server as the Venory helper bot (authenticated
 * with JCHAT_HELPER_TOKEN) and answers `helper:task` events — which the
 * server only emits for DM messages from OPENCLAW_OWNER_ID — by running the
 * local OpenClaw gateway agent through its OpenAI-compatible HTTP endpoint.
 *
 * It also holds a persistent loopback WebSocket to the local gateway so it
 * can stream live `agent` events (working/done lifecycle + tools being used)
 * back to the server as `helper:status`, and so the owner can stop an
 * in-flight response (`helper:stop` → abort the HTTP fetch → `helper:stopped`).
 *
 * Security model:
 *  - OPENCLAW_GATEWAY_TOKEN lives only on this machine (env / bridge.env).
 *  - JCHAT_HELPER_TOKEN + OPENCLAW_BRIDGE_SECRET are shared with the server,
 *    but they grant nothing except "act as the helper bot" on jchat.
 *  - Anyone deploying the same code without these env vars gets an inert
 *    bridge: no gateway URL/token, no server-side routing.
 *
 * Run:  node bridge/index.js     (env from process env or bridge/bridge.env)
 */

import { io } from 'socket.io-client';
import WebSocket from 'ws';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// --- env loading -----------------------------------------------------------
// bridge.env (if present) provides fallbacks; already-set process env wins
// (so launchd/EnvironmentVariables overrides take priority).
const ENV_PATH = new URL('./bridge.env', import.meta.url).pathname;
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const JCHAT_URL = process.env.JCHAT_URL || 'https://jchat.fly.dev';
const JCHAT_HELPER_TOKEN = process.env.JCHAT_HELPER_TOKEN || '';
const OPENCLAW_GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789/v1').replace(/\/+$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OPENCLAW_BRIDGE_SECRET = process.env.OPENCLAW_BRIDGE_SECRET || '';
const FETCH_TIMEOUT_MS = Number(process.env.OPENCLAW_FETCH_TIMEOUT_MS || 9 * 60 * 1000);
// HTTP body `model` is the *agent target* (openclaw / openclaw/<agentId>).
// The real backend model is switched via the `x-openclaw-model` header.
const MODEL = process.env.OPENCLAW_MODEL || 'openclaw/default';
// Loopback gateway WebSocket (for live agent events). Derive from the HTTP
// URL by dropping the /v1 path and swapping http→ws, unless overridden.
const GATEWAY_WS_URL = process.env.OPENCLAW_GATEWAY_WS_URL
  || OPENCLAW_GATEWAY_URL.replace(/\/v\d+\/?$/, '').replace(/^http/, 'ws');

// Mirror of the server's validated option sets (defense in depth: the server
// already sanitizes these before emitting `helper:task`, but we re-check so a
// bad value can never reach the gateway header/body).
const VALID_MODELS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);
const VALID_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra']);

// --- message source note ------------------------------------------------------
// Every task that reaches this bridge arrives as a jchat DM from the owner
// (the server only emits helper:task for OPENCLAW_OWNER_ID DMs). The agent is
// told WHERE the message came from (the source channel) — deliberately NOT
// what app the user is currently on (no presence tracking is shared).
const MESSAGE_SOURCE_NOTE = 'Message source: jchat — this message came from jimmyqrg in a private DM to the helper bot on the jchat school chat app.';

function log(...args) {
  console.log(new Date().toISOString(), '[bridge]', ...args);
}

for (const [name, value] of [
  ['JCHAT_HELPER_TOKEN', JCHAT_HELPER_TOKEN],
  ['OPENCLAW_GATEWAY_TOKEN', OPENCLAW_GATEWAY_TOKEN],
  ['OPENCLAW_BRIDGE_SECRET', OPENCLAW_BRIDGE_SECRET],
]) {
  if (!value) {
    console.error(`[bridge] Missing required env var: ${name}`);
    process.exit(1);
  }
}

function secretsEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- gateway device identity (required for operator WS connects) -----------
// The gateway rejects shared-token-only operator connects with
// DEVICE_IDENTITY_REQUIRED; a device identity (Ed25519 keypair + signed
// connect payload) is required. We keep a persistent keypair next to
// bridge.env so every reconnect uses the same device id.
const DEVICE_PATH = new URL('./device.json', import.meta.url).pathname;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawB64u(publicKeyPem) {
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return base64UrlEncode(spki.subarray(spki.length - 32));
}

function loadOrCreateDeviceIdentity() {
  try {
    if (existsSync(DEVICE_PATH)) {
      const raw = JSON.parse(readFileSync(DEVICE_PATH, 'utf8'));
      if (raw?.deviceId && raw?.publicKeyPem && raw?.privateKeyPem) return raw;
    }
  } catch (err) {
    log('device.json unreadable, regenerating:', err.message);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubDer.subarray(pubDer.length - 32);
  const identity = {
    version: 1,
    deviceId: createHash('sha256').update(rawPub).digest('hex'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  try {
    mkdirSync(dirname(DEVICE_PATH), { recursive: true });
    writeFileSync(DEVICE_PATH, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    log('failed to persist device.json:', err.message);
  }
  log('generated gateway device identity:', identity.deviceId);
  return identity;
}

const DEVICE_IDENTITY = loadOrCreateDeviceIdentity();
const DEVICE_PRIVATE_KEY = createPrivateKey(DEVICE_IDENTITY.privateKeyPem);
const DEVICE_PUBLIC_KEY_B64U = publicKeyRawB64u(DEVICE_IDENTITY.publicKeyPem);

/** Build the signed `device` object the gateway requires on connect. */
function buildSignedDevice(role, scopes, token, nonce) {
  const signedAt = Date.now();
  const payload = [
    'v3', DEVICE_IDENTITY.deviceId, 'gateway-client', 'backend', role,
    scopes.join(','), String(signedAt), token, nonce, 'macos', '',
  ].join('|');
  const signature = sign(null, Buffer.from(payload, 'utf8'), DEVICE_PRIVATE_KEY);
  return {
    id: DEVICE_IDENTITY.deviceId,
    publicKey: DEVICE_PUBLIC_KEY_B64U,
    signature: base64UrlEncode(signature),
    signedAt,
    nonce,
  };
}

// --- socket connection (to jchat) ------------------------------------------
const socket = io(JCHAT_URL, {
  auth: { token: JCHAT_HELPER_TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000,
});

// --- gateway WebSocket (loopback, live agent events) ------------------------
let gw = null;
let gwReady = false;
let gwReconnectTimer = null;

function connectGatewayWs() {
  if (gw && (gw.readyState === WebSocket.OPEN || gw.readyState === WebSocket.CONNECTING)) return;
  try {
    gw = new WebSocket(GATEWAY_WS_URL);
  } catch (err) {
    log('gateway ws create error:', err.message);
    scheduleGatewayReconnect();
    return;
  }
  gw.on('open', () => log('gateway ws open'));
  gw.on('error', (e) => log('gateway ws error:', e.message));
  gw.on('close', () => {
    log('gateway ws closed');
    gwReady = false;
    scheduleGatewayReconnect();
  });
  gw.on('message', (raw) => handleGatewayMessage(raw));
}

function scheduleGatewayReconnect() {
  if (gwReconnectTimer) clearTimeout(gwReconnectTimer);
  gwReconnectTimer = setTimeout(connectGatewayWs, 3000);
}

function handleGatewayMessage(raw) {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.event === 'connect.challenge') {
    const nonce = m.payload?.nonce || '';
    const scopes = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.questions'];
    gw.send(JSON.stringify({
      type: 'req',
      id: 'gw-connect',
      method: 'connect',
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: 'gateway-client', version: '1.0.0', platform: 'macos', mode: 'backend' },
        role: 'operator',
        scopes,
        caps: [], commands: [], permissions: {},
        device: buildSignedDevice('operator', scopes, OPENCLAW_GATEWAY_TOKEN, nonce),
        auth: { token: OPENCLAW_GATEWAY_TOKEN },
        locale: 'en-US',
        userAgent: 'jchat-bridge/1.0.0',
      },
    }));
  } else if (m.type === 'res' && m.id === 'gw-connect') {
    if (m.ok) {
      gwReady = true;
      log('gateway ws connected (operator)');
      // Fresh gateway connection: subscriptions are gone and the DM
      // transcript watermark may be stale → full idempotent reconcile.
      lastDmSyncedSeq = 0;
      syncDmFromGateway();
      gwRpc('sessions.subscribe', {}, 8000)
        .then(() => log('subscribed to gateway session index changes'))
        .catch((err) => log('sessions.subscribe failed:', err.message));
      // Recover ask_user questions that were pending while we were offline
      // (bridge restart mid-run must not strand the owner's question UI).
      gwRpc('question.list', {}, 8000)
        .then((res) => {
          const qs = Array.isArray(res?.questions) ? res.questions : [];
          for (const record of qs) handleGatewayQuestion(record);
          if (qs.length) log('recovered pending questions:', qs.length);
        })
        .catch((err) => log('question.list failed:', err.message));
      scheduleListPush();
    } else {
      log('gateway ws connect rejected:', JSON.stringify(m.error || m).slice(0, 300));
    }
  } else if (m.type === 'res' && rpcWaiters.has(m.id)) {
    rpcWaiters.get(m.id)(m);
  } else if (m.event === 'sessions.changed') {
    scheduleListPush();
  } else if (m.event === 'session.message') {
    handleSessionMessage(m.payload);
  } else if (m.event === 'agent') {
    handleAgentEvent(m.payload);
  } else if (m.event === 'question.requested') {
    handleGatewayQuestion(m.payload);
  } else if (m.event === 'question.resolved') {
    handleGatewayQuestionResolved(m.payload);
  }
}

/** Extract the DM conversation id from an agent session key.
 *  Shape: agent:main:openai-user:jchat:dm:<convId> */
function convIdFromSessionKey(sessionKey) {
  const m = String(sessionKey || '').match(/^agent:main:openai-user:jchat:dm:(.+)$/);
  return m ? m[1] : null;
}

// --- gateway ask_user questions → jchat UI -----------------------------------
// When the agent calls ask_user mid-run, the gateway broadcasts the question
// record on the WS; we surface it in the owner's DM as tappable options and
// resolve it back over the WS when the owner answers. Records that were
// pending while the bridge was offline are recovered via question.list.
const pendingQuestions = new Map(); // recordId -> { record, convId }

function questionPayload(record, convId) {
  return {
    convId,
    recordId: record.id,
    sessionKey: typeof record.sessionKey === 'string' ? record.sessionKey : '',
    expiresAtMs: typeof record.expiresAtMs === 'number' ? record.expiresAtMs : 0,
    questions: (Array.isArray(record.questions) ? record.questions : []).map((q) => ({
      questionId: String(q?.questionId || q?.id || ''),
      header: typeof q?.header === 'string' ? q.header : '',
      question: typeof q?.question === 'string' ? q.question : '',
      multiSelect: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: typeof o?.label === 'string' ? o.label : '',
        description: typeof o?.description === 'string' ? o.description : undefined,
      })).filter((o) => o.label),
    })).filter((q) => q.questionId && q.question),
  };
}

function handleGatewayQuestion(record) {
  if (!record || record.status !== 'pending' || record.id === undefined) return;
  const sk = typeof record.sessionKey === 'string' ? record.sessionKey : '';
  // Only questions on owner-bridge sessions: the DM lane itself or the
  // currently routed session. Questions from other agents stay out.
  const isDmQuestion = !!convIdFromSessionKey(sk);
  const isRoutedQuestion = !!currentSessionKey && sk === currentSessionKey;
  if (!isDmQuestion && !isRoutedQuestion) return;
  const convId = convIdFromSessionKey(sk) || dmConvId;
  if (!convId) return;
  const payload = questionPayload(record, convId);
  if (!payload.questions.length) return;
  pendingQuestions.set(record.id, { record, convId });
  socket.emit('helper:question', payload);
  log('question surfaced:', record.id, sk);
}

function handleGatewayQuestionResolved(ev) {
  if (!ev?.id) return;
  const entry = pendingQuestions.get(ev.id);
  if (entry) pendingQuestions.delete(ev.id);
  socket.emit('helper:question:resolved', {
    convId: entry?.convId || dmConvId,
    recordId: ev.id,
    status: typeof ev.status === 'string' ? ev.status : 'answered',
  });
}

function handleAgentEvent(p) {
  if (!p || !p.sessionKey) return;
  // Session-switched tasks surface agent events under the switched session
  // key; DM tasks surface them under the derived DM session key.
  let taskId = activeBySession.get(p.sessionKey);
  if (!taskId) {
    const convId = convIdFromSessionKey(p.sessionKey);
    if (convId) taskId = activeByConv.get(convId);
  }
  if (!taskId) return; // no in-flight task for this session
  const status = mapAgentEvent(p);
  if (!status) return;
  socket.emit('helper:status', { taskId, sessionKey: p.sessionKey, ...status });
}

/** Map a raw `agent` event to a compact `helper:status` payload.
 *  Returns null for streams we don't surface in the UI (thinking text, etc.). */
function mapAgentEvent(p) {
  const d = p?.data || {};
  const s = p?.stream;
  if (s === 'lifecycle') {
    if (d.phase === 'start') return { kind: 'lifecycle', status: 'working' };
    if (d.phase === 'finishing' || d.phase === 'end') return { kind: 'lifecycle', status: 'done' };
    return null;
  }
  if (s === 'item' && d.kind === 'tool') {
    if (d.phase === 'start') {
      return { kind: 'tool', status: 'running', id: d.itemId, name: d.name, title: d.title, meta: d.meta };
    }
    if (d.phase === 'end') {
      return { kind: 'tool', status: d.status || 'completed', id: d.itemId, name: d.name, title: d.title };
    }
    return null;
  }
  return null;
}

// --- gateway HTTP call ------------------------------------------------------
const GATEWAY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries on transient network errors
const GATEWAY_RETRY_DELAY_MS = 1500;

/** True for transient, connection-level failures worth retrying on a fresh
 *  connection. Also retries gateway upstream blips (502/503/504/429 — e.g.
 *  "upstream provider timeout", which usually succeeds on a fresh attempt).
 *  Other HTTP error statuses and empty replies are NOT retried. */
function isTransientFetchError(err) {
  const msg = String(err?.message || '');
  const code = String(err?.code || err?.cause?.code || '');
  // 5xx includes 500: the gateway answers "internal error" instantly when a
  // run is already active in the target session (busy), which clears on its
  // own — worth retrying. 429 may carry retryAfter.
  if (err?.status >= 500 && err?.status < 600) return true;
  if (err?.status === 429) return true;
  if (/fetch failed/i.test(msg)) return true;
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'].includes(code);
}

/** Perform a JSON POST to the gateway over raw node http/https, resolving
 *  { status, body }. Unlike `fetch` (undici), this has NO built-in 5-minute
 *  header/body timeout — the only deadline is our own FETCH_TIMEOUT_MS abort,
 *  so long agent runs are no longer cut off mid-flight. This is the fix for
 *  the historical "fetch failed at ~5 minutes → silent DeepSeek fallback"
 *  ("sometimes basic Venory") bug. */
function gatewayRequestJson(urlStr, headers, body, controller) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    const req = mod({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });

    req.on('error', (e) => finish(reject, e));

    timer = setTimeout(() => {
      finish(reject, Object.assign(new Error(`gateway timed out after ${FETCH_TIMEOUT_MS}ms`), { name: 'TimeoutError' }));
      req.destroy();
    }, FETCH_TIMEOUT_MS);

    const onAbort = () => {
      finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
      req.destroy();
    };
    if (controller.signal.aborted) return onAbort();
    controller.signal.addEventListener('abort', onAbort, { once: true });

    req.write(body);
    req.end();
  });
}

// Files the owner uploads through jchat land on THIS computer so the full
// assistant can read them directly, and images are also inlined into the
// gateway message as base64 image_url parts.
const JCHAT_FILES_DIR = process.env.JCHAT_FILES_DIR || join(homedir(), '.openclaw', 'jchat-files');
const ATTACH_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const ATTACH_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Download a jchat attachment to ~/.openclaw/jchat-files/. Returns
 *  { path, bytes, name, mime } | { skipped:true, ... } | null on failure. */
async function downloadJchatAttachment(att) {
  const filename = typeof att?.filename === 'string' ? att.filename.trim() : '';
  if (!filename) return null;
  const mime = typeof att?.mime === 'string' && att.mime ? att.mime : 'application/octet-stream';
  const sizeBytes = Number(att?.sizeBytes || 0);
  const name = String(att?.originalName || filename).replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'file';
  if (sizeBytes > ATTACH_MAX_DOWNLOAD_BYTES) return { skipped: true, name, mime, sizeBytes };
  try {
    mkdirSync(JCHAT_FILES_DIR, { recursive: true });
    const url = `${JCHAT_URL}/uploads/${encodeURIComponent(filename)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > ATTACH_MAX_DOWNLOAD_BYTES) return { skipped: true, name, mime, sizeBytes };
    const path = join(JCHAT_FILES_DIR, `${Date.now()}-${name}`);
    writeFileSync(path, buf);
    log('attachment saved:', path, buf.length, 'bytes');
    return { path, bytes: buf.length, name, mime };
  } catch (err) {
    log('attachment download failed:', err.message);
    return null;
  }
}

/** Build the user message for a task, including any jchat attachment: the
 *  file is downloaded to the owner's computer and images are inlined. */
async function buildTaskUserMessage(task, content) {
  const att = task?.attachment;
  if (!att || typeof att?.filename !== 'string' || !att.filename.trim()) {
    return { role: 'user', content };
  }
  // Caption = task content minus any embedded "/file <id>" refs and the
  // /think directive (the gateway strips it from plain strings; for
  // multimodal parts we keep the text clean ourselves).
  const caption = String(content || '')
    .replace(/^\s*\/think:[a-z]+\s*\n*\s*/i, '')
    .replace(/(^|\s)\/file\s+\S+/gi, ' ')
    .trim();
  const saved = await downloadJchatAttachment(att);
  const note = `[User attached a file: ${saved?.name || att.originalName || att.filename}${att.sizeBytes ? `, ${att.sizeBytes} bytes` : ''}]`;
  const isImage = /^image\/(png|jpe?g|webp|gif)$/i.test(saved?.mime || att.mime || '');
  if (saved?.path && isImage && saved.bytes > 0 && saved.bytes <= ATTACH_INLINE_IMAGE_BYTES) {
    const b64 = readFileSync(saved.path).toString('base64');
    return {
      role: 'user',
      content: [
        { type: 'text', text: [caption, `${note} — also saved on your computer at ${saved.path}.`].filter(Boolean).join('\n\n') },
        { type: 'image_url', image_url: { url: `data:${saved.mime};base64,${b64}` } },
      ],
    };
  }
  const extra = saved?.path
    ? ` The file was downloaded to your computer at ${saved.path} — read it with your file tools.`
    : (saved?.skipped ? ' It was too large to download automatically.' : ' The file could not be downloaded (unavailable).');
  return { role: 'user', content: [caption, note + extra].filter(Boolean).join('\n\n') || (note + extra) };
}

async function runAgentOnce(task, controller) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
  };
  if (task.model && VALID_MODELS.has(task.model)) {
    headers['x-openclaw-model'] = task.model;
  }
  let content = String(task.content);
  if (task.effort && VALID_EFFORTS.has(task.effort)) {
    // Thinking-level directive on its own line; OpenClaw strips it from the
    // message and applies the requested reasoning effort for this session.
    content = `/think:${task.effort}\n\n${content}`;
  }
  const sessionKey = resolveTaskSessionKey(task);
  const userMessage = await buildTaskUserMessage(task, content);
  const payload = {
    model: MODEL,
    // System message → merged into the agent's system prompt by the gateway,
    // invisible in the user-visible chat/session history.
    messages: [
      { role: 'system', content: MESSAGE_SOURCE_NOTE },
      userMessage,
    ],
    stream: false,
  };
  if (sessionKey === dmSessionKey(task.convId)) {
    // Default: stable per-DM session key — the OpenClaw agent keeps its own
    // conversation memory across messages in the same DM.
    payload.user = `jchat:dm:${task.convId}`;
  } else {
    // Session switch: explicit routing to the owner-selected session.
    headers['x-openclaw-session-key'] = sessionKey;
  }
  recordSent(sessionKey, content);
  const json = JSON.stringify(payload);
  headers['Content-Length'] = Buffer.byteLength(json);
  const { status, body } = await gatewayRequestJson(
    `${OPENCLAW_GATEWAY_URL}/chat/completions`, headers, json, controller
  );
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(`gateway ${status}: ${body.slice(0, 300)}`), { status });
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('gateway returned a non-JSON reply'); }
  const text = data.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('gateway returned an empty reply');
  return text.trim();
}

async function runAgent(task, controller) {
  let lastErr;
  for (let attempt = 0; attempt < GATEWAY_MAX_ATTEMPTS; attempt++) {
    if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (attempt > 0) {
      // Escalating backoff: a busy session (gateway 500) usually frees up in
      // seconds-to-minutes; retrying with growing delays catches the short
      // cases without stalling forever on long runs.
      const delay = GATEWAY_RETRY_DELAY_MS * Math.pow(3, attempt - 1);
      log('gateway retry', attempt + 1, '/', GATEWAY_MAX_ATTEMPTS, 'in', delay, 'ms after', lastErr?.message || lastErr);
      // Abort-aware wait: a stop during the backoff must cancel the retry
      // instead of firing the same message at the gateway again.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    try {
      return await runAgentOnce(task, controller);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt >= GATEWAY_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr;
}

// --- task handling (serialized per gateway session lane, typing indicator) ---
const chains = new Map();         // sessionKey -> Promise (per-session serialization)
const typingOn = new Map();       // convId -> number of queued tasks
const activeByConv = new Map();   // convId -> taskId (running task, for agent events)
const activeBySession = new Map(); // gateway sessionKey -> taskId (session-switched tasks)
const controllers = new Map();        // taskId -> AbortController (for helper:stop)
const taskSessionKeys = new Map();    // taskId -> gateway sessionKey (gateway-side abort)

// --- gateway session awareness (session switching + live relay) ---------------
let rpcSeq = 1;
const rpcWaiters = new Map();     // rpc id -> resolver
let currentSessionKey = '';       // '' = owner's DM session (default)
let dmConvId = '';                // owner's DM conv id (from server sync; relay target)
let relaySubKey = null;           // gateway session key subscribed for message events
let dmRelaySubKey = null;         // DM session key subscribed for mirror events
let dmSyncTimer = null;           // periodic DM transcript reconcile timer
let listPushTimer = null;
const recentSent = new Map();     // sessionKey -> { text, at } (user msgs we sent via tasks)
const recentReplies = new Map();  // sessionKey -> { text, at } (assistant replies we delivered)
const suppressAssistantUntil = new Map(); // sessionKey -> ts: drop zombie assistant relays after a stop
const relayRate = new Map();      // sessionKey -> [timestamps]
const RELAY_WINDOW_MS = 60 * 1000;
const RELAY_MAX_PER_WINDOW = 20;
const SESSION_LIST_MAX = 30;

/** Call an RPC on the gateway WS (request/response pair). */
function gwRpc(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!gw || gw.readyState !== WebSocket.OPEN) {
      return reject(new Error('gateway ws not open'));
    }
    const id = `br-${rpcSeq++}`;
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(new Error(`${method} rpc timed out`));
    }, timeoutMs);
    rpcWaiters.set(id, (res) => {
      clearTimeout(timer);
      rpcWaiters.delete(id);
      if (res.ok) resolve(res.payload);
      else reject(Object.assign(new Error(res?.error?.message || `${method} failed`), { rpcError: res?.error }));
    });
    try {
      gw.send(JSON.stringify({ type: 'req', id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      rpcWaiters.delete(id);
      reject(err);
    }
  });
}

function dmSessionKey(convId) {
  return convId ? `agent:main:openai-user:jchat:dm:${convId}` : '';
}

function isReservedSessionKey(key) {
  return /^(subagent|cron|acp):/.test(key) || /:(subagent|cron|acp):/.test(key);
}

function isRoutableSessionKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (!/^agent:main(:|$)/.test(key)) return false;
  if (isReservedSessionKey(key)) return false;
  return true;
}

function shortSessionLabel(key) {
  const m = String(key || '').match(/^agent:main:(.+)$/);
  const base = m ? m[1] : String(key || '');
  return base.length > 28 ? `${base.slice(0, 25)}…` : base;
}

/** Compact gateway transcript messages to { role, text, seq, at } for the
 *  session-history view (user/assistant text only, deduped by seq). The
 *  leading `/think:<level>` line the bridge prepends to routed DM messages
 *  is stripped so the view matches what the owner actually sent. */
function compactHistoryMessages(messages) {
  const out = [];
  const seenSeqs = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = typeof m?.role === 'string' ? m.role : '';
    if (role !== 'user' && role !== 'assistant') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    // Media sent through the Control UI lives on the Mac (MediaPaths) with a
    // placeholder text content. Keep both: text (if a real caption) + media
    // file list so the DM/session views can render the actual file.
    const paths = Array.isArray(m?.MediaPaths) ? m.MediaPaths
      : (typeof m?.MediaPath === 'string' ? [m.MediaPath] : []);
    const types = Array.isArray(m?.MediaTypes) ? m.MediaTypes
      : (typeof m?.MediaType === 'string' ? [m.MediaType] : []);
    const media = paths.map((p, i) => ({
      path: String(p),
      mime: String(types[i] || 'application/octet-stream'),
      name: String(p).split('/').pop() || 'file',
    })).filter((x) => x.path);
    const isPlaceholder = media.length > 0 && /^\[.*(media|user sent).*\]$/i.test(text.trim());
    const finalText = isPlaceholder ? '' : text.replace(/^\s*\/think:[a-z]+\s*\n*/i, '').trim();
    if (!finalText && !media.length) continue;
    const seq = typeof m?.__openclaw?.seq === 'number' ? m.__openclaw.seq : 0;
    if (seq > 0 && seenSeqs.has(seq)) continue;
    if (seq > 0) seenSeqs.add(seq);
    const at = typeof m.timestamp === 'number' && m.timestamp > 0 ? m.timestamp
      : (typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : 0);
    out.push({
      role,
      text: finalText,
      seq,
      at: Number.isFinite(at) ? at : 0,
      media: media.length ? media : undefined,
    });
  }
  return out;
}

function resolveTaskSessionKey(task) {
  const s = typeof task?.agentSession === 'string' ? task.agentSession.trim() : '';
  if (s && !isReservedSessionKey(s)) return s;
  return dmSessionKey(task?.convId);
}

/** Curated session list for the owner UI: routable rows + previews, most
 *  recently active first, excluding the owner's DM session itself. */
async function buildSessionList() {
  const payload = await gwRpc('sessions.list', { agentId: 'main' }, 20000);
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const dmKey = dmSessionKey(dmConvId);
  let sessions = rows
    .filter((s) => isRoutableSessionKey(s.key))
    .map((s) => {
      const isDm = dmKey ? s.key === dmKey : false;
      return {
        key: s.key,
        // The owner's own DM session is the jchat conversation itself; give
        // it the same label the picker uses so the entry's live state
        // (activity dot, preview, updatedAt) shows up there too.
        label: isDm ? 'This DM (jchat)' : ((typeof s.displayName === 'string' && s.displayName) ? s.displayName : shortSessionLabel(s.key)),
        isDm,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : (typeof s.lastActivityAt === 'number' ? s.lastActivityAt : 0),
        status: s.status || (s.hasActiveRun ? 'running' : 'done'),
        hasActiveRun: !!s.hasActiveRun,
        model: typeof s.model === 'string' ? s.model : '',
        // Content size for the control-bar badge (updates when switching).
        totalTokens: typeof s.totalTokens === 'number' ? s.totalTokens : 0,
        contextTokens: typeof s.contextTokens === 'number' ? s.contextTokens : 0,
        contextTokenBudget: typeof s.contextBudgetStatus?.contextTokenBudget === 'number' ? s.contextBudgetStatus.contextTokenBudget : 0,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SESSION_LIST_MAX);
  // One-shot previews (first user/assistant text item per session).
  try {
    const keys = sessions.slice(0, 20).map((s) => s.key);
    if (keys.length) {
      const prev = await gwRpc('sessions.preview', { keys, limit: 4, maxChars: 160 }, 20000);
      const byKey = new Map((prev?.previews || []).map((p) => [p.key, p]));
      for (const s of sessions) {
        const items = byKey.get(s.key)?.items || [];
        const hit = items.find((it) => (it.role === 'user' || it.role === 'assistant') && it.text);
        if (hit) s.preview = String(hit.text).replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    }
  } catch (err) {
    log('session preview fetch failed:', err.message);
  }
  return sessions;
}

/** Debounced push of the fresh session list to the jchat server (drives the
 *  owner's picker + "updates when activity happens" requirement). */
function scheduleListPush() {
  if (listPushTimer) return;
  listPushTimer = setTimeout(async () => {
    listPushTimer = null;
    if (!socket.connected || !gwReady) return;
    try {
      const sessions = await buildSessionList();
      log(`session list push: ${sessions.length} sessions`);
      socket.emit('helper:sessions:update', { sessions });
    } catch (err) {
      log('session list push failed:', err.message);
    }
  }, 1500);
}

/** Apply the server's authoritative session selection (from helper:session:sync
 *  or the agentSession field on tasks) and re-subscribe message events. */
function applySessionSync(p) {
  const raw = typeof p?.sessionKey === 'string' ? p.sessionKey.trim() : '';
  currentSessionKey = (raw && !isReservedSessionKey(raw)) ? raw : '';
  if (typeof p?.dmConvId === 'string' && p.dmConvId) dmConvId = p.dmConvId;
  // Two subscriptions now: the owner's DM session itself (so Control-UI
  // webchat messages + assistant replies on that session get mirrored into
  // the jchat DM), plus the switched session if one is selected.
  const dmKey = dmSessionKey(dmConvId);
  const want = (currentSessionKey && currentSessionKey !== dmKey) ? currentSessionKey : null;
  if (dmKey !== dmRelaySubKey) {
    if (dmRelaySubKey) {
      gwRpc('sessions.messages.unsubscribe', { key: dmRelaySubKey }).catch(() => {});
    }
    dmRelaySubKey = null;
    if (dmKey) {
      gwRpc('sessions.messages.subscribe', { key: dmKey })
        .then(() => {
          dmRelaySubKey = dmKey;
          log('dm relay subscribed to:', dmKey);
        })
        .catch((err) => log('dm relay subscribe failed:', err.message));
    }
  }
  if (want === relaySubKey) return;
  if (relaySubKey) {
    gwRpc('sessions.messages.unsubscribe', { key: relaySubKey }).catch(() => {});
  }
  relaySubKey = null;
  if (want) {
    gwRpc('sessions.messages.subscribe', { key: want })
      .then(() => {
        relaySubKey = want;
        log('relay subscribed to:', want);
      })
      .catch((err) => log('relay subscribe failed:', err.message));
  }
}

function recordSent(sessionKey, content) {
  const norm = String(content).replace(/^\s*\/think:[a-z]+\s*\n*\s*/i, '').trim();
  recentSent.set(sessionKey, { text: norm, at: Date.now() });
  if (recentSent.size > 64) {
    const now = Date.now();
    for (const [k, v] of recentSent) if (now - v.at > 10 * 60 * 1000) recentSent.delete(k);
  }
}

function recordReply(sessionKey, text) {
  recentReplies.set(sessionKey, { text: String(text).trim(), at: Date.now() });
  if (recentReplies.size > 64) {
    const now = Date.now();
    for (const [k, v] of recentReplies) if (now - v.at > 10 * 60 * 1000) recentReplies.delete(k);
  }
}

/** Relay activity from the *switched* gateway session into the owner's DM as
 *  Venory messages, so the chat app stays in sync with that session. Own
 *  bridge tasks are deduped (the DM already shows those). */
async function handleSessionMessage(p) {
  if (!p?.sessionKey || !p?.message) return;
  const msg = p.message || {};
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return;
  const text = typeof msg.content === 'string' ? msg.content : (typeof msg.text === 'string' ? msg.text : '');
  if (!text || !text.trim()) return;
  const now = Date.now();
  const clean = text.replace(/\s+/g, ' ').trim();
  const norm = clean.replace(/^\/think:[a-z]+\s*/i, '').trim();
  const dmKey = dmSessionKey(dmConvId);
  const isDmSession = !!dmKey && p.sessionKey === dmKey;

  // Mirror the owner's DM gateway session into the jchat DM: this covers
  // Control-UI webchat messages + assistant replies/narrations that never
  // went through the jchat task path. Own bridge traffic (task user
  // messages, delivered replies) is skipped — those already exist in jchat.
  if (isDmSession) {
    // User messages that carry a /think: prefix came from a bridge task
    // (the bridge prepends it) and are already in the jchat DB; mirror only
    // Control-UI-originated messages (no prefix) + assistant texts.
    if (role === 'user' && /^\/think:[a-z]+\s*/i.test(text)) return;
    const mediaPaths = Array.isArray(msg?.MediaPaths) ? msg.MediaPaths
      : (typeof msg?.MediaPath === 'string' ? [msg.MediaPath] : []);
    const mediaTypes = Array.isArray(msg?.MediaTypes) ? msg.MediaTypes
      : (typeof msg?.MediaType === 'string' ? [msg.MediaType] : []);
    const isPlaceholder = mediaPaths.length > 0 && /^\[.*(media|user sent).*\]$/i.test(text.trim());
    const raw = text.replace(/^\/think:[a-z]+\s*\n*\s*/i, '').trim(); // full text, no prefix
    if (!raw && !mediaPaths.length) return;
    const at = typeof msg.timestamp === 'number' && msg.timestamp > 0 ? msg.timestamp : now;
    if (mediaPaths.length) {
      const mime = String(mediaTypes[0] || 'application/octet-stream');
      const name = String(mediaPaths[0]).split('/').pop() || 'file';
      const up = await uploadMediaToJchat(mediaPaths[0], name, mime);
      const items = [];
      if (up) {
        items.push({ role, fileRef: up.fileRef, msgType: up.msgType, at });
        if (raw && !isPlaceholder) items.push({ role, text: raw.slice(0, 4000), at });
      } else if (!isPlaceholder && raw) {
        items.push({ role, text: raw.slice(0, 4000), at });
      } else {
        items.push({ role, text: `📎 [${name}]`, at });
      }
      if (items.length) {
        log('dm mirror media:', role, name, up ? 'uploaded' : 'note');
        socket.emit('helper:dm:sync', { convId: dmConvId, messages: items });
      }
      return;
    }
    if (role === 'user') {
      suppressAssistantUntil.delete(dmKey); // a fresh turn supersedes a stopped zombie
      const sent = recentSent.get(dmKey);
      if (sent && now - sent.at < 10 * 60 * 1000 && sent.text === raw) return; // our own task
    } else {
      const activeTaskId = activeBySession.get(dmKey);
      if (activeTaskId && controllers.has(activeTaskId)) return; // reply path handles it
      const until = suppressAssistantUntil.get(dmKey) || 0;
      if (now < until) return; // stopped run: swallow the zombie reply
      const rep = recentReplies.get(dmKey);
      if (rep && now - rep.at < 10 * 60 * 1000 && rep.text === raw) return; // just delivered
    }
    log('dm mirror:', role, norm.slice(0, 60));
    socket.emit('helper:dm:sync', {
      convId: dmConvId,
      messages: [{
        role,
        text: raw.slice(0, 4000),
        at,
      }],
    });
    return;
  }

  // Switched-session relay (unchanged): only for the selected session.
  if (!currentSessionKey || p.sessionKey !== currentSessionKey) return; // stale subscription
  log('session msg:', p.sessionKey, role, norm.slice(0, 60));
  // Per-session rate cap so a busy session can't flood the DM or live view.
  const stamps = (relayRate.get(p.sessionKey) || []).filter((t) => now - t < RELAY_WINDOW_MS);
  if (stamps.length >= RELAY_MAX_PER_WINDOW) {
    relayRate.set(p.sessionKey, stamps);
    log('relay rate cap hit for', p.sessionKey);
    return;
  }
  stamps.push(now);
  relayRate.set(p.sessionKey, stamps);
  // Live session view: forward every user/assistant message on the switched
  // session (including messages this bridge itself sent/received), so the
  // owner's page can show the session's real transcript while viewing it.
  const livePayload = {
    convId: dmConvId,
    sessionKey: p.sessionKey,
    role,
    text: norm.slice(0, 2000),
  };
  const liveMediaPaths = Array.isArray(msg?.MediaPaths) ? msg.MediaPaths
    : (typeof msg?.MediaPath === 'string' ? [msg.MediaPath] : []);
  if (liveMediaPaths.length) {
    const mime = String((Array.isArray(msg?.MediaTypes) ? msg.MediaTypes[0] : msg?.MediaType) || 'application/octet-stream');
    const up = await uploadMediaToJchat(liveMediaPaths[0], liveMediaPaths[0].split('/').pop() || 'file', mime);
    if (up) {
      livePayload.fileRef = up.fileRef;
      livePayload.msgType = up.msgType;
      if (/^\[.*(media|user sent).*\]$/i.test(norm)) livePayload.text = '';
    }
  }
  const until = suppressAssistantUntil.get(p.sessionKey) || 0;
  if (role === 'user') {
    suppressAssistantUntil.delete(p.sessionKey); // a fresh turn supersedes a stopped zombie
  } else if (now < until) {
    log('session relay suppressed after stop:', p.sessionKey);
    return; // stopped run: swallow the zombie reply everywhere (live + DM)
  }
  socket.emit('helper:session:live', livePayload);
  // DM relay: assistant replies only. The owner's own user messages on the
  // switched session must NOT be echoed into the DM — they came from the
  // Control UI or another surface, and echoing them back reads as spam
  // ("📡 you: …"). Assistant relays are the useful part of the mirror.
  if (role === 'user') return;
  {
    const activeTaskId = activeBySession.get(p.sessionKey);
    if (activeTaskId && controllers.has(activeTaskId)) return; // reply path handles it
    const rep = recentReplies.get(p.sessionKey);
    if (rep && now - rep.at < 3 * 60 * 1000 && rep.text === clean) return; // just delivered
  }
  if (!dmConvId) return;
  const label = shortSessionLabel(p.sessionKey);
  const prefix = role === 'user' ? `📡 [${label}] you: ` : `📡 [${label}] `;
  socket.emit('helper:session:msg', { convId: dmConvId, text: prefix + clean.slice(0, 400) });
}

/** Media files from the Mac (Control-UI uploads) are uploaded to the jchat
 *  server on demand so chat clients can render them. Cached per Mac path so
 *  the 60s reconcile doesn't re-upload the same file every tick. The cache
 *  persists to disk so a bridge restart maps the same Mac path → same fileRef
 *  (server dedupes by content+time window). */
const MEDIA_CACHE_PATH = new URL('./media-cache.json', import.meta.url).pathname;
const mediaUploadCache = new Map(); // mediaPath -> { fileRef, msgType, mime }

try {
  if (existsSync(MEDIA_CACHE_PATH)) {
    const raw = JSON.parse(readFileSync(MEDIA_CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) {
      if (v?.fileRef) mediaUploadCache.set(k, v);
    }
    log('media cache loaded:', mediaUploadCache.size, 'entries');
  }
} catch (err) {
  log('media cache load failed:', err.message);
}

function persistMediaCache() {
  try {
    writeFileSync(MEDIA_CACHE_PATH, JSON.stringify(Object.fromEntries(mediaUploadCache)));
  } catch (err) {
    log('media cache persist failed:', err.message);
  }
}

async function uploadMediaToJchat(mediaPath, name, mime) {
  const cached = mediaUploadCache.get(mediaPath);
  if (cached) return cached;
  let data;
  try {
    data = readFileSync(mediaPath);
  } catch (err) {
    log('media read failed:', mediaPath, err.message);
    return null;
  }
  if (!data.length || data.length > 50 * 1024 * 1024) return null;
  const res = await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
    try {
      socket.emit('helper:media:upload', { convId: dmConvId, name, mime, data }, (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r || null);
      });
    } catch {
      clearTimeout(timer);
      done = true;
      resolve(null);
    }
  });
  if (res?.ok && res.fileRef) {
    const msgType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    const entry = { fileRef: res.fileRef, msgType, mime };
    mediaUploadCache.set(mediaPath, entry);
    persistMediaCache();
    log('media uploaded:', name, '->', res.fileRef);
    return entry;
  }
  return null;
}

/** Turn compacted transcript entries into helper:dm:sync payload items,
 *  uploading any Mac-side media files first. */
async function enrichForDmSync(entries) {
  const out = [];
  for (const m of entries) {
    if (m.media?.length) {
      const up = await uploadMediaToJchat(m.media[0].path, m.media[0].name, m.media[0].mime);
      if (up) {
        out.push({ role: m.role, fileRef: up.fileRef, msgType: up.msgType, at: m.at });
        if (m.text) out.push({ role: m.role, text: m.text, at: m.at }); // caption as separate text row
        continue;
      }
      // upload failed → fall back to a readable note instead of the placeholder
      if (!m.text) out.push({ role: m.role, text: `📎 [${m.media[0].name}]`, at: m.at });
      else out.push({ role: m.role, text: m.text, at: m.at });
      continue;
    }
    out.push({ role: m.role, text: m.text, at: m.at });
  }
  return out;
}

/** Periodic reconcile: fetch the DM session transcript from the gateway and
 *  push any messages missing from the jchat DM (self-heals gaps from
 *  reconnects, missed live events, Control-UI-only messages). Idempotent:
 *  the server dedupes by sender+content. */
let lastDmSyncedSeq = 0; // highest __openclaw.seq already pushed to the server
async function syncDmFromGateway() {
  if (!gwReady || !socket.connected || !dmConvId) return;
  const dmKey = dmSessionKey(dmConvId);
  if (!dmKey) return;
  try {
    const res = await gwRpc('sessions.get', { key: dmKey, limit: 300 }, 20000);
    const messages = compactHistoryMessages(res?.messages);
    if (!messages.length) return;
    const fresh = lastDmSyncedSeq > 0
      ? messages.filter((m) => m.seq > lastDmSyncedSeq)
      : messages;
    if (!fresh.length) return;
    const maxSeq = Math.max(...fresh.map((m) => m.seq || 0));
    const items = await enrichForDmSync(fresh);
    socket.emit('helper:dm:sync', { convId: dmConvId, messages: items });
    if (maxSeq > lastDmSyncedSeq) lastDmSyncedSeq = maxSeq;
    log(`dm sync reconcile: ${fresh.length} new candidate message(s)`);
  } catch (err) {
    log('dm sync reconcile failed:', err.message);
  }
}

// Reconcile every 60s (covers live gaps; the server dedupes).
setInterval(syncDmFromGateway, 60000);

async function handleTask(task) {
  if (!task || !secretsEqual(task.secret, OPENCLAW_BRIDGE_SECRET)) {
    log('ignored task with missing/bad secret');
    return;
  }
  const { taskId, convId } = task;
  log('task', taskId, 'conv', convId);

  const controller = new AbortController();
  controllers.set(taskId, controller);

  const sessionKey = resolveTaskSessionKey(task);
  if (typeof task?.agentSession === 'string') {
    // Server-authoritative session selection; apply immediately so live
    // agent events for this session map to this task, and so the relay
    // subscription self-heals if the connect-time sync was missed.
    currentSessionKey = task.agentSession;
    applySessionSync({ sessionKey: task.agentSession, dmConvId: task.convId });
  }

  const pending = (typingOn.get(convId) || 0) + 1;
  typingOn.set(convId, pending);
  if (pending === 1) socket.emit('typing:start', { roomType: 'dm', roomId: convId });

  // Serialize per gateway session lane, not per DM conversation: the gateway
  // rejects concurrent runs for the SAME session, but a session-routed send
  // targets a different session and must start immediately — queuing it
  // behind the active DM run made every cross-session send look dead.
  const lane = sessionKey;
  const isDmLane = lane === dmSessionKey(convId);
  const prev = chains.get(lane) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => {
      // activeByConv is only the fallback lookup for DM-session agent events;
      // keep it pointing at the DM lane's task even while a routed task for
      // another session runs concurrently.
      if (isDmLane) activeByConv.set(convId, taskId);
      activeBySession.set(sessionKey, taskId);
      taskSessionKeys.set(taskId, sessionKey);
      return runAgent(task, controller);
    })
    .then((text) => {
      recordReply(sessionKey, text);
      socket.emit('helper:reply', { taskId, text });
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        log('task stopped:', taskId);
        socket.emit('helper:stopped', { taskId });
      } else {
        log('task failed:', err.message);
        socket.emit('helper:error', {
          taskId,
          message: `My full assistant hit an error: ${String(err.message).slice(0, 200)}`,
        });
      }
    })
    .finally(() => {
      controllers.delete(taskId);
      taskSessionKeys.delete(taskId);
      if (activeByConv.get(convId) === taskId) activeByConv.delete(convId);
      if (activeBySession.get(sessionKey) === taskId) activeBySession.delete(sessionKey);
    });
  chains.set(lane, run);

  await run;
  if (chains.get(lane) === run) chains.delete(lane);
  const left = (typingOn.get(convId) || 1) - 1;
  if (left <= 0) {
    typingOn.delete(convId);
    socket.emit('typing:stop', { roomType: 'dm', roomId: convId });
  } else {
    typingOn.set(convId, left);
  }
}

// --- socket lifecycle --------------------------------------------------------
socket.on('connect', () => {
  log('connected to', JCHAT_URL, 'as helper bridge');
  // Server may have restarted (deploy) and dropped our helper:dm:sync
  // messages; a fresh full reconcile is idempotent (server dedupes).
  lastDmSyncedSeq = 0;
  syncDmFromGateway();
});
socket.on('disconnect', (reason) => log('disconnected:', reason));
socket.on('connect_error', (err) => log('connect error:', err.message));
socket.on('helper:task', (task) => {
  handleTask(task);
});
socket.on('helper:stop', (p) => {
  let sk = typeof p?.sessionKey === 'string' ? p.sessionKey.trim() : '';
  const taskId = typeof p?.taskId === 'string' ? p.taskId : '';
  if (!sk && taskId) sk = taskSessionKeys.get(taskId) || '';
  const controller = controllers.get(taskId);
  if (controller) controller.abort();
  // A session-scoped stop may arrive WITHOUT a taskId (routed tasks have no
  // server-side busy-map entry): abort whatever task runs on that session.
  if (sk && !controller) {
    const activeTaskId = activeBySession.get(sk);
    if (activeTaskId) controllers.get(activeTaskId)?.abort();
  }
  // Zombie suppression: the gateway may keep running the turn after our
  // abort (its chatAbortControllers only covers Control-UI-visible runs).
  // Drop assistant relays for this session for a window so a stopped reply
  // can't "auto-continue" into the DM a few seconds later.
  if (sk) {
    const nowTs = Date.now();
    for (const [k, v] of suppressAssistantUntil) if (v < nowTs) suppressAssistantUntil.delete(k);
    suppressAssistantUntil.set(sk, nowTs + 10 * 60 * 1000);
  }
  // Also abort the gateway run itself (not just our HTTP request): a
  // destroyed request alone doesn't reliably stop the agent turn, and a
  // session-scoped stop for a viewed session has no local task at all.
  if (sk) {
    gwRpc('sessions.abort', { key: sk }, 8000)
      .then(() => log('session abort requested for', sk))
      .catch((err) => log('session abort failed:', err.message));
  }
});
// Owner session picker: server asks the bridge to build the session list.
socket.on('helper:sessions:get', async (p) => {
  const reqId = p?.reqId;
  if (!reqId) return;
  if (!gwReady) {
    socket.emit('helper:sessions:result', { reqId, ok: false, error: 'gateway offline' });
    return;
  }
  try {
    const sessions = await buildSessionList();
    socket.emit('helper:sessions:result', { reqId, ok: true, sessions });
  } catch (err) {
    socket.emit('helper:sessions:result', { reqId, ok: false, error: err.message });
  }
});
// Owner session history: server asks the bridge to fetch a session's recent
// messages from the gateway (sessions.get) so the chat page can replace the
// DM view with that session's conversation. The sessions themselves keep
// running on the Mac — this only reads their transcripts.
socket.on('helper:sessions:history', async (p) => {
  const reqId = p?.reqId;
  const key = typeof p?.key === 'string' ? p.key.trim() : '';
  if (!reqId || !key) return;
  if (!gwReady) {
    socket.emit('helper:sessions:history:result', { reqId, ok: false, error: 'gateway offline' });
    return;
  }
  try {
    const limit = Number.isFinite(p?.limit) ? Math.max(1, Math.min(500, Math.floor(p.limit))) : 300;
    const res = await gwRpc('sessions.get', { key, limit }, 20000);
    const messages = compactHistoryMessages(res?.messages);
    // Upload any Mac-side media so the session view can render the real files.
    const enriched = await Promise.all(messages.slice(-100).map(async (m) => {
      if (!m.media?.length) return m;
      const up = await uploadMediaToJchat(m.media[0].path, m.media[0].name, m.media[0].mime);
      if (up) return { role: m.role, text: m.text, seq: m.seq, at: m.at, fileRef: up.fileRef, msgType: up.msgType };
      if (m.text) return { role: m.role, text: m.text, seq: m.seq, at: m.at };
      return { role: m.role, text: `📎 [${m.media[0].name}]`, seq: m.seq, at: m.at };
    }));
    socket.emit('helper:sessions:history:result', { reqId, ok: true, key, messages: enriched });
  } catch (err) {
    socket.emit('helper:sessions:history:result', { reqId, ok: false, error: err.message });
  }
});
// Server pushes the persisted session selection (on bridge connect and on
// change) so routing + relay subscriptions stay in sync.
socket.on('helper:session:sync', (p) => applySessionSync(p));

// Owner tapped Compact on the control bar → compact that session on the
// gateway (sessions.compact). Compaction may be refused while a run is
// active; surface the gateway's reason either way.
socket.on('helper:compact', async (p) => {
  const key = typeof p?.sessionKey === 'string' && p.sessionKey ? p.sessionKey : '';
  if (!key) return;
  try {
    const res = await gwRpc('sessions.compact', { key }, 60000);
    const compacted = !!res?.compacted;
    const reason = !compacted && typeof res?.reason === 'string' ? res.reason : '';
    const message = compacted
      ? 'Session compacted'
      : (reason ? `Nothing to compact: ${reason}` : 'Nothing to compact');
    socket.emit('helper:compact:result', { convId: dmConvId, sessionKey: key, ok: true, compacted, message });
    scheduleListPush();
  } catch (err) {
    log('compact failed:', err.message);
    socket.emit('helper:compact:result', {
      convId: dmConvId,
      sessionKey: key,
      ok: false,
      error: String(err.message).slice(0, 200),
    });
  }
});

// Owner answered an ask_user question in the DM → resolve it on the gateway.
// All of a record's answers are sent in ONE resolve — the gateway rejects
// partial answers ("complete the other question").
socket.on('helper:answer', async (p) => {
  const recordId = typeof p?.recordId === 'string' ? p.recordId : '';
  const rawAnswers = Array.isArray(p?.answers) && p.answers.length
    ? p.answers
    : (typeof p?.questionId === 'string' && p.questionId
      ? [{ questionId: p.questionId, values: p?.values }]
      : []);
  const answers = rawAnswers.map((a) => ({
    questionId: typeof a?.questionId === 'string' ? a.questionId : '',
    values: (Array.isArray(a?.values) ? a.values : [])
      .filter((v) => typeof v === 'string' && v)
      .slice(0, 4),
  })).filter((a) => a.questionId && a.values.length);
  if (!/^ask_[a-f0-9]{32}$/.test(recordId) || !answers.length) return;
  try {
    await gwRpc('question.resolve', {
      id: recordId,
      answers: { answers: Object.fromEntries(answers.map((a) => [a.questionId, a.values])) },
      resolvedBy: 'jimmyqrg',
    }, 8000);
    pendingQuestions.delete(recordId);
    log('question resolved:', recordId, answers.map((a) => `${a.questionId}:${a.values.join('|')}`).join(' '));
  } catch (err) {
    log('question resolve failed:', err.message);
    const msg = String(err.message || '');
    // Dead record (timed out / cancelled on the gateway): purge it everywhere
    // so the server map and the owner's panel drop the stale question.
    if (/not found|cancelled|expired/i.test(msg)) {
      pendingQuestions.delete(recordId);
      socket.emit('helper:question:resolved', { convId: dmConvId, recordId, status: 'expired' });
    }
    socket.emit('helper:question:resolve-failed', {
      convId: dmConvId,
      recordId,
      questionId: answers[0]?.questionId || '',
      error: msg.slice(0, 120),
    });
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    try { gw?.close(); } catch (_) {}
    socket.close();
    process.exit(0);
  });
}

log('bridge starting, target:', JCHAT_URL);
connectGatewayWs();

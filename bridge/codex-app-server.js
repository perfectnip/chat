import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';

const BIN = process.env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex';
const CWD = process.env.CODEX_JCHAT_CWD || homedir();
const FETCH_TIMEOUT = Number(process.env.CODEX_APP_SERVER_TIMEOUT_MS || 36 * 60 * 60 * 1000);
const MODEL_ID_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Keep bridge-owned conversations separate from any session ids that may have
// been selected in the desktop Codex app. Older versions reused
// codex-dm-sessions.json, which could contain a desktop-owned thread and make
// the desktop report “This is open in another app”.
const DM_SESSIONS_PATH = new URL('./codex-bridge-sessions.json', import.meta.url).pathname;
const dmSessions = new Map();
try {
  const raw = JSON.parse(readFileSync(DM_SESSIONS_PATH, 'utf8'));
  for (const [k, v] of Object.entries(raw || {})) if (typeof v === 'string' && v) dmSessions.set(k, v);
} catch {}

let proc;
let seq = 0;
let online = false;
let stopping = false;
let buffer = '';
let restartTimer;
const pending = new Map();
const activeTurns = new Map();
const pendingRequests = new Map();
const convByThread = new Map();
let socket;
let lastConvId = '';

function log(...args) { console.log(new Date().toISOString(), '[codex-bridge]', ...args); }
function persistDmSessions() {
  try { writeFileSync(DM_SESSIONS_PATH, JSON.stringify(Object.fromEntries(dmSessions), null, 2) + '\n', { mode: 0o600 }); }
  catch (err) { log('session map persistence failed:', err.message); }
}
function setStatus(value) {
  online = !!value;
  socket?.emit('helper:codex:status', { online });
}
async function waitUntilOnline(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!online && proc && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!online) throw new Error('Codex app-server is offline (is Codex installed and signed in on this Mac?)');
}
function write(message) {
  if (!proc?.stdin?.writable) throw new Error('Codex app-server is not running');
  proc.stdin.write(JSON.stringify(message) + '\n');
}
function rpc(method, params = {}, timeoutMs = 30000) {
  const id = `jchat-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { write({ jsonrpc: '2.0', id, method, params }); }
    catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
  });
}
function serverReply(id, result, error) {
  try { write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }); }
  catch (err) { log('could not answer Codex request:', err.message); }
}
function failAll(err) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(err); }
  pending.clear();
  for (const turn of activeTurns.values()) { clearTimeout(turn.timer); turn.reject(err); }
  activeTurns.clear();
  pendingRequests.clear();
}
function handleServerRequest(msg) {
  const id = msg.id;
  const p = msg.params || {};
  const recordId = String(id);
  const convId = convByThread.get(p.threadId) || lastConvId;
  if (msg.method === 'item/tool/requestUserInput') {
    const questions = (Array.isArray(p.questions) ? p.questions : []).map((q) => ({
      questionId: String(q?.id || ''), header: String(q?.header || ''), question: String(q?.question || ''),
      multiSelect: false, custom: !!q?.isOther || !Array.isArray(q?.options) || !q.options.length,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: String(o?.label || ''), description: String(o?.description || '') })).filter((o) => o.label),
    })).filter((q) => q.questionId && q.question);
    if (!questions.length) return serverReply(id, { answers: {} });
    pendingRequests.set(recordId, { id, type: 'question', questions, convId });
    socket?.emit('helper:codex:question', { convId, recordId, questions });
    return;
  }
  if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval') {
    const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '');
    const permission = msg.method.includes('fileChange') ? 'Apply file changes' : (p.networkApprovalContext ? `Network access to ${p.networkApprovalContext.host || 'requested destination'}` : 'Run command');
    const patterns = [command, p.cwd && `Directory: ${p.cwd}`, p.reason].filter(Boolean);
    pendingRequests.set(recordId, { id, type: 'permission', method: msg.method, convId });
    socket?.emit('helper:codex:permission', { convId, recordId, permission, patterns });
    return;
  }
  if (msg.method === 'item/permissions/requestApproval') {
    const requested = p.permissions || {};
    const fs = requested.fileSystem || {};
    const net = requested.network || {};
    const patterns = [
      ...(Array.isArray(fs.read) ? fs.read.map((x) => `Read: ${x}`) : []),
      ...(Array.isArray(fs.write) ? fs.write.map((x) => `Write: ${x}`) : []),
      ...(net.enabled ? ['Network access requested'] : []),
    ];
    pendingRequests.set(recordId, { id, type: 'permissions', permissions: requested, convId });
    socket?.emit('helper:codex:permission', { convId, recordId, permission: String(p.reason || 'Additional access requested'), patterns });
    return;
  }
  if (msg.method === 'mcpServer/elicitation/request') {
    // This client does not yet render arbitrary MCP forms or URL hand-offs.
    // Explicitly decline instead of leaving the Codex turn waiting forever.
    serverReply(id, { action: 'decline', content: null });
    return;
  }
  log('declining unsupported Codex request:', msg.method);
  serverReply(id, null, { code: -32601, message: 'This Codex request is not supported in jchat.' });
  if (p.threadId) {
    // A future interactive request type may have no matching chat UI. Fail
    // this turn visibly and release the chat's busy state instead of waiting
    // indefinitely for a response that can never arrive.
    const turn = activeTurns.get(p.threadId);
    if (turn) {
      activeTurns.delete(p.threadId);
      clearTimeout(turn.timer);
      turn.reject(new Error(`Unsupported Codex request: ${msg.method}`));
    }
    rpc('turn/interrupt', { threadId: p.threadId }, 10000).catch(() => {});
  }
}
function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(String(msg.id))) {
    const item = pending.get(String(msg.id));
    pending.delete(String(msg.id)); clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(msg.error.message || 'Codex app-server request failed'));
    else item.resolve(msg.result || {});
    return;
  }
  if (msg.method && msg.id !== undefined) { handleServerRequest(msg); return; }
  const p = msg.params || {};
  if (msg.method === 'item/agentMessage/delta') {
    const turn = activeTurns.get(p.threadId);
    if (turn && typeof p.delta === 'string') turn.text += p.delta;
  } else if (msg.method === 'item/started' || msg.method === 'item/completed') {
    const turn = activeTurns.get(p.threadId);
    const item = p.item || {};
    if (msg.method === 'item/completed' && turn && item.type === 'agentMessage' && typeof item.text === 'string') turn.lastMessage = item.text;
    if (turn && item.type && item.type !== 'agentMessage' && item.type !== 'userMessage' && item.type !== 'reasoning') {
      const id = String(item.id || '');
      const type = String(item.type);
      const name = type === 'commandExecution' ? 'command' : type === 'webSearch' ? 'search' : type === 'fileChange' ? 'file' : type;
      const rawTitle = item.command || item.toolName || item.name || item.title || item.filePath || item.query || '';
      const title = String(rawTitle).slice(0, 500);
      socket?.emit('helper:codex:tool', {
        convId: convByThread.get(p.threadId) || lastConvId,
        threadId: p.threadId,
        id,
        name,
        title,
        status: msg.method === 'item/started' ? 'running' : (item.status === 'failed' ? 'failed' : 'completed'),
      });
    }
  } else if (msg.method === 'turn/completed') {
    const turn = activeTurns.get(p.turn?.threadId || p.threadId);
    const threadId = p.turn?.threadId || p.threadId;
    if (threadId) socket?.emit('helper:codex:turn:status', { convId: convByThread.get(threadId) || lastConvId, threadId, status: 'done' });
    if (turn) {
      activeTurns.delete(threadId); clearTimeout(turn.timer);
      if (p.turn?.status === 'failed') turn.reject(new Error(p.turn?.error?.message || 'Codex turn failed'));
      else turn.resolve(String(turn.lastMessage || turn.text || '').trim());
    }
  } else if (msg.method === 'serverRequest/resolved') {
    const recordId = String(p.requestId ?? '');
    const req = pendingRequests.get(recordId);
    if (req) {
      pendingRequests.delete(recordId);
      const category = req.type === 'question' ? 'question' : 'permission';
      socket?.emit(`helper:codex:${category}:resolved`, { convId: req.convId || convByThread.get(p.threadId) || lastConvId, recordId });
    }
  } else if (msg.method === 'turn/started') {
    const threadId = p.turn?.threadId || p.threadId;
    if (threadId) socket?.emit('helper:codex:turn:status', { convId: convByThread.get(threadId) || lastConvId, threadId, status: 'working' });
  }
}
function connect() {
  if (stopping || proc || !existsSync(BIN)) { if (!existsSync(BIN)) log('Codex executable not found; configure CODEX_BIN'); return; }
  buffer = '';
  proc = spawn(BIN, ['app-server', '--stdio'], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (line) handleLine(line); }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (s) => { const msg = String(s).trim(); if (msg) log('app-server:', msg.slice(0, 500)); });
  proc.on('error', (err) => log('process error:', err.message));
  proc.on('exit', (code) => {
    log('app-server exited:', code);
    proc = null; setStatus(false); failAll(new Error('Codex app-server stopped'));
    if (!stopping && socket?.connected) { clearTimeout(restartTimer); restartTimer = setTimeout(connect, 5000); }
  });
  rpc('initialize', { clientInfo: { name: 'jchat', title: 'JimmyQrg Chat', version: '1.0.0' } }, 30000)
    .then(() => { write({ jsonrpc: '2.0', method: 'initialized', params: {} }); setStatus(true); log('app-server ready'); })
    .catch((err) => { log('app-server initialize failed:', err.message); proc?.kill(); });
}
function normalizeModels(data) {
  return (Array.isArray(data?.data) ? data.data : []).filter((m) => m?.id && !m.hidden).map((m) => ({
    id: String(m.id), label: String(m.displayName || m.name || m.id),
    efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map((x) => {
      const id = String(x.reasoningEffort || '');
      return { id, label: id ? id[0].toUpperCase() + id.slice(1) : '' };
    }).filter((x) => x.id),
    defaultEffort: String(m.defaultReasoningEffort || ''), isDefault: !!m.isDefault,
  }));
}
export function normalizeSessions(data, sessionCwd = CWD) {
  const expectedCwd = resolve(sessionCwd);
  return (Array.isArray(data?.data) ? data.data : []).map((t) => ({
    key: String(t.id || ''), label: String(t.name || t.preview || t.id || 'Codex conversation'),
    updatedAt: Number(t.updatedAt || t.updated_at || 0) * (Number(t.updatedAt || t.updated_at || 0) < 1e12 ? 1000 : 1),
    model: String(t.model || ''), totalTokens: Number(t.tokenUsage?.totalTokens || 0),
    contextTokens: Number(t.tokenUsage?.lastTotalTokens || 0), contextTokenBudget: Number(t.modelContextWindow || 0),
    cwd: typeof t.cwd === 'string' ? resolve(t.cwd) : '',
  })).filter((s) => s.key && s.cwd === expectedCwd).map(({ cwd, ...session }) => session);
}
async function ensureThread(convId, selected, model) {
  const key = selected || dmSessions.get(convId);
  if (key) { await rpc('thread/resume', { threadId: key }, 30000); convByThread.set(key, convId); return key; }
  const thread = await rpc('thread/start', { cwd: CWD, ...(typeof model === 'string' && MODEL_ID_RE.test(model) ? { model } : {}), serviceName: 'jchat' }, 30000);
  const id = thread.thread?.id;
  if (!id) throw new Error('Codex did not create a conversation');
  dmSessions.set(convId, id); persistDmSessions(); convByThread.set(id, convId);
  return id;
}
async function run(task, controller) {
  await waitUntilOnline();
  const threadId = await ensureThread(task.convId, task.codexSession, task.codexModel);
  lastConvId = task.convId; convByThread.set(threadId, task.convId);
  let content = String(task.content || '');
  let attachmentInput;
  const attachment = task?.attachment;
  if (attachment && typeof attachment.filename === 'string' && attachment.filename.trim()) {
    const saved = typeof downloadAttachment === 'function' ? await downloadAttachment(attachment) : null;
    if (saved?.path && String(attachment.mime || '').startsWith('image/')) {
      attachmentInput = { type: 'localImage', path: saved.path };
    } else if (saved?.path) {
      content += `\n\n[The user attached ${saved.name}. It is saved locally at ${saved.path}; read it if relevant.]`;
    } else {
      content += `\n\n[The user attached ${saved?.name || attachment.originalName || attachment.filename}, but it could not be downloaded${saved?.skipped ? ' because it is too large' : ''}.]`;
    }
  }
  const input = [{ type: 'text', text: content }];
  if (attachmentInput) input.push(attachmentInput);
  const params = { threadId, input };
  if (typeof task.codexModel === 'string' && MODEL_ID_RE.test(task.codexModel)) params.model = task.codexModel;
  if (VALID_EFFORTS.has(task.effort)) params.effort = task.effort;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { activeTurns.delete(threadId); reject(new Error('Codex response timed out')); }, FETCH_TIMEOUT);
    activeTurns.set(threadId, { text: '', lastMessage: '', resolve, reject, timer, taskId: task.taskId });
  });
  const onAbort = () => { rpc('turn/interrupt', { threadId }, 10000).catch(() => {}); const turn = activeTurns.get(threadId); if (turn) { clearTimeout(turn.timer); activeTurns.delete(threadId); turn.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); } };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await rpc('turn/start', params, 30000);
    const text = await done;
    socket?.emit('helper:codex:session:updated', { convId: task.convId, key: threadId });
    return text;
  }
  catch (err) { const turn = activeTurns.get(threadId); if (turn) { clearTimeout(turn.timer); activeTurns.delete(threadId); turn.reject(err); } throw err; }
  finally { controller.signal.removeEventListener('abort', onAbort); }
}
async function listSessions() {
  await waitUntilOnline();
  const out = await rpc('thread/list', { limit: 80, archived: false, sourceKinds: ['appServer', 'cli', 'vscode', 'exec'] }, 20000);
  return normalizeSessions(out);
}
async function history(id) {
  await waitUntilOnline();
  const out = await rpc('thread/read', { threadId: id, includeTurns: true }, 30000);
  const turns = out.thread?.turns || [];
  const messages = [];
  for (const turn of turns) for (const item of (turn.items || [])) {
    if (item.type === 'userMessage') {
      const text = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) messages.push({ role: 'user', text: text.slice(0, 4000), at: 0 });
    } else if (item.type === 'agentMessage' && item.text) messages.push({ role: 'assistant', text: String(item.text).slice(0, 4000), at: 0 });
  }
  return messages.slice(-300);
}
export function startCodexBridge(io, { downloadAttachment } = {}) {
  socket = io;
  connect();
  io.on('connect', () => { if (!proc) connect(); else setStatus(online); });
  io.on('disconnect', () => {});
  io.on('helper:codex:sessions:get', async ({ reqId } = {}) => {
    try { const sessions = await listSessions(); io.emit('helper:codex:sessions:result', { reqId, ok: true, sessions }); }
    catch (err) { io.emit('helper:codex:sessions:result', { reqId, ok: false, error: err.message }); }
  });
  io.on('helper:codex:session:create', async ({ reqId, title } = {}) => {
    try {
      await waitUntilOnline();
      const thread = await rpc('thread/start', { cwd: CWD, serviceName: 'jchat' }, 30000);
      const key = thread.thread?.id;
      if (!key) throw new Error('Codex did not create a conversation');
      if (title) await rpc('thread/name/set', { threadId: key, name: String(title).slice(0, 100) }, 10000).catch(() => {});
      convByThread.set(key, lastConvId);
      io.emit('helper:codex:session:create:result', { reqId, ok: true, session: { key, label: String(title || 'New Codex conversation') } });
    } catch (err) { io.emit('helper:codex:session:create:result', { reqId, ok: false, error: err.message }); }
  });
  io.on('helper:codex:models:get', async ({ reqId } = {}) => {
    try { await waitUntilOnline(); const result = await rpc('model/list', { limit: 100, includeHidden: false }, 20000); io.emit('helper:codex:models:result', { reqId, ok: true, models: normalizeModels(result) }); }
    catch (err) { io.emit('helper:codex:models:result', { reqId, ok: false, error: err.message }); }
  });
  io.on('helper:codex:sessions:history', async ({ reqId, id } = {}) => {
    try { const messages = await history(id); io.emit('helper:codex:sessions:history:result', { reqId, ok: true, id, messages }); }
    catch (err) { io.emit('helper:codex:sessions:history:result', { reqId, ok: false, error: err.message }); }
  });
  io.on('helper:codex:compact', async ({ id, convId } = {}) => {
    const threadId = id || dmSessions.get(convId);
    if (!threadId) return io.emit('helper:codex:compact:result', { convId, ok: false, error: 'No Codex conversation is selected.' });
    try { await waitUntilOnline(); await rpc('thread/resume', { threadId }, 20000); await rpc('thread/compact/start', { threadId }, 20000); io.emit('helper:codex:compact:result', { convId, ok: true, message: 'Codex context compaction started.' }); }
    catch (err) { io.emit('helper:codex:compact:result', { convId, ok: false, error: err.message }); }
  });
  io.on('helper:codex:answer', ({ recordId, answers } = {}) => {
    const req = pendingRequests.get(String(recordId));
    if (!req || req.type !== 'question') return;
    const mapped = {};
    req.questions.forEach((q, index) => {
      const vals = Array.isArray(answers?.[index]) ? answers[index].filter((x) => typeof x === 'string').slice(0, 8) : [];
      mapped[q.questionId] = { answers: vals };
    });
    pendingRequests.delete(String(recordId));
    serverReply(req.id, { answers: mapped });
    io.emit('helper:codex:question:resolved', { convId: req.convId || lastConvId, recordId: String(recordId) });
  });
  io.on('helper:codex:permission:reply', ({ recordId, reply } = {}) => {
    const req = pendingRequests.get(String(recordId));
    if (!req || !['permission', 'permissions'].includes(req.type)) return;
    pendingRequests.delete(String(recordId));
    if (req.type === 'permissions') {
      const granted = ['accept', 'acceptForSession'].includes(reply) ? req.permissions : {};
      serverReply(req.id, { permissions: granted, scope: reply === 'acceptForSession' ? 'session' : 'turn' });
    } else {
      serverReply(req.id, { decision: ['accept', 'acceptForSession', 'decline', 'cancel'].includes(reply) ? reply : 'decline' });
    }
    io.emit('helper:codex:permission:resolved', { convId: req.convId || lastConvId, recordId: String(recordId) });
  });
  io.on('helper:stop', ({ taskId } = {}) => { if (taskId) activeTurns.forEach((turn, key) => { if (turn.taskId === taskId) rpc('turn/interrupt', { threadId: key }, 10000).catch(() => {}); }); });
  return {
    run,
    online: () => online,
    stop() {
      stopping = true;
      clearTimeout(restartTimer);
      failAll(new Error('Codex bridge stopped'));
      try { proc?.kill('SIGTERM'); } catch {}
      proc = null;
      setStatus(false);
    },
  };
}

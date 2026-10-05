#!/usr/bin/env node
// Claude bridge: lets the Rokid "Claude Bot" agent browse Claude Code sessions
// on this Mac (grouped by worktree) and reply to them.
//
// Reads ~/.claude/projects/<dir>/<session>.jsonl. A reply runs
// `claude -p --resume <session>` in that session's working directory, so it
// continues the same session (also visible in the desktop app).
//
// Replies use the session's own last permission mode, falling back to
// "auto" (fallbackPermissionMode). "bypassPermissions" is never used from the
// glasses: it is downgraded to "auto".
//
// Listens on 127.0.0.1 only; the tailnet reaches it through
// `tailscale serve --tcp`. Every request needs the bearer token from
// ~/.claude-bridge/config.json (created on first run, mode 600).
// No dependencies: node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const STATE_DIR = path.join(HOME, '.claude-bridge');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');

// A session written to this recently is treated as open somewhere else.
const ACTIVE_MS = 90 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
// Worktree (project dir) names start with '-' (the path with / → -) and only
// reach file paths. Session ids also reach argv, so no leading '-' there.
const PROJECT_RE = /^-?[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_RUNS = 3; // replies running at once, across all sessions
const KILL_GRACE_MS = 10 * 1000;
const MAX_TRANSCRIPT_ITEMS = 2000;
const LOG_PATH = path.join(STATE_DIR, 'bridge.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MODES = new Set(['default', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']);

// ---------------------------------------------------------------- config

function loadConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const defaults = {
    token: crypto.randomBytes(32).toString('hex'),
    port: 8790,
    // Used when a session has no recorded mode.
    fallbackPermissionMode: 'auto',
    // `claude` on the PATH (the service installer puts its folder there).
    claudePath: 'claude',
    // MCP servers left out of runs started by the bridge. Browser MCP allows
    // one server per port: a reply that starts its own takes the Chrome
    // extension from your open Claude Code session.
    excludeMcpServers: ['browsermcp'],
  };
  const merged = { ...defaults, ...config };
  if (JSON.stringify(merged) !== JSON.stringify(config)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  }
  fs.chmodSync(CONFIG_PATH, 0o600);
  // An empty token would let unauthenticated requests through.
  if (typeof merged.token !== 'string' || merged.token.length < 32) {
    throw new Error(`${CONFIG_PATH}: "token" must be a string of at least 32 characters`);
  }
  return merged;
}

// The bridge writes its own log (launchd's stdout only catches crashes) and
// keeps it under LOG_MAX_BYTES by rolling it to bridge.log.1.
let logWrites = 0;

function rotateLog() {
  try {
    if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch (e) {}
}

const config = loadConfig();

function log(...args) {
  const line = [new Date().toISOString(), ...args].map((a) => (typeof a === 'string' ? a : String(a?.stack || a))).join(' ') + '\n';
  if (logWrites++ % 100 === 0) rotateLog();
  try {
    fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch (e) {
    process.stdout.write(line);
  }
}

// The mode a reply runs with: the session's own, never bypassPermissions.
function replyMode(sessionMode) {
  const fallback = ALLOWED_MODES.has(config.fallbackPermissionMode) ? config.fallbackPermissionMode : 'auto';
  if (!sessionMode || sessionMode === 'bypassPermissions') return fallback;
  return ALLOWED_MODES.has(sessionMode) ? sessionMode : fallback;
}

// ---------------------------------------------------------------- reading sessions

async function readSlice(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Parses JSONL text, skipping the partial first/last line of a slice.
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {}
  }
  return out;
}

// Removes harness wrappers (<system-reminder>, command echoes) from user text.
function cleanUserText(text) {
  return String(text)
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-args|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, '! $1')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
}

function userText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return cleanUserText(content);
  if (!Array.isArray(content)) return '';
  // Arrays holding tool_result blocks are tool output, not something typed.
  if (content.some((b) => b?.type === 'tool_result')) return '';
  return cleanUserText(content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
}

function toolSummary(block) {
  const input = block.input || {};
  const detail = input.description || input.command || input.file_path || input.pattern || input.url || input.query || input.prompt || '';
  return `▸ ${block.name}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 120) : ''}`;
}

function assistantParts(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && block.text?.trim()) parts.push({ kind: 'text', text: block.text.trim() });
    else if (block?.type === 'tool_use') parts.push({ kind: 'tool', text: toolSummary(block) });
  }
  return parts;
}

// Summary of one session file, cached by mtime + size.
const summaryCache = new Map();

async function summarize(file) {
  const stat = await fsp.stat(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = summaryCache.get(file);
  if (cached && cached.key === key) return cached.value;

  const head = parseLines(await readSlice(file, 0, Math.min(HEAD_BYTES, stat.size)));
  const tailStart = Math.max(0, stat.size - TAIL_BYTES);
  const tail = tailStart === 0 ? head : parseLines(await readSlice(file, tailStart, stat.size - tailStart));

  let cwd = '';
  let branch = '';
  let firstPrompt = '';
  let mode = '';
  for (const entry of head) {
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!branch && entry.gitBranch) branch = entry.gitBranch;
    if (!firstPrompt) firstPrompt = userText(entry);
    if (entry.type === 'user' && entry.permissionMode) mode = entry.permissionMode;
  }
  let title = '';
  let lastText = '';
  for (const entry of tail) {
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    // The session belongs to the folder it started in (where --resume must
    // run), even if it cd'd elsewhere later.
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (entry.gitBranch) branch = entry.gitBranch;
    if (entry.type === 'user' && entry.permissionMode) mode = entry.permissionMode;
    const parts = assistantParts(entry).filter((p) => p.kind === 'text');
    if (parts.length) lastText = parts[parts.length - 1].text;
  }

  const value = {
    id: path.basename(file, '.jsonl'),
    title: title || firstPrompt.split('\n')[0].slice(0, 80) || '(untitled)',
    cwd,
    branch,
    mode,
    lastText: lastText.replace(/\s+/g, ' ').slice(0, 160),
    updated: stat.mtimeMs,
    hasPrompt: Boolean(firstPrompt || title),
  };
  summaryCache.set(file, { key, value });
  return value;
}

// Fallback when no entry names the cwd: the dir name is the path with / → -.
function decodeProjectDir(name) {
  return name.replace(/-/g, '/');
}

function worktreeLabel(cwd) {
  const m = cwd.match(/^(.*)\/\.claude\/worktrees\/([^/]+)/);
  if (m) return { name: `${path.basename(m[1])} ⎇ ${m[2]}`, repo: path.basename(m[1]), worktree: true };
  return { name: path.basename(cwd) || cwd, repo: path.basename(cwd), worktree: false };
}

async function listSessions(projectDir) {
  const dir = path.join(PROJECTS, projectDir);
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const sessions = [];
  for (const f of files) {
    try {
      const s = await summarize(path.join(dir, f));
      if (s.hasPrompt) sessions.push(s);
    } catch (e) {}
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}

async function listWorktrees() {
  let dirs = [];
  try {
    dirs = (await fsp.readdir(PROJECTS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const dir of dirs) {
    const sessions = await listSessions(dir).catch(() => []);
    if (!sessions.length) continue;
    const cwd = sessions.find((s) => s.cwd)?.cwd || decodeProjectDir(dir);
    const label = worktreeLabel(cwd);
    out.push({
      id: dir,
      name: label.name,
      repo: label.repo,
      isWorktree: label.worktree,
      path: cwd,
      exists: fs.existsSync(cwd),
      branch: sessions.find((s) => s.branch)?.branch || '',
      sessions: sessions.length,
      updated: sessions[0].updated,
      active: sessions.some((s) => isActive(s)),
    });
  }
  // Folders that still exist first (only those can take replies), newest first.
  return out.sort((a, b) => (b.exists - a.exists) || (b.updated - a.updated));
}

// Parsed transcripts, cached by mtime + size (one entry per session file).
const transcriptCache = new Map();

async function transcriptItems(file) {
  const stat = await fsp.stat(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = transcriptCache.get(file);
  // Map order is insertion order: re-inserting on every use makes it LRU.
  transcriptCache.delete(file);
  if (cached && cached.key === key) {
    transcriptCache.set(file, cached);
    return cached.items;
  }
  const items = buildItems(parseLines(await fsp.readFile(file, 'utf8')));
  transcriptCache.set(file, { key, items });
  if (transcriptCache.size > 50) transcriptCache.delete(transcriptCache.keys().next().value);
  return items;
}

// Full transcript as display items, newest last. `before` pages backwards.
async function readTranscript(projectDir, sessionId, before, limit) {
  const file = path.join(PROJECTS, projectDir, sessionId + '.jsonl');
  const items = await transcriptItems(file);
  const end = before == null ? items.length : Math.max(0, Math.min(items.length, before));
  const start = Math.max(0, end - limit);
  return { total: items.length, start, items: items.slice(start, end) };
}

function buildItems(entries) {
  const items = [];
  let lastAssistantId = null;
  for (const entry of entries) {
    const typed = userText(entry);
    if (typed) {
      items.push({ role: 'user', text: typed });
      lastAssistantId = null;
      continue;
    }
    const parts = assistantParts(entry);
    if (!parts.length) continue;
    // One reply can be split over several entries sharing a message id.
    const msgId = entry.message?.id || null;
    for (const part of parts) {
      const prev = items[items.length - 1];
      if (part.kind === 'text' && prev && prev.role === 'assistant' && msgId && msgId === lastAssistantId) {
        prev.text += '\n' + part.text;
      } else {
        items.push({ role: part.kind === 'tool' ? 'tool' : 'assistant', text: part.text });
      }
    }
    lastAssistantId = msgId;
  }
  return items;
}

// ---------------------------------------------------------------- replies

const runs = new Map();
const runBySession = new Map();
// When the bridge's own reply in a session last finished; writes up to then
// were ours, not a busy session on the Mac.
const runEndedAt = new Map();

function isActive(summary) {
  if (runBySession.has(summary.id)) return false;
  if (Date.now() - summary.updated >= ACTIVE_MS) return false;
  const ended = runEndedAt.get(summary.id);
  return !(ended && summary.updated <= ended + 2000);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// MCP servers for a run in `cwd`, as Claude Code would load them: user and
// local (per-project) servers, plus the project's .mcp.json servers only if
// you approved them (enabledMcpjsonServers or enableAllProjectMcpServers,
// minus disabledMcpjsonServers), minus config.excludeMcpServers. Plugin and
// claude.ai connector servers are not included.
//
// Passed with --strict-mcp-config through a mode-600 file, not on the command
// line, so server env values (API keys) don't show up in `ps`. Returns
// { args, cleanup }.
function mcpArgs(cwd) {
  const claudeJson = readJson(path.join(HOME, '.claude.json')) || {};
  const project = claudeJson.projects?.[cwd] || {};
  const settings = [
    readJson(path.join(HOME, '.claude', 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.local.json')),
    project,
  ].filter(Boolean);
  const enableAll = settings.some((s) => s.enableAllProjectMcpServers === true);
  const enabled = new Set(settings.flatMap((s) => s.enabledMcpjsonServers || []));
  const disabled = new Set(settings.flatMap((s) => s.disabledMcpjsonServers || []));

  const servers = { ...(claudeJson.mcpServers || {}), ...(project.mcpServers || {}) };
  const projectServers = readJson(path.join(cwd, '.mcp.json'))?.mcpServers || {};
  for (const [name, server] of Object.entries(projectServers)) {
    if ((enableAll || enabled.has(name)) && !disabled.has(name)) servers[name] = server;
  }
  for (const name of config.excludeMcpServers || []) delete servers[name];

  const file = path.join(STATE_DIR, `mcp-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return {
    args: ['--strict-mcp-config', '--mcp-config', file],
    cleanup: () => fs.rm(file, { force: true }, () => {}),
  };
}

function activeRuns() {
  let n = 0;
  for (const run of runs.values()) if (!run.done) n += 1;
  return n;
}

// Runs `claude -p` in `cwd`: resuming `sessionId`, or starting a new session
// when it is null (its id arrives in the init event and is set on the run).
function startRun({ cwd, sessionId, mode }, text) {
  const id = crypto.randomUUID();
  const run = { id, sessionId, mode, events: [], done: false, error: null, started: Date.now(), stop: null };
  runs.set(id, run);
  if (sessionId) runBySession.set(sessionId, id);
  const push = (kind, value) => run.events.push({ kind, text: value });

  // The reply goes in on stdin, never in argv: text starting with "-" would
  // otherwise be read as a CLI option (e.g. one that skips permissions).
  const mcp = mcpArgs(cwd);
  const args = ['-p', ...(sessionId ? [`--resume=${sessionId}`] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, ...mcp.args];
  log('run', id, 'session', sessionId || '(new)', 'mode', mode, 'cwd', cwd);
  const child = spawn(config.claudePath, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(text);
  let killTimer = null;
  const kill = (reason) => {
    if (run.done || killTimer) return;
    push('error', reason);
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  run.stop = () => kill('Stopped from the glasses');
  const timer = setTimeout(() => kill('Stopped after 30 minutes'), RUN_TIMEOUT_MS);

  let buffer = '';
  // After /compact, claude replays the last kept messages; a replayed
  // slash command output must not show as this run's output.
  let compacted = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        compacted = true;
      } else if (msg.type === 'user') {
        // A command's own result line, e.g. "Compacted".
        const content = msg.message?.content;
        const out = typeof content === 'string' && content.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/);
        if (out && out[1].trim()) push('output', out[1].trim());
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        if (Array.isArray(msg.slash_commands)) rememberCommands(cwd, msg);
        if (!run.sessionId && typeof msg.session_id === 'string' && SESSION_RE.test(msg.session_id)) {
          run.sessionId = msg.session_id;
          runBySession.set(run.sessionId, id);
        }
      } else if (msg.type === 'assistant') {
        // Slash commands (/context, /cost…) answer with a "<synthetic>"
        // message that is not saved in the session file: mark it "output".
        const synthetic = msg.message?.model === '<synthetic>';
        if (synthetic && compacted) continue;
        for (const part of assistantParts(msg)) push(part.kind === 'tool' ? 'tool' : synthetic ? 'output' : 'assistant', part.text);
      } else if (msg.type === 'result') {
        if (msg.is_error) push('error', String(msg.result || msg.subtype || 'Claude reported an error'));
        // A slash command (/context, /cost…) answers only here, and its
        // output is not saved in the session file: pass it on as "output".
        else if (!run.events.some((e) => e.kind === 'assistant' || e.kind === 'output') && typeof msg.result === 'string' && msg.result.trim()) {
          push('output', msg.result.trim());
        } else if (!run.events.some((e) => e.kind === 'assistant' || e.kind === 'output' || e.kind === 'tool')) {
          push('output', 'Done.');
        }
        if (Array.isArray(msg.permission_denials) && msg.permission_denials.length) {
          push('error', `Blocked ${msg.permission_denials.length} action(s) that need approval`);
        }
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });
  // Runs once, whether claude exits or never starts (spawn error).
  const finish = (code) => {
    if (run.done) return;
    mcp.cleanup();
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (code !== 0 && !run.error && !killTimer) run.error = `claude exited with ${code}${stderr ? ': ' + stderr.trim().split('\n').pop() : ''}`;
    run.done = true;
    if (run.sessionId) {
      runBySession.delete(run.sessionId);
      runEndedAt.set(run.sessionId, Date.now());
    }
    log('run', id, 'done', code);
    // Keep finished runs for an hour so the glasses can still read them.
    setTimeout(() => runs.delete(id), 60 * 60 * 1000);
  };
  child.on('error', (e) => {
    run.error = e.code === 'ENOENT' ? `Can't find the claude CLI (claudePath: ${config.claudePath})` : e.message;
    // A spawn failure may never emit 'close'.
    if (!child.pid) finish(-1);
  });
  child.on('close', (code) => finish(code));
  return run;
}

// ---------------------------------------------------------------- commands

// Slash commands available in a folder, from claude's init event. Cached
// from every run; a cold folder is probed by starting claude and stopping it
// as soon as the init event arrives (before any model call).
const COMMANDS_TTL_MS = 10 * 60 * 1000;
const commandCache = new Map();
// Built-ins that do nothing useful from the glasses (or need a terminal).
const HIDDEN_COMMANDS = new Set(['clear', 'color', 'config', 'focus', 'heapdump', 'doctor', 'reload-plugins', 'output-style', 'workflow-launch-exec', 'fast']);

// init: claude's init event. Lists the commands that work in a reply, and
// which of them are skills (the rest are built-in or custom commands).
function rememberCommands(cwd, init) {
  const names = (list) => (Array.isArray(list) ? list.filter((c) => typeof c === 'string') : []);
  const terminal = new Set(names(init.terminal_slash_commands));
  const list = names(init.slash_commands).filter((c) => !terminal.has(c) && !HIDDEN_COMMANDS.has(c) && !c.startsWith('_'));
  const skills = new Set(names(init.skills));
  commandCache.set(cwd, { at: Date.now(), list, skills: list.filter((c) => skills.has(c)) });
}

function probeCommands(cwd) {
  return new Promise((resolve) => {
    // No MCP servers at all: the probe only needs the command list.
    const child = spawn(config.claudePath, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--max-turns', '1', '--strict-mcp-config'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.on('error', () => {});
    child.stdin.end('List nothing.');
    let buffer = '';
    let finished = false;
    const finish = (init) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (init) rememberCommands(cwd, init);
      resolve(commandCache.get(cwd) || { list: [], skills: [] });
    };
    const timer = setTimeout(() => finish(null), 20000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'system' && msg.subtype === 'init') return finish(msg);
        } catch (e) {}
      }
    });
    child.on('close', () => finish(null));
    child.on('error', () => finish(null));
  });
}

async function commandsFor(cwd) {
  const cached = commandCache.get(cwd);
  if (cached && Date.now() - cached.at < COMMANDS_TTL_MS) return cached;
  return probeCommands(cwd);
}

async function worktreeCwd(project) {
  const sessions = await listSessions(project).catch(() => {
    throw Object.assign(new Error('No such worktree'), { status: 404 });
  });
  const cwd = sessions.find((s) => s.cwd)?.cwd;
  if (!cwd || !fs.existsSync(cwd)) throw Object.assign(new Error('Its worktree folder no longer exists'), { status: 409 });
  return cwd;
}

// ---------------------------------------------------------------- HTTP

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(config.token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function requireId(value, name) {
  const re = name === 'session' ? SESSION_RE : PROJECT_RE;
  if (typeof value !== 'string' || !re.test(value)) {
    throw Object.assign(new Error(`Bad ${name}`), { status: 400 });
  }
  return value;
}

async function sessionSummary(projectDir, sessionId) {
  const file = path.join(PROJECTS, projectDir, sessionId + '.jsonl');
  try {
    return await summarize(file);
  } catch (e) {
    throw Object.assign(new Error('No such session'), { status: 404 });
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://bridge');
  const parts = url.pathname.split('/').filter(Boolean);
  if (!authorized(req)) return send(res, 401, { error: 'Bad token' });

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/worktrees') {
    return send(res, 200, { worktrees: await listWorktrees() });
  }
  // GET /api/worktrees/:project/sessions
  if (req.method === 'GET' && parts[1] === 'worktrees' && parts[3] === 'sessions' && parts.length === 4) {
    const project = requireId(parts[2], 'worktree');
    const sessions = (await listSessions(project).catch(() => {
      throw Object.assign(new Error('No such worktree'), { status: 404 });
    })).map((s) => ({ ...s, replyMode: replyMode(s.mode), active: isActive(s), running: runBySession.has(s.id) }));
    return send(res, 200, { sessions });
  }
  // GET /api/sessions/:project/:session?before=&limit=
  if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 4) {
    const project = requireId(parts[2], 'worktree');
    const session = requireId(parts[3], 'session');
    const summary = await sessionSummary(project, session);
    const beforeRaw = Number(url.searchParams.get('before'));
    const before = url.searchParams.has('before') && Number.isFinite(beforeRaw) ? beforeRaw : null;
    const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_ITEMS, Number(url.searchParams.get('limit')) || 30));
    const transcript = await readTranscript(project, session, before, limit);
    return send(res, 200, {
      ...transcript,
      title: summary.title,
      replyMode: replyMode(summary.mode),
      active: isActive(summary),
      run: runBySession.get(session) || null,
      // Events of that run already written to the transcript come from the
      // file; the app polls the run from here so they don't show twice.
      runNext: runs.get(runBySession.get(session))?.events.length || 0,
    });
  }
  // POST /api/reply { project, session, text }
  if (req.method === 'POST' && url.pathname === '/api/reply') {
    const body = await readBody(req);
    const project = requireId(body.project, 'worktree');
    const session = requireId(body.session, 'session');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, { error: 'Empty reply' });
    const summary = await sessionSummary(project, session);
    if (runBySession.has(session)) return send(res, 409, { error: 'A reply is already running in this session' });
    if (activeRuns() >= MAX_RUNS) return send(res, 429, { error: `${MAX_RUNS} replies are already running. Try again when one finishes.` });
    if (isActive(summary)) return send(res, 409, { error: 'This session is open and busy on the Mac. Try again in a minute.' });
    if (!summary.cwd || !fs.existsSync(summary.cwd)) return send(res, 409, { error: 'Its worktree folder no longer exists' });
    const run = startRun({ cwd: summary.cwd, sessionId: summary.id, mode: replyMode(summary.mode) }, text);
    return send(res, 200, { run: run.id, mode: run.mode });
  }
  // POST /api/new { project, text }: a new session in that worktree
  if (req.method === 'POST' && url.pathname === '/api/new') {
    const body = await readBody(req);
    const project = requireId(body.project, 'worktree');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, { error: 'Empty message' });
    if (activeRuns() >= MAX_RUNS) return send(res, 429, { error: `${MAX_RUNS} replies are already running. Try again when one finishes.` });
    const cwd = await worktreeCwd(project);
    const run = startRun({ cwd, sessionId: null, mode: replyMode(null) }, text);
    return send(res, 200, { run: run.id, mode: run.mode });
  }
  // GET /api/commands?project=: slash commands that work in a reply in that
  // worktree; `skills` names the ones that are skills.
  if (req.method === 'GET' && url.pathname === '/api/commands') {
    const project = requireId(url.searchParams.get('project'), 'worktree');
    const cwd = await worktreeCwd(project);
    const { list, skills } = await commandsFor(cwd);
    return send(res, 200, { commands: list, skills });
  }
  // POST /api/runs/:id/stop
  if (req.method === 'POST' && parts[1] === 'runs' && parts[3] === 'stop' && parts.length === 4) {
    const run = runs.get(parts[2]);
    if (!run) return send(res, 404, { error: 'No such run' });
    if (!run.done) run.stop();
    return send(res, 200, { ok: true });
  }
  // GET /api/runs/:id?after=n
  if (req.method === 'GET' && parts[1] === 'runs' && parts.length === 3) {
    const run = runs.get(parts[2]);
    if (!run) return send(res, 404, { error: 'No such run' });
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    return send(res, 200, { events: run.events.slice(after), next: run.events.length, done: run.done, error: run.error, sessionId: run.sessionId });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.status) log('error', req.method, req.url, e.stack || e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
  });
});

server.listen(config.port, '127.0.0.1', () => {
  log(`Claude bridge on http://127.0.0.1:${config.port} (fallback mode: ${config.fallbackPermissionMode})`);
});

#!/usr/bin/env bun
import { readdir, readFile, appendFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ANSWER_SLOT_COUNT, optionIndexForSlot, pageAction, pageCount, pendingAsk, sdkMessages, usesPagedLayout } from "./sdk-ask-state.js";
import { nextSelectedSessionId } from "./focus-state.js";
import { contextEntriesForActions, contextEntriesForControls } from "./render-lanes.js";
import { moveNavigation, recentPaths, selectedNavigationPath } from "./path-navigation.js";
import { moveOption, selectedOption } from "./option-selector.js";
import { focusedStatusAction } from "./focused-status.js";
import { DOUBLE_TAP_MS, isDoubleTap, pressGesture, supportsDoubleTap } from "./key-gestures.js";

const PLUGIN_UUID = "dev.gajae.streamdeck";
const SESSION_ACTION = `${PLUGIN_UUID}.session`;
const REFRESH_ACTION = `${PLUGIN_UUID}.refresh`;
const STEER_ACTION = `${PLUGIN_UUID}.steer`;
const FOLLOW_ACTION = `${PLUGIN_UUID}.follow`;
const ABORT_ACTION = `${PLUGIN_UUID}.abort`;
const CMUX_NAV_ACTION = `${PLUGIN_UUID}.cmux-nav`;
const SKILL_ACTION = `${PLUGIN_UUID}.skill`;
const LAUNCH_ACTION = `${PLUGIN_UUID}.launch-preset`;
const STATUS_ACTION = `${PLUGIN_UUID}.focused-status`;
const CONTROL_ACTION = `${PLUGIN_UUID}.control`;
const ROOTS = [join(homedir(), "Documents", "Workspace"), join(homedir(), "tmp")];
const MODEL_OPTIONS = [
  { id: "frontier-heavy", label: "FRONTIER\nHEAVY", image: "control-set-frontier" },
  { id: "frontier-default", label: "FRONTIER\nDEFAULT", image: "control-set-frontier" },
  { id: "gpt-heavy", label: "GPT HEAVY", image: "control-set-gpt" },
  { id: "gpt-default", label: "GPT DEFAULT", image: "control-set-gpt" },
  { id: "kimi-gpt", label: "KIMI + GPT", image: "control-set-kimi-gpt" },
  { id: "kimi-deepseek-glm", label: "KIMI + DS\n/ GLM", image: "control-set-kimi-gpt" },
  { id: "glm-deepseek", label: "GLM +\nDEEPSEEK", image: "control-set-glm" },
  { id: "deepseek-glm", label: "DEEPSEEK\n+ GLM", image: "control-set-glm" },
  { id: "lunamaxxing-local", label: "LUNAMAXXING", image: "control-set-gpt" },
  { id: "open-weights-spark-deepseek", label: "SPARK +\nDEEPSEEK", image: "control-set-glm" },
  { id: "open-weights-spark-luna", label: "SPARK + LUNA", image: "control-set-frontier" },
];
const SKILL_OPTIONS = [
  { id: "deep-interview", label: "DEEP\nINTERVIEW", image: "skill-deep-interview" },
  { id: "ralplan", label: "RALPLAN", image: "skill-ralplan" },
  { id: "ultragoal", label: "ULTRAGOAL", image: "skill-ultragoal" },
  { id: "team", label: "TEAM", image: "skill-team" },
];
const THEME_OPTIONS = ["red-claw", "blue-crab", "claude-code", "codex", "gruvbox-dark", "opencode"];
const PROMPT_OPTIONS = [
  { id: "continue", label: "CONTINUE", prompt: "continue" },
  { id: "pr-dev", label: "PR TO DEV", prompt: "make a PR targeting dev and make it LGTM" },
  { id: "review-merge", label: "REVIEW &\nMERGE", prompt: "review and make it LGTM and merge" },
  { id: "commit-push-pr", label: "COMMIT PUSH\nPR DEV", prompt: "review the changes, fix any issues, then commit, push, and create or update the PR targeting dev" },
  { id: "rebase-dev", label: "REBASE DEV", prompt: "rebase onto latest origin/dev, resolve conflicts correctly, run focused verification, and update the PR" },
  { id: "run-tests", label: "RUN TESTS", prompt: "run the relevant focused tests and fix any failures without suppressing warnings" },
  { id: "fix-tests", label: "FIX TESTS", prompt: "investigate the failing tests, fix the root cause, and rerun focused verification" },
  { id: "audit-diff", label: "AUDIT DIFF", prompt: "review the current diff for correctness, regressions, architecture issues, and missing tests; fix concrete findings" },
  { id: "cleanup", label: "CLEANUP", prompt: "clean up the current implementation by removing obsolete code and unnecessary complexity, then verify behavior" },
  { id: "update-docs", label: "UPDATE DOCS", prompt: "update the directly affected documentation and runtime guidance to match the implemented behavior" },
];
const GJC = process.env.GJC_STREAMDECK_GJC || join(homedir(), ".local", "bin", "gjc");
const WORKTREE_LAUNCHER = process.env.GJC_STREAMDECK_WORKTREE || join(import.meta.dir, "bin", "worktree-session");
const KEYBINDINGS_PATH = process.env.GJC_AGENT_DIR ? join(process.env.GJC_AGENT_DIR, "keybindings.json") : join(homedir(), ".gjc", "agent", "keybindings.json");
const CMUX = process.env.GJC_STREAMDECK_CMUX || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const LOG = process.env.GJC_STREAMDECK_LOG || join(homedir(), "Library", "Logs", "GajaeStreamDeck.log");
const IMAGES = join(import.meta.dir, "images");

const argv = Object.fromEntries(Array.from({ length: process.argv.length - 2 }, (_, i) => process.argv[i + 2]).reduce((pairs, value, i, all) => {
  if (value.startsWith("-") && all[i + 1] !== undefined) pairs.push([value.slice(1), all[i + 1]]);
  return pairs;
}, []));
const port = Number(argv.port);
const pluginUUID = argv.pluginUUID;
const registerEvent = argv.registerEvent;
if (!port || !pluginUUID || !registerEvent) process.exit(64);

const contexts = new Map();
const keyDownAt = new Map();
const pendingTaps = new Map();
let sessions = [];
let selectedSessionId = null;
const sdkClients = new Map();
let topologyState = { windows: [], workspaces: [], panes: [], allSurfaces: [], surfaces: [], selectedTty: null };
let sessionRefreshInFlight = null;
let projectRefreshInFlight = null;
let focusRefreshInFlight = null;
let socket;
const imageCache = new Map();
let frequentProjects = [];
let navigationPaths = [];
let navigationIndex = 0;
let modelOptionIndex = 0;
let skillOptionIndex = 0;
let themeOptionIndex = 0;
let promptOptionIndex = 0;
const thinkingLevelBySession = new Map();

function log(message) {
  appendFile(LOG, `${new Date().toISOString()} ${message}\n`).catch(() => {});
}

async function run(command, args = [], cwd = homedir(), timeoutMs = 5000) {
  const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

function send(event, context, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
}
function title(context, value) { send("setTitle", context, { title: value, target: 0 }); }
function alert(context) { send("showAlert", context, {}); }
function ok(context) { send("showOk", context, {}); }
async function imageData(name) {
  if (!imageCache.has(name)) {
    const bytes = await Bun.file(join(IMAGES, `${name}.png`)).arrayBuffer();
    imageCache.set(name, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return imageCache.get(name);
}
async function image(context, name) { send("setImage", context, { image: await imageData(name), target: 0 }); }

async function optionSetImageData(group, option) {
  const cacheKey = `option-set:${group}:${option?.id ?? "none"}`;
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  const base = await imageData(`selector-${group}-set`);
  const selected = option ? await imageData(option.image) : base;
  const accent = group === "skill" ? "#b36cff" : "#42d8ff";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><image href="${base}" width="144" height="144"/><rect x="82" y="8" width="54" height="54" rx="12" fill="#02070bcc" stroke="${accent}" stroke-width="3"/><image href="${selected}" x="86" y="12" width="46" height="46" preserveAspectRatio="xMidYMid slice"/><circle cx="127" cy="52" r="8" fill="#06110b" stroke="#39f59f" stroke-width="2"/><path d="M123 52l3 3 5-7" fill="none" stroke="#39f59f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  imageCache.set(cacheKey, data);
  return data;
}

async function optionSetImage(context, group, option) {
  send("setImage", context, { image: await optionSetImageData(group, option), target: 0 });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function endpointDirsForProject(project) {
  const dirs = [join(project, ".gjc", "state", "sdk")];
  try {
    for (const item of await readdir(join(project, ".worktrees"), { withFileTypes: true }))
      if (item.isDirectory()) dirs.push(join(project, ".worktrees", item.name, ".gjc", "state", "sdk"));
  } catch {}
  return dirs;
}

async function activeGjcProjectDirs() {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,command="], homedir());
  const pids = stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(.+)$/)).filter(match => match && /(?:^|\/)gjc(?:\s|$)/.test(match[2])).map(match => Number(match[1]));
  const dirs = await Promise.all(pids.map(async pid => {
    const cwd = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], homedir());
    return cwd.stdout.split("\n").find(line => line.startsWith("n"))?.slice(1);
  }));
  return [...new Set(dirs.filter(Boolean))];
}

async function discoverEndpoints() {
  const endpointDirs = new Set();
  for (const root of ROOTS) {
    for (const dir of await endpointDirsForProject(root)) endpointDirs.add(dir);
    let projects = [];
    try { projects = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const project of projects) {
      if (!project.isDirectory() || project.name.startsWith(".")) continue;
      for (const dir of await endpointDirsForProject(join(root, project.name))) endpointDirs.add(dir);
    }
  }
  for (const project of await activeGjcProjectDirs()) endpointDirs.add(join(project, ".gjc", "state", "sdk"));
  const endpoints = new Map();
  for (const dir of endpointDirs) {
    let files = [];
    try { files = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !/^[0-9a-f-]+\.json$/i.test(file.name)) continue;
      try {
        const endpoint = JSON.parse(await readFile(join(dir, file.name), "utf8"));
        if (!endpoint.stale && Number.isInteger(endpoint.pid) && alive(endpoint.pid)) endpoints.set(endpoint.sessionId, { ...endpoint, repo: dirname(dirname(dirname(dir))), endpointPath: join(dir, file.name) });
      } catch {}
    }
  }
  return [...endpoints.values()];
}

function canonicalProjectPath(value) {
  return String(value || "").replace(/\.gajae-code-worktrees\/[^/]+$/, "");
}

async function discoverFrequentProjects() {
  const result = await run(GJC, ["sdk", "session", "list"], homedir(), 10000);
  let listed = [];
  if (result.exitCode !== 0) log(`frequent project list failed exit=${result.exitCode} ${result.stderr}`);
  else {
    try {
      const payload = JSON.parse(result.stdout);
      listed = payload?.result?.sessions ?? payload?.sessions ?? [];
    } catch (error) { log(`frequent project list parse failed ${error}`); }
  }
  try {
    const counts = new Map();
    for (const session of listed) {
      const projectPath = canonicalProjectPath(session?.locator?.repo);
      if (!projectPath || !projectPath.startsWith(`${homedir()}/`)) continue;
      const git = await stat(join(projectPath, ".git")).catch(() => null);
      if (!git) continue;
      counts.set(projectPath, (counts.get(projectPath) ?? 0) + 1);
    }
    for (const [projectPath, sessionCount] of await savedSessionProjectCounts()) {
      if (!projectPath.startsWith(`${homedir()}/`)) continue;
      const git = await stat(join(projectPath, ".git")).catch(() => null);
      if (git) counts.set(projectPath, Math.max(counts.get(projectPath) ?? 0, sessionCount));
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([path, sessionCount]) => ({ path, label: basename(path), sessionCount }));
  } catch (error) {
    log(`frequent project discovery failed ${error}`);
    return [];
  }
}

async function savedSessionRecords() {
  const root = join(process.env.GJC_AGENT_DIR || join(homedir(), ".gjc", "agent"), "sessions");
  const records = [];
  let buckets = [];
  try { buckets = await readdir(root, { withFileTypes: true }); } catch { return records; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    let files = [];
    try { files = await readdir(join(root, bucket.name), { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      try {
        const filePath = join(root, bucket.name, file.name);
        const firstLine = (await readFile(filePath, "utf8")).split("\n", 1)[0];
        const record = JSON.parse(firstLine);
        const projectPath = String(record.cwd ?? record.path ?? record.repo ?? "");
        const workspaceRoot = join(homedir(), "Documents", "Workspace");
        if (projectPath === workspaceRoot || projectPath.startsWith(`${workspaceRoot}/`)) records.push({ path: projectPath, updatedAt: Number((await stat(filePath)).mtimeMs) });
      } catch {}
    }
  }
  return records;
}

async function savedSessionProjectCounts() {
  const counts = new Map();
  for (const record of await savedSessionRecords()) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
  return counts;
}

function connectSdkEndpoint(endpoint) {
  const existing = sdkClients.get(endpoint.sessionId);
  if (existing?.endpointPath === endpoint.endpointPath && existing.ws.readyState <= WebSocket.OPEN) return;
  existing?.ws.close();
  const separator = endpoint.url.includes("?") ? "&" : "?";
  const ws = new WebSocket(`${endpoint.url}${separator}token=${encodeURIComponent(endpoint.token)}`);
  const replayId = `streamdeck-replay-${crypto.randomUUID()}`;
  const client = { ws, token: endpoint.token, endpointPath: endpoint.endpointPath, pending: null, replayId };
  sdkClients.set(endpoint.sessionId, client);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ask_controls_v1"] }));
    ws.send(JSON.stringify({ type: "event_replay", id: replayId, sinceSeq: 0, capabilities: ["ask_controls_v1"] }));
  });
  ws.addEventListener("message", event => {
    try {
      const envelope = JSON.parse(String(event.data));
      const messages = sdkMessages(envelope, replayId);
      let changed = false;
      let thinkingChanged = false;
      for (const message of messages) {
        const pending = pendingAsk(message);
        if (pending) {
          client.pending = pending;
          changed = true;
          log(`sdk ask session=${endpoint.sessionId} options=${client.pending.options.length} pages=${pageCount(client.pending)} id=${message.id}`);
        } else if (message.type === "action_resolved" && client.pending?.id === message.id) {
          client.pending = null;
          changed = true;
        } else if (message.type === "reply_rejected" && client.pending?.id === message.id) {
          log(`ask reply rejected ${message.reason || "unknown"}`);
        } else if (message.type === "thinking_level_changed" || message.type === "thinking_level_change") {
          thinkingLevelBySession.set(endpoint.sessionId, String(message.thinkingLevel ?? message.level ?? "off"));
          thinkingChanged = true;
        }
      }
      if (changed) renderAskControls().catch(error => log(`ask render error ${error}`));
      if (thinkingChanged) renderThinkingControls().catch(error => log(`thinking render error ${error}`));
    } catch (error) { log(`sdk message error ${error}`); }
  });
  ws.addEventListener("close", () => {
    if (sdkClients.get(endpoint.sessionId) === client) {
      client.pending = null;
      renderAskControls().catch(() => {});
    }
  });
  ws.addEventListener("error", () => log(`sdk websocket error session=${endpoint.sessionId}`));
}

function syncSdkEndpoints(endpoints) {
  const live = new Set(endpoints.map(endpoint => endpoint.sessionId));
  for (const endpoint of endpoints) connectSdkEndpoint(endpoint);
  for (const [sessionId, client] of sdkClients) {
    if (live.has(sessionId)) continue;
    client.ws.close();
    sdkClients.delete(sessionId);
  }
}

function focusedPendingAsk() {
  const session = sessions.find(row => sessionKey(row) === selectedSessionId);
  const pending = session?.sessionId ? sdkClients.get(session.sessionId)?.pending : null;
  if (!pending || pending.options.length === 0) return null;
  if (pending.multi) {
    const navigation = pending.controls.find(control => control.id === "navigation_forward");
    return navigation ? pending : null;
  }
  return pending;
}

async function answerFocusedAsk(index, context) {
  const session = sessions.find(row => sessionKey(row) === selectedSessionId);
  const client = session?.sessionId ? sdkClients.get(session.sessionId) : null;
  const pending = client?.pending;
  if (!client || !pending || client.ws.readyState !== WebSocket.OPEN) { alert(context); return; }
  let answer;
  let suffix;
  const page = pageAction(pending, context?.heldMs ?? 0);
  if (index === ANSWER_SLOT_COUNT - 1 && page?.kind === "page") {
    pending.page = page.page;
    log(`sdk ask page session=${session.sessionId} id=${pending.id} page=${pending.page + 1}/${pageCount(pending)}`);
    await renderAskControls();
    ok(context);
    return;
  }
  if (index === ANSWER_SLOT_COUNT - 1 && page?.kind === "control") {
    answer = { controlId: page.control.id };
    suffix = `control-${page.control.id}`;
  } else {
    const optionIndex = optionIndexForSlot(pending, index);
    if (optionIndex === null) { alert(context); return; }
    answer = optionIndex;
    suffix = String(optionIndex);
  }
  client.ws.send(JSON.stringify({ type: "reply", id: pending.id, answer, token: client.token, idempotencyKey: `streamdeck-${pending.id}-${suffix}` }));
  ok(context);
}

async function processTtys() {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,tty="], homedir());
  const result = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (match) result.set(Number(match[1]), match[2]);
  }
  return result;
}

async function cmuxTopology() {
  const [treeResult, identifyResult] = await Promise.all([
    run(CMUX, ["tree", "--all"], homedir()),
    run(CMUX, ["identify", "--no-caller"], homedir()),
  ]);
  const { stdout, exitCode } = treeResult;
  if (exitCode !== 0) return { byTty: new Map(), windows: [], workspaces: [], panes: [], allSurfaces: [], surfaces: [], selectedTty: null };
  const byTty = new Map();
  const windows = [];
  const workspaces = [];
  const panes = [];
  const allSurfaces = [];
  const surfaces = [];
  let windowRef = null;
  let workspaceRef = null;
  let paneRef = null;
  let currentWindow = null;
  let currentWorkspace = null;
  let currentPane = null;
  let currentSurface = null;
  let selectedTty = null;
  for (const line of stdout.split("\n")) {
    const window = line.match(/window (window:\d+)/);
    if (window) {
      windowRef = window[1];
      windows.push({ window: windowRef, order: windows.length });
      if (line.includes("[current]") || line.includes("◀ active")) currentWindow = windowRef;
    }
    const workspace = line.match(/workspace (workspace:\d+) "([^"]*)"/);
    if (workspace) {
      workspaceRef = workspace[1];
      workspaces.push({ workspace: workspaceRef, title: workspace[2], window: windowRef, order: workspaces.length });
      if (line.includes("[selected]") && line.includes("◀ active")) currentWorkspace = workspaceRef;
    }
    const pane = line.match(/pane (pane:\d+)/);
    if (pane) {
      paneRef = pane[1];
      panes.push({ pane: paneRef, workspace: workspaceRef, window: windowRef, order: panes.length });
      if (line.includes("[focused]") || line.includes("◀ active")) currentPane = paneRef;
    }
    const surface = line.match(/surface (surface:\d+) \[([^\]]+)\] "([^"]*)"(.*)$/);
    if (surface) {
      const tty = surface[4].match(/tty=(\S+)/)?.[1];
      const row = { surface: surface[1], type: surface[2], title: surface[3].replace(/^GJC:\s*/, ""), rawTitle: surface[3], tty, pane: paneRef, workspace: workspaceRef, window: windowRef, order: allSurfaces.length };
      allSurfaces.push(row);
      if (tty) byTty.set(tty, row);
      if (tty && row.type === "terminal" && /^GJC:\s*/i.test(row.rawTitle)) surfaces.push(row);
      if (line.includes("◀ here")) { currentSurface = row.surface; selectedTty = tty ?? selectedTty; }
      else if (!currentSurface && line.includes("[selected]") && line.includes("◀ active")) { currentSurface = row.surface; selectedTty = tty ?? selectedTty; }
    }
  }
  try {
    const focused = JSON.parse(identifyResult.stdout)?.focused;
    if (focused) {
      currentWindow = focused.window_ref ?? currentWindow;
      currentWorkspace = focused.workspace_ref ?? currentWorkspace;
      currentPane = focused.pane_ref ?? currentPane;
      currentSurface = focused.surface_ref ?? currentSurface;
      selectedTty = allSurfaces.find(row => row.surface === currentSurface)?.tty ?? selectedTty;
    }
  } catch {}
  currentWindow ??= windows[0]?.window ?? null;
  currentWorkspace ??= workspaces.find(row => row.window === currentWindow)?.workspace ?? null;
  currentPane ??= panes.find(row => row.workspace === currentWorkspace)?.pane ?? null;
  currentSurface ??= allSurfaces.find(row => row.pane === currentPane)?.surface ?? null;
  return { byTty, windows, workspaces, panes, allSurfaces, surfaces, currentWindow, currentWorkspace, currentPane, currentSurface, selectedTty };
}

async function sessionThinkingLevel(session) {
  if (!session?.sessionId) return "n/a";
  const cached = thinkingLevelBySession.get(session.sessionId);
  if (cached) return cached;
  const root = join(process.env.GJC_AGENT_DIR || join(homedir(), ".gjc", "agent"), "sessions");
  let buckets = [];
  try { buckets = await readdir(root, { withFileTypes: true }); } catch { return "inherit"; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    let files = [];
    try { files = await readdir(join(root, bucket.name), { withFileTypes: true }); } catch { continue; }
    const file = files.find(item => item.isFile() && item.name.endsWith(`_${session.sessionId}.jsonl`));
    if (!file) continue;
    try {
      let level = "inherit";
      for (const line of (await readFile(join(root, bucket.name, file.name), "utf8")).split("\n")) {
        if (!line) continue;
        const record = JSON.parse(line);
        if (record.type === "thinking_level_change") level = String(record.thinkingLevel ?? "off");
        else if (record.type === "model_change" && record.thinkingLevel !== undefined) level = String(record.thinkingLevel ?? "off");
      }
      thinkingLevelBySession.set(session.sessionId, level);
      return level;
    } catch { return "inherit"; }
  }
  return "inherit";
}

async function sdkMetadata(session) {
  const result = await run(GJC, ["daemon", "session", "query", session.sessionId, "--query=session.metadata"], session.repo, 8000);
  if (result.exitCode !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout);
    return payload?.page?.items?.[0] ?? null;
  } catch { return null; }
}

function sessionKey(session) {
  return session?.sessionId ?? (session?.surface ? `cmux:${session.surface.surface}` : `tty:${session?.tty ?? session?.pid ?? "unknown"}`);
}

async function refreshFocus() {
  if (focusRefreshInFlight) return focusRefreshInFlight;
  focusRefreshInFlight = (async () => {
    const topology = await cmuxTopology();
    topologyState = topology;
    const next = nextSelectedSessionId(sessions, topology.selectedTty, selectedSessionId, sessionKey);
    if (next === selectedSessionId) return;
    selectedSessionId = next;
    await renderFocusState();
    log(`focus refresh selected=${selectedSessionId ?? "none"} focusedTty=${topology.selectedTty ?? "none"}`);
  })().finally(() => { focusRefreshInFlight = null; });
  return focusRefreshInFlight;
}
async function refreshSessions() {
  if (sessionRefreshInFlight) return sessionRefreshInFlight;
  sessionRefreshInFlight = (async () => {
    const [endpoints, ttys] = await Promise.all([discoverEndpoints(), processTtys()]);
    const topology = await cmuxTopology();
    syncSdkEndpoints(endpoints);
    topologyState = topology;
    const endpointRows = endpoints.map(endpoint => ({ ...endpoint, tty: ttys.get(endpoint.pid) }));
    const endpointByTty = new Map(endpointRows.filter(row => row.tty).map(row => [row.tty, row]));
    const matchedSessionIds = new Set();
    const rows = topology.surfaces.map(surface => {
      const endpoint = endpointByTty.get(surface.tty);
      if (endpoint?.sessionId) matchedSessionIds.add(endpoint.sessionId);
      return { ...(endpoint ?? {}), tty: surface.tty, surface, name: surface.title, updatedAt: Number(endpoint?.updatedAt ?? endpoint?.startedAt ?? 0) };
    });
    rows.push(...endpointRows.filter(endpoint => !matchedSessionIds.has(endpoint.sessionId)).map(endpoint => ({
      ...endpoint,
      surface: undefined,
      name: basename(endpoint.repo),
      updatedAt: Number(endpoint.updatedAt ?? endpoint.startedAt ?? 0),
    })));
    const missing = rows.filter(row => row.sessionId && !row.surface).slice(0, 4);
    await Promise.all(missing.map(async row => {
      const metadata = await sdkMetadata(row);
      if (metadata?.name) row.name = metadata.name;
      if (metadata?.cwd) row.repo = metadata.cwd;
    }));
    rows.sort((a, b) => {
      const aOrder = a.surface?.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.surface?.order ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || b.updatedAt - a.updatedAt;
    });
    const focusedRow = rows.find(row => row.tty === topology.selectedTty);
    sessions = focusedRow ? [focusedRow, ...rows.filter(row => row !== focusedRow)].slice(0, 11) : rows.slice(0, 11);
    selectedSessionId = nextSelectedSessionId(sessions, topology.selectedTty, selectedSessionId, sessionKey);
    await renderSessionState();
    log(`session refresh sessions=${sessions.length} selected=${selectedSessionId ?? "none"} focusedTty=${topology.selectedTty ?? "none"} focusedEndpoint=${endpointByTty.get(topology.selectedTty)?.sessionId ?? "none"} endpoints=${endpoints.length}`);
  })().finally(() => { sessionRefreshInFlight = null; });
  return sessionRefreshInFlight;
}

async function refreshProjects() {
  if (projectRefreshInFlight) return projectRefreshInFlight;
  projectRefreshInFlight = (async () => {
    const [projects, records] = await Promise.all([discoverFrequentProjects(), savedSessionRecords()]);
    frequentProjects = projects;
    const currentPath = selectedNavigationPath(navigationPaths, navigationIndex);
    navigationPaths = recentPaths(records);
    navigationIndex = currentPath ? navigationPaths.indexOf(currentPath) : 0;
    if (navigationIndex < 0) navigationIndex = 0;
    await Promise.all([renderProjectControls(), renderNavigationControls()]);
    log(`project refresh projects=${frequentProjects.map(project => `${project.label}:${project.sessionCount}`).join(",") || "none"} navigation=${navigationPaths.length}`);
  })().finally(() => { projectRefreshInFlight = null; });
  return projectRefreshInFlight;
}

async function refresh() {
  await Promise.all([refreshSessions(), refreshProjects()]);
}

function sessionTitle(session) {
  const mode = session.surface ? (session.sessionId ? "SDK+CMUX" : "CMUX") : "SDK";
  const name = String(session.name || "GJC").replace(/^GJC:\s*/i, "").replace(/\s+/g, " ").trim();
  return `${mode}\n${name.slice(0, 14)}`;
}

function navigationPath() {
  return selectedNavigationPath(navigationPaths, navigationIndex) ?? join(homedir(), "Documents", "Workspace");
}

function navigationLabel(path = navigationPath()) {
  const root = join(homedir(), "Documents", "Workspace");
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path === root ? "." : path.replace(`${homedir()}/`, "~/");
  const worktree = relative.match(/^(.+)\.gajae-code-worktrees\/([^/]+)(?:\/.*)?$/);
  return worktree ? `${worktree[1]}\n${worktree[2]}` : wrapKeyText(relative, 12, 3);
}

function navigationPathAt(offset) {
  if (navigationPaths.length === 0) return navigationPath();
  return selectedNavigationPath(navigationPaths, navigationIndex + offset) ?? navigationPath();
}

function wrapKeyText(value, maxUnits = 12, maxLines = 3) {
  const text = String(value || "GJC").replace(/^GJC:\s*/i, "").replace(/\s+/g, " ").trim();
  const lines = [];
  let line = "";
  let units = 0;
  for (const character of text) {
    const characterUnits = character.codePointAt(0) > 255 ? 2 : 1;
    if (line && units + characterUnits > maxUnits) {
      lines.push(line.trim());
      line = "";
      units = 0;
      if (lines.length === maxLines) break;
    }
    line += character;
    units += characterUnits;
  }
  if (line.trim() && lines.length < maxLines) lines.push(line.trim());
  return lines.join("\n");
}

async function renderContext(context, state) {
  const { action, settings = {} } = state;
  if (action === SESSION_ACTION) {
    const slot = Number(settings.slot ?? 0);
    const session = sessions[slot];
    if (!session) {
      title(context, "NO\nSESSION");
      await image(context, `empty-${slot}`);
      return;
    }
    title(context, sessionTitle(session));
    const selected = sessionKey(session) === selectedSessionId;
    const imageMode = selected ? "selected" : session.surface && session.sessionId ? "live" : "remote";
    await image(context, `${imageMode}-${slot}`);
    return;
  }
  if (action === CMUX_NAV_ACTION) {
    title(context, "");
    await image(context, `cmux-${settings.op}`);
    return;
  }
  if (action === STATUS_ACTION) {
    const focused = focusedGjcSurface(topologyState);
    title(context, focused ? `GJC FOCUS\n${wrapKeyText(focused.title)}` : "LAUNCH GJC\nIN THIS TAB");
    await image(context, focused ? "focused-text" : "control-launch-gjc");
    return;
  }
  if (action === LAUNCH_ACTION) {
    title(context, "");
    await image(context, `preset-${settings.preset}`);
    return;
  }
  if (action === SKILL_ACTION) {
    const focused = focusedGjcSurface(topologyState);
    title(context, focused ? `GJC READY\n${String(settings.skill || "SKILL").toUpperCase()}` : "NOT GJC FOCUS");
    await image(context, `skill-${settings.skill}`);
    return;
  }
  if (action === CONTROL_ACTION) {
    if (settings.answerSlot !== undefined) {
      const pending = focusedPendingAsk();
      const index = Number(settings.answerSlot);
      if (pending) {
        if (usesPagedLayout(pending) && index === ANSWER_SLOT_COUNT - 1) {
          const action = pageAction(pending);
          const pages = pageCount(pending);
          if (action?.kind === "page") {
            title(context, `MORE OPTIONS\n${pending.page + 1}/${pages}`);
            await image(context, "answer-control");
          } else if (action?.kind === "control") {
            const selectedCount = pending.selectedOptionIndices.length;
            title(context, `${String(action.control.label || "DONE").toUpperCase()}\n${selectedCount} SELECTED`);
            await image(context, "answer-control");
          } else {
            title(context, pages > 1 ? `BACK TO START\n${pending.page + 1}/${pages}` : "SELECT\nOPTION");
            await image(context, "answer-control-disabled");
          }
          return;
        }
        const optionIndex = optionIndexForSlot(pending, index);
        const option = optionIndex === null ? undefined : pending.options[optionIndex];
        if (pending.multi) {
          const selected = optionIndex !== null && pending.selectedOptionIndices.includes(optionIndex);
          title(context, option ? `${selected ? "☑" : "☐"} OPTION ${optionIndex + 1}\n${wrapKeyText(option, 11, 2)}` : `NO OPTION\n${index + 1}`);
          await image(context, option ? `answer-${index}${selected ? "-selected" : pending.recommendedIndex === optionIndex ? "-recommended" : ""}` : `answer-${index}`);
          return;
        }
        title(context, option ? `ANSWER ${optionIndex + 1}\n${wrapKeyText(option, 11, 2)}` : `NO OPTION\n${index + 1}`);
        await image(context, `answer-${index}${pending.recommendedIndex === optionIndex ? "-recommended" : ""}`);
        return;
      }
    }
    if (settings.type === "frequentProject") {
      const slot = Number(settings.slot ?? 0);
      const project = slot === 2 ? { path: homedir(), label: "HOME", sessionCount: null } : frequentProjects[slot];
      title(context, project ? (project.sessionCount === null ? "HOME" : `${wrapKeyText(project.label, 12, 2)}\n${project.sessionCount} SESSIONS`) : "NO GJC\nPROJECT");
      await image(context, `control-repo-${slot}`);
      return;
    }
    if (settings.type === "fixedFolder") {
      title(context, settings.label || basename(settings.path || homedir()));
      await image(context, `control-${settings.name}`);
      return;
    }
    if (settings.type === "sshTab") {
      title(context, String(settings.label || "SSH"));
      await image(context, settings.image || "ssh-vq-batch");
      return;
    }
    if (settings.type === "pathNavigation") {
      const delta = Number(settings.delta) < 0 ? -1 : 1;
      title(context, `${delta < 0 ? "PREV" : "NEXT"}\n${navigationLabel(navigationPathAt(delta))}`);
      await image(context, delta < 0 ? "directory-prev" : "directory-next");
      return;
    }
    if (settings.type === "newPathTab") {
      title(context, `NEW TAB\n${navigationLabel()}`);
      await image(context, "directory-new-tab");
      return;
    }
    if (settings.type === "optionSelector" || settings.type === "optionSet") {
      const options = settings.group === "skill" ? SKILL_OPTIONS : MODEL_OPTIONS;
      const index = settings.group === "skill" ? skillOptionIndex : modelOptionIndex;
      const option = selectedOption(options, index);
      const verb = settings.type === "optionSet" ? (settings.group === "skill" ? "RUN" : "SET") : (settings.group === "skill" ? "SKILL" : "MODEL");
      title(context, option ? `${verb} ${settings.type === "optionSelector" ? `${index + 1}/${options.length}\n${option.label}` : `\n${option.label}`}` : "NO OPTION");
      if (settings.type === "optionSet") await optionSetImage(context, settings.group, option);
      else await image(context, `selector-${settings.group}-nav`);
      return;
    }
    if (settings.type === "thinkingCycle") {
      const session = sessions.find(row => sessionKey(row) === selectedSessionId);
      const level = await sessionThinkingLevel(session);
      title(context, `THINK LEVEL\n${String(level).toUpperCase()}`);
      await image(context, "control-thinking-level");
      return;
    }
    if (settings.type === "themeCycle") {
      const theme = THEME_OPTIONS[themeOptionIndex];
      title(context, `THEME ${themeOptionIndex + 1}/${THEME_OPTIONS.length}\n${wrapKeyText(theme, 11, 2)}`);
      await image(context, "control-theme");
      return;
    }
    if (settings.type === "duplicateTab") {
      title(context, "DUPLICATE\nTHIS TAB");
      await image(context, "control-duplicate-tab");
      return;
    }
    if (settings.type === "promptSelector" || settings.type === "promptSubmit") {
      const option = selectedOption(PROMPT_OPTIONS, promptOptionIndex);
      const verb = settings.type === "promptSelector" ? `PROMPT ${promptOptionIndex + 1}/${PROMPT_OPTIONS.length}` : "SUBMIT";
      title(context, option ? `${verb}\n${option.label}` : "NO PROMPT");
      await image(context, settings.type === "promptSelector" ? "selector-prompt-nav" : "selector-prompt-set");
      return;
    }
    title(context, "");
    await image(context, `control-${settings.name}`);
    return;
  }
  const focused = focusedGjcSurface(topologyState);
  if (action === REFRESH_ACTION) { title(context, `${sessions.length} LIVE\nREFRESH`); await image(context, "refresh"); }
  if (action === STEER_ACTION) { title(context, focused ? "GJC FOCUSED\nESC + ENTER" : "NOT GJC FOCUS"); await image(context, "steer"); }
  if (action === FOLLOW_ACTION) { title(context, focused ? "GJC FOCUSED\nFOLLOW" : "NOT GJC FOCUS"); await image(context, "follow"); }
  if (action === ABORT_ACTION) { title(context, ""); await image(context, "abort-esc2"); }
}

async function renderEntries(entries) {
  await Promise.all(entries.map(([context, state]) => renderContext(context, state)));
}

async function renderAll() {
  await renderEntries([...contexts]);
}

async function renderFocusState() {
  await Promise.all([
    renderEntries(contextEntriesForActions(contexts, new Set([SESSION_ACTION, STATUS_ACTION, SKILL_ACTION]))),
    renderAskControls(),
  ]);
}

async function renderSessionState() {
  await Promise.all([renderFocusState(), renderThinkingControls()]);
}

async function renderProjectControls() {
  await renderEntries(contextEntriesForControls(contexts, settings => settings.type === "frequentProject"));
}

async function renderNavigationControls() {
  await renderEntries(contextEntriesForControls(contexts, settings => settings.type === "pathNavigation" || settings.type === "newPathTab"));
}

async function renderOptionControls(group) {
  await renderEntries(contextEntriesForControls(contexts, settings => (settings.type === "optionSelector" || settings.type === "optionSet") && settings.group === group));
}

async function renderThinkingControls() {
  await renderEntries(contextEntriesForControls(contexts, settings => settings.type === "thinkingCycle"));
}

async function renderPromptControls() {
  await renderEntries(contextEntriesForControls(contexts, settings => settings.type === "promptSelector" || settings.type === "promptSubmit"));
}

async function renderAskControls() {
  await renderEntries(contextEntriesForControls(contexts, settings => settings.answerSlot !== undefined));
}

function focusedGjcSurface(topology) {
  const focused = (topology.allSurfaces ?? []).find(row => row.surface === topology.currentSurface);
  return focused && /^GJC:\s*/i.test(focused.rawTitle) ? focused : null;
}

function relativeItem(items, current, field, delta) {
  if (!items.length) return null;
  const index = Math.max(0, items.findIndex(item => item[field] === current));
  return items[(index + delta + items.length) % items.length];
}

async function performCmuxNav(op, context) {
  const topology = await cmuxTopology();
  let target;
  let args;
  if (op === "prevPane" || op === "nextPane") {
    const items = topology.panes.filter(row => row.workspace === topology.currentWorkspace);
    target = relativeItem(items, topology.currentPane, "pane", op === "prevPane" ? -1 : 1);
    if (target) args = ["focus-pane", "--pane", target.pane, "--workspace", target.workspace, "--window", target.window];
  } else if (op === "prevTab" || op === "nextTab") {
    const items = topology.allSurfaces.filter(row => row.pane === topology.currentPane);
    target = relativeItem(items, topology.currentSurface, "surface", op === "prevTab" ? -1 : 1);
    if (target) args = ["focus-panel", "--panel", target.surface, "--workspace", target.workspace, "--window", target.window];
  }
  if (!args) { alert(context); return; }
  const result = await run(CMUX, args, homedir());
  if (result.exitCode !== 0) { alert(context); log(`cmux ${op} failed ${result.stderr}`); return; }
  await run("/usr/bin/open", ["-a", "cmux"], homedir());
  await refresh();
  ok(context);
}

async function focusedGjcTarget(context) {
  const topology = await cmuxTopology();
  const surface = focusedGjcSurface(topology);
  if (!surface) { alert(context); log("focused cmux surface is not GJC"); return null; }
  return surface;
}

async function sendFocusedGjcText(text, context, submit = true) {
  const surface = await focusedGjcTarget(context);
  if (!surface) return;
  const target = ["--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window];
  const sent = await run(CMUX, ["send", ...target, text], homedir());
  if (sent.exitCode !== 0) { alert(context); log(`cmux send failed ${sent.stderr}`); return; }
  if (!submit) { ok(context); return; }
  const submitted = await run(CMUX, ["send-key", ...target, "enter"], homedir());
  if (submitted.exitCode === 0) ok(context); else { alert(context); log(`cmux enter failed ${submitted.stderr}`); }
}

async function sendFocusedGjcSequence(steps, context) {
  const surface = await focusedGjcTarget(context);
  if (!surface) return false;
  const target = ["--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window];
  for (const step of steps) {
    const sent = await run(CMUX, ["send", ...target, step.text], homedir());
    if (sent.exitCode !== 0) { alert(context); log(`cmux sequence send failed ${sent.stderr}`); return false; }
    if (step.submit !== false) {
      const submitted = await run(CMUX, ["send-key", ...target, "enter"], homedir());
      if (submitted.exitCode !== 0) { alert(context); log(`cmux sequence enter failed ${submitted.stderr}`); return false; }
    }
    if (step.waitMs) await Bun.sleep(step.waitMs);
  }
  ok(context);
  return true;
}

async function sendFocusedGjcKey(key, context) {
  const surface = await focusedGjcTarget(context);
  if (!surface) return false;
  const result = await run(CMUX, ["send-key", "--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window, key], homedir());
  if (result.exitCode !== 0) { alert(context); log(`cmux key ${key} failed ${result.stderr}`); return false; }
  return true;
}

async function sendFocusedGjcShortcut(shortcut, context) {
  const surface = await focusedGjcTarget(context);
  if (!surface) return false;
  const normalized = String(shortcut).toLowerCase();
  let text;
  if (normalized === "shift+tab") {
    const result = await run(CMUX, ["send-key", "--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window, "shift+tab"], homedir());
    if (result.exitCode !== 0) { alert(context); log(`shortcut ${shortcut} failed ${result.stderr}`); return false; }
    return true;
  } else {
    const parts = normalized.split("+");
    const key = parts.pop();
    if (!key || key.length !== 1) { alert(context); log(`unsupported shortcut ${shortcut}`); return false; }
    if (parts.includes("ctrl") || parts.includes("control")) text = String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31);
    else if (parts.includes("alt") || parts.includes("option")) text = `\x1b${parts.includes("shift") ? key.toUpperCase() : key}`;
    else { alert(context); log(`unsupported shortcut ${shortcut}`); return false; }
  }
  const result = await run(CMUX, ["rpc", "surface.send_text", JSON.stringify({ surface: surface.surface, text })], homedir());
  if (result.exitCode !== 0) { alert(context); log(`shortcut ${shortcut} failed ${result.stderr}`); return false; }
  return true;
}

async function toggleFocusedGjcVoice(context) {
  const surface = await focusedGjcTarget(context);
  if (!surface) return;
  const session = sessions.find(row => row.tty === topologyState?.selectedTty);
  const changedAt = await stat(KEYBINDINGS_PATH).then(value => value.mtimeMs).catch(() => Number.POSITIVE_INFINITY);
  if (!session?.startedAt || Number(session.startedAt) < changedAt) {
    alert(context);
    log(`voice ctrl+h requires a session started after the keybinding remap`);
    return;
  }
  const result = await run(CMUX, ["send-key", "--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window, "ctrl+h"], homedir());
  if (result.exitCode === 0) ok(context); else { alert(context); log(`voice ctrl+h failed ${result.stderr || result.stdout}`); }
}

async function launchProgram(program, args, context, label) {
  const topology = await cmuxTopology();
  const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
  if (!surface || surface.type !== "terminal") { alert(context); log(`${label} requires a focused terminal tab`); return; }
  if (/^GJC:\s*/i.test(surface.rawTitle)) {
    const session = sessions.find(row => row.tty === topology.selectedTty);
    await createTerminalTab(session?.repo || homedir(), [program, ...args].join(" "), context, label);
    return;
  }
  const target = ["--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window];
  const command = `exec ${[program, ...args].join(" ")}`;
  const sent = await run(CMUX, ["send", ...target, command], homedir());
  const submitted = sent.exitCode === 0 ? await run(CMUX, ["send-key", ...target, "enter"], homedir()) : sent;
  if (submitted.exitCode === 0) { await run("/usr/bin/open", ["-a", "cmux"], homedir()); ok(context); }
  else { alert(context); log(`${label} launch failed ${submitted.stderr || submitted.stdout}`); }
}

async function launchPreset(preset, context) {
  if (!new Set(["frontier-heavy", "gpt-heavy", "glm-deepseek"]).has(preset)) { alert(context); return; }
  await launchProgram(WORKTREE_LAUNCHER, [preset], context, `worktree preset ${preset}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function createTerminalTab(cwd, command, context, label) {
  const topology = await cmuxTopology();
  const created = await run(CMUX, ["new-surface", "--type", "terminal", "--pane", topology.currentPane, "--workspace", topology.currentWorkspace, "--window", topology.currentWindow, "--focus", "true"], homedir());
  const surface = created.stdout.match(/surface:\d+/)?.[0];
  if (created.exitCode !== 0 || !surface) { alert(context); log(`${label || "terminal"} tab failed ${created.stderr || created.stdout}`); return; }
  await Bun.sleep(150);
  const target = ["--surface", surface, "--workspace", topology.currentWorkspace, "--window", topology.currentWindow];
  const prefix = cwd ? `cd -- ${shellQuote(cwd)} && ` : "";
  const shellCommand = command ? `${prefix}exec ${command}` : cwd ? `cd -- ${shellQuote(cwd)}` : null;
  if (shellCommand) {
    const sent = await run(CMUX, ["send", ...target, shellCommand], homedir());
    const submitted = sent.exitCode === 0 ? await run(CMUX, ["send-key", ...target, "enter"], homedir()) : sent;
    if (submitted.exitCode !== 0) { alert(context); log(`${label || "terminal"} tab command failed ${submitted.stderr || submitted.stdout}`); return; }
  }
  if (label) await run(CMUX, ["rename-tab", ...target, label], homedir());
  await run("/usr/bin/open", ["-a", "cmux"], homedir());
  ok(context);
}

async function openFixedFolder(settings, context) {
  const path = settings.path === "~" ? homedir() : settings.path;
  if (!path) { alert(context); return; }
  await createTerminalTab(path, null, context, null);
}

async function openSshTab(settings, context) {
  const port = Number(settings.port);
  const host = String(settings.host || "");
  const user = String(settings.user || "");
  const label = String(settings.label || host).replaceAll("\n", " ");
  const remoteCwd = String(settings.cwd || "");
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) { alert(context); return; }
  const destination = shellQuote(`${user}@${host}`);
  const remoteCommand = remoteCwd ? ` -t ${destination} ${shellQuote(`cd -- ${remoteCwd} && exec $SHELL -l`)}` : ` ${destination}`;
  await createTerminalTab(homedir(), `ssh -p ${port}${remoteCommand}`, context, label);
}

async function openFrequentProject(settings, context) {
  const slot = Number(settings.slot ?? 0);
  const project = slot === 2 ? { path: homedir() } : frequentProjects[slot];
  if (!project) { alert(context); return; }
  await createTerminalTab(project.path, null, context, null);
}

async function openNewPathTab(context) {
  await createTerminalTab(navigationPath(), null, context, null);
}

async function openNewPathGjcTab(context) {
  await createTerminalTab(navigationPath(), shellQuote(GJC), context, "GJC");
}

async function movePathNavigation(delta, context) {
  const moved = moveNavigation(navigationPaths, navigationIndex, delta);
  navigationIndex = moved.index;
  await renderNavigationControls();
  ok(context);
}

async function moveOptionSelector(group, delta, context) {
  const options = group === "skill" ? SKILL_OPTIONS : MODEL_OPTIONS;
  const index = group === "skill" ? skillOptionIndex : modelOptionIndex;
  const moved = moveOption(options, index, delta);
  if (group === "skill") skillOptionIndex = moved.index; else modelOptionIndex = moved.index;
  await renderOptionControls(group);
  ok(context);
}

async function applySelectedOption(group, context) {
  const options = group === "skill" ? SKILL_OPTIONS : MODEL_OPTIONS;
  const index = group === "skill" ? skillOptionIndex : modelOptionIndex;
  const option = selectedOption(options, index);
  if (!option) { alert(context); return; }
  if (group === "skill") await sendFocusedGjcText(`/skill:${option.id}`, context, false);
  else await sendFocusedGjcText(`/model gajae-code/${option.id}`, context, true);
}

async function movePromptSelector(delta, context) {
  const moved = moveOption(PROMPT_OPTIONS, promptOptionIndex, delta);
  promptOptionIndex = moved.index;
  await renderPromptControls();
  ok(context);
}

async function submitSelectedPrompt(context) {
  const option = selectedOption(PROMPT_OPTIONS, promptOptionIndex);
  if (!option) { alert(context); return; }
  await sendFocusedGjcText(option.prompt, context, true);
}

async function cycleTheme(context, delta = 1) {
  const moved = moveOption(THEME_OPTIONS, themeOptionIndex, delta);
  themeOptionIndex = moved.index;
  await sendFocusedGjcText(`/theme ${moved.option}`, context, true);
  await renderEntries(contextEntriesForControls(contexts, settings => settings.type === "themeCycle"));
}

async function duplicateFocusedTab(context) {
  const topology = await cmuxTopology();
  const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
  if (!surface || surface.type !== "terminal" || !surface.tty) { alert(context); return; }
  const tty = surface.tty.replace(/^\/dev\//, "");
  const result = await run("/bin/ps", ["-t", tty, "-o", "pid=,ppid=,command="], homedir());
  const shell = result.stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).sort((left, right) => Number(left[2]) - Number(right[2]))[0];
  const pid = shell ? Number(shell[1]) : null;
  const cwd = pid ? (await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], homedir())).stdout.split("\n").find(line => line.startsWith("n"))?.slice(1) : null;
  await createTerminalTab(cwd || homedir(), null, context, null);
}

async function duplicateFocusedGjcTab(context) {
  const topology = await cmuxTopology();
  const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
  if (!surface || surface.type !== "terminal" || !surface.tty) { alert(context); return; }
  const tty = surface.tty.replace(/^\/dev\//, "");
  const result = await run("/bin/ps", ["-t", tty, "-o", "pid=,ppid=,command="], homedir());
  const shell = result.stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).sort((left, right) => Number(left[2]) - Number(right[2]))[0];
  const pid = shell ? Number(shell[1]) : null;
  const cwd = pid ? (await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], homedir())).stdout.split("\n").find(line => line.startsWith("n"))?.slice(1) : null;
  await createTerminalTab(cwd || homedir(), shellQuote(GJC), context, "GJC");
}


async function launchGjcInFocusedTab(context, topology = null) {
  topology ??= await cmuxTopology();
  const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
  if (!surface || surface.type !== "terminal") { alert(context); log(`gjc launch unavailable surface=${topology.currentSurface ?? "none"}`); return; }
  const target = ["--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window];
  const sent = await run(CMUX, ["send", ...target, shellQuote(GJC)], homedir());
  if (sent.exitCode !== 0) { alert(context); log(`gjc launch send failed surface=${surface.surface} ${sent.stderr || sent.stdout}`); return; }
  const submitted = await run(CMUX, ["send-key", ...target, "enter"], homedir());
  if (submitted.exitCode === 0) {
    log(`gjc launch submitted surface=${surface.surface} tty=${surface.tty ?? "none"}`);
    ok(context);
  } else { alert(context); log(`gjc launch enter failed surface=${surface.surface} ${submitted.stderr || submitted.stdout}`); }
}

async function closeFocusedCmuxTab(context) {
  const topology = await cmuxTopology();
  const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
  if (!surface) { alert(context); return; }
  const result = await run(CMUX, ["close-surface", "--surface", surface.surface, "--workspace", surface.workspace, "--window", surface.window], homedir());
  if (result.exitCode === 0) { await run("/usr/bin/open", ["-a", "cmux"], homedir()); ok(context); }
  else { alert(context); log(`close tab failed ${result.stderr || result.stdout}`); }
}

async function focusSession(session, context) {
  selectedSessionId = sessionKey(session);
  if (session.surface) {
    const args = ["focus-panel", "--panel", session.surface.surface];
    if (session.surface.workspace) args.push("--workspace", session.surface.workspace);
    if (session.surface.window) args.push("--window", session.surface.window);
    const focused = await run(CMUX, args, homedir());
    if (focused.exitCode === 0) await run("/usr/bin/open", ["-a", "cmux"], homedir());
    else { alert(context); log(`cmux focus failed ${focused.stderr}`); }
  } else {
    await run("/usr/bin/open", ["-a", "Ghostty"], homedir());
  }
  await renderAll();
}

async function clipboardText() {
  const { stdout } = await run("/usr/bin/pbpaste", [], homedir());
  return stdout.trim();
}

async function sdkControl(operation, input, context, confirm = false) {
  const session = sessions.find(row => sessionKey(row) === selectedSessionId);
  if (!session?.sessionId) { alert(context); log(`sdk ${operation} unavailable for ${selectedSessionId ?? "no selection"}`); return; }
  const args = ["daemon", "session", "control", session.sessionId, `--op=${operation}`, `--json-input=${JSON.stringify(input)}`];
  if (confirm) args.push("--confirm");
  const result = await run(GJC, args, session.repo, 12000);
  if (result.exitCode === 0) ok(context);
  else { alert(context); log(`sdk ${operation} failed: ${result.stderr || result.stdout}`); }
}

async function dispatchKeyGesture(context, state, heldMs, releasedAt = Date.now()) {
  const gesture = pressGesture(heldMs);
  if (gesture === "hold" || !supportsDoubleTap(state.settings)) {
    const pending = pendingTaps.get(context);
    if (pending) { clearTimeout(pending.timer); pendingTaps.delete(context); }
    await keyUp(context, state, heldMs, gesture);
    return;
  }
  const pending = pendingTaps.get(context);
  if (pending && isDoubleTap(pending.releasedAt, releasedAt)) {
    clearTimeout(pending.timer);
    pendingTaps.delete(context);
    await keyUp(context, state, heldMs, "double");
    return;
  }
  const timer = setTimeout(() => {
    pendingTaps.delete(context);
    keyUp(context, state, heldMs, "tap").catch(error => log(`gesture tap error ${error}`));
  }, DOUBLE_TAP_MS);
  pendingTaps.set(context, { releasedAt, timer });
}

async function keyUp(context, state, heldMs, gesture = pressGesture(heldMs)) {
  const { action, settings = {} } = state;
  if (action === SESSION_ACTION) {
    const session = sessions[Number(settings.slot ?? 0)];
    if (session) await focusSession(session, context); else alert(context);
    return;
  }
  if (action === CMUX_NAV_ACTION) { await performCmuxNav(settings.op, context); return; }
  if (action === STATUS_ACTION) {
    const topology = await cmuxTopology();
    topologyState = topology;
    const surface = topology.allSurfaces.find(row => row.surface === topology.currentSurface);
    const statusAction = focusedStatusAction(surface);
    if (statusAction === "proceed") await sendFocusedGjcText("proceed", context, true);
    else if (statusAction === "launch") await launchGjcInFocusedTab(context, topology);
    else alert(context);
    return;
  }
  if (action === LAUNCH_ACTION) { await launchPreset(settings.preset, context); return; }
  if (action === SKILL_ACTION) { await sendFocusedGjcText(`/skill:${settings.skill}`, context, false); return; }
  if (action === CONTROL_ACTION) {
    if (settings.answerSlot !== undefined && focusedPendingAsk()) { await answerFocusedAsk(Number(settings.answerSlot), { ...context, heldMs }); return; }
    if (settings.type === "cmuxClose") { await closeFocusedCmuxTab(context); return; }
    if (settings.type === "sshTab") { await openSshTab(settings, context); return; }
    if (settings.type === "fixedFolder") { await openFixedFolder(settings, context); return; }
    if (settings.type === "frequentProject") { await openFrequentProject(settings, context); return; }
    if (settings.type === "newPathTab") { if (gesture === "hold") await openNewPathGjcTab(context); else await openNewPathTab(context); return; }
    if (settings.type === "pathNavigation") { await movePathNavigation(gesture === "hold" ? -(Number(settings.delta) || 1) : Number(settings.delta) || 1, context); return; }
    if (settings.type === "optionSelector") { await moveOptionSelector(settings.group, gesture === "hold" ? -(Number(settings.delta) || 1) : Number(settings.delta) || 1, context); return; }
    if (settings.type === "optionSet") {
      if (gesture === "hold" && settings.group === "skill") {
        const option = selectedOption(SKILL_OPTIONS, skillOptionIndex);
        if (option) await sendFocusedGjcText(`/skill:${option.id}`, context, true); else alert(context);
      } else await applySelectedOption(settings.group, context);
      return;
    }
    if (settings.type === "themeCycle") {
      if (gesture === "double") {
        themeOptionIndex = 0;
        await sendFocusedGjcText(`/theme ${THEME_OPTIONS[0]}`, context, true);
        await renderEntries(contextEntriesForControls(contexts, candidate => candidate.type === "themeCycle"));
      } else await cycleTheme(context, gesture === "hold" ? -1 : 1);
      return;
    }
    if (settings.type === "thinkingCycle") {
      const session = sessions.find(row => sessionKey(row) === selectedSessionId);
      if (await sendFocusedGjcShortcut("shift+tab", context)) {
        if (session?.sessionId) thinkingLevelBySession.delete(session.sessionId);
        await Bun.sleep(250);
        await renderThinkingControls();
        ok(context);
      }
      return;
    }
    if (settings.type === "duplicateTab") { if (gesture === "hold") await duplicateFocusedGjcTab(context); else await duplicateFocusedTab(context); return; }
    if (settings.type === "promptSelector") { await movePromptSelector(gesture === "hold" ? -(Number(settings.delta) || 1) : Number(settings.delta) || 1, context); return; }
    if (settings.type === "promptSubmit") {
      const option = selectedOption(PROMPT_OPTIONS, promptOptionIndex);
      if (!option) { alert(context); return; }
      if (gesture === "hold") await sendFocusedGjcText(option.prompt, context, false);
      else if (gesture === "double") await sendFocusedGjcSequence([{ text: "/clear", waitMs: 250 }, { text: option.prompt }], context);
      else await submitSelectedPrompt(context);
      return;
    }
    if (settings.type === "command") {
      if (settings.name === "clear" && gesture === "hold") await sendFocusedGjcText("summarize the current state, decisions, remaining work, and verification evidence concisely", context, true);
      else if (settings.name === "clear" && gesture === "double") await sendFocusedGjcText("/new", context, true);
      else await sendFocusedGjcText(settings.value, context, settings.submit !== false);
      return;
    }
    if (settings.type === "worktree") { await launchProgram(WORKTREE_LAUNCHER, [], context, "worktree"); return; }
    if (settings.type === "launch" && Array.isArray(settings.value)) { await launchProgram(GJC, settings.value, context, settings.name || "GJC"); return; }
    if (settings.type === "key") { if (await sendFocusedGjcShortcut(settings.value, context)) ok(context); return; }
    alert(context);
    return;
  }
  if (action === REFRESH_ACTION) { await refresh(); ok(context); return; }
  if (action === STEER_ACTION) {
    if (!await sendFocusedGjcKey("escape", context)) return;
    await Bun.sleep(100);
    if (await sendFocusedGjcKey("enter", context)) ok(context);
    return;
  }
  if (action === FOLLOW_ACTION) {
    const text = await clipboardText();
    if (!text) { alert(context); return; }
    await sendFocusedGjcText(text, context);
    return;
  }
  if (action === ABORT_ACTION) {
    if (!await sendFocusedGjcKey("escape", context)) return;
    await Bun.sleep(100);
    if (await sendFocusedGjcKey("escape", context)) ok(context);
  }
}

const focusPeriodic = setInterval(() => refreshFocus().catch(error => log(`focus refresh error ${error}`)), 500);
const sessionPeriodic = setInterval(() => refreshSessions().catch(error => log(`session refresh error ${error}`)), 5000);
const projectPeriodic = setInterval(() => refreshProjects().catch(error => log(`project refresh error ${error}`)), 60000);

socket = new WebSocket(`ws://127.0.0.1:${port}`);
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  Promise.all([refreshSessions(), refreshProjects()]).catch(error => log(`initial refresh error ${error}`));
});
socket.addEventListener("message", async event => {
  try {
    const message = JSON.parse(String(event.data));
    const context = message.context;
    if (message.event === "willAppear") {
      contexts.set(context, { action: message.action, settings: message.payload?.settings ?? {}, coordinates: message.payload?.coordinates });
      await renderContext(context, contexts.get(context));
    } else if (message.event === "willDisappear") {
      contexts.delete(context);
      keyDownAt.delete(context);
      const pending = pendingTaps.get(context);
      if (pending) clearTimeout(pending.timer);
      pendingTaps.delete(context);
    } else if (message.event === "didReceiveSettings") {
      const current = contexts.get(context);
      if (current) { current.settings = message.payload?.settings ?? {}; await renderContext(context, current); }
    } else if (message.event === "keyDown") {
      keyDownAt.set(context, Date.now());
    } else if (message.event === "keyUp") {
      const state = contexts.get(context);
      const releasedAt = Date.now();
      const heldMs = releasedAt - (keyDownAt.get(context) ?? releasedAt);
      keyDownAt.delete(context);
      if (state) await dispatchKeyGesture(context, state, heldMs, releasedAt);
    }
  } catch (error) { log(`message error ${error}`); }
});
socket.addEventListener("close", () => { clearInterval(focusPeriodic); clearInterval(sessionPeriodic); clearInterval(projectPeriodic); process.exit(0); });
socket.addEventListener("error", error => log(`socket error ${error}`));

#!/usr/bin/env bun
import { readdir, readFile, appendFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ANSWER_SLOT_COUNT, optionIndexForSlot, pageAction, pageCount, pendingAsk, sdkMessages, usesPagedLayout } from "./sdk-ask-state.js";
import { nextSelectedSessionId } from "./focus-state.js";

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
let sessions = [];
let selectedSessionId = null;
const sdkClients = new Map();
let topologyState = { windows: [], workspaces: [], panes: [], allSurfaces: [], surfaces: [], selectedTty: null };
let refreshInFlight = null;
let focusRefreshInFlight = null;
let socket;
const imageCache = new Map();
let frequentProjects = [];

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
  return String(value || "").replace(/(?:\.gajae-code-worktrees|\.worktrees)\/[^/]+$/, "");
}

async function discoverFrequentProjects() {
  const result = await run(GJC, ["sdk", "session", "list"], homedir(), 30000);
  if (result.exitCode !== 0) { log(`frequent project list failed exit=${result.exitCode} ${result.stderr}`); return []; }
  try {
    const payload = JSON.parse(result.stdout);
    const listed = payload?.result?.sessions ?? payload?.sessions ?? [];
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

async function savedSessionProjectCounts() {
  const root = join(process.env.GJC_AGENT_DIR || join(homedir(), ".gjc", "agent"), "sessions");
  const counts = new Map();
  let buckets = [];
  try { buckets = await readdir(root, { withFileTypes: true }); } catch { return counts; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    let files = [];
    try { files = await readdir(join(root, bucket.name), { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      try {
        const firstLine = (await readFile(join(root, bucket.name, file.name), "utf8")).split("\n", 1)[0];
        const record = JSON.parse(firstLine);
        const projectPath = canonicalProjectPath(record.cwd ?? record.path ?? record.repo);
        if (projectPath) counts.set(projectPath, (counts.get(projectPath) ?? 0) + 1);
      } catch {}
    }
  }
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
        }
      }
      if (changed) renderAll().catch(error => log(`ask render error ${error}`));
    } catch (error) { log(`sdk message error ${error}`); }
  });
  ws.addEventListener("close", () => {
    if (sdkClients.get(endpoint.sessionId) === client) {
      client.pending = null;
      renderAll().catch(() => {});
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
    await renderAll();
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
    await renderAll();
    log(`focus refresh selected=${selectedSessionId ?? "none"} focusedTty=${topology.selectedTty ?? "none"}`);
  })().finally(() => { focusRefreshInFlight = null; });
  return focusRefreshInFlight;
}
async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const [endpoints, ttys, projects] = await Promise.all([discoverEndpoints(), processTtys(), discoverFrequentProjects()]);
    const topology = await cmuxTopology();
    syncSdkEndpoints(endpoints);
    topologyState = topology;
    frequentProjects = projects;
    const endpointRows = endpoints.map(endpoint => ({ ...endpoint, tty: ttys.get(endpoint.pid) }));
    const endpointByTty = new Map(endpointRows.filter(row => row.tty).map(row => [row.tty, row]));
    const matchedSessionIds = new Set();
    const rows = topology.surfaces.map(surface => {
      const endpoint = endpointByTty.get(surface.tty);
      if (endpoint?.sessionId) matchedSessionIds.add(endpoint.sessionId);
      return {
        ...(endpoint ?? {}),
        tty: surface.tty,
        surface,
        name: surface.title,
        updatedAt: Number(endpoint?.updatedAt ?? endpoint?.startedAt ?? 0),
      };
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
    await renderAll();
    log(`refresh sessions=${sessions.length} contexts=${contexts.size} selected=${selectedSessionId ?? "none"} focusedTty=${topology.selectedTty ?? "none"} focusedEndpoint=${endpointByTty.get(topology.selectedTty)?.sessionId ?? "none"} endpoints=${endpoints.length} projects=${projects.map(project => `${project.label}:${project.sessionCount}`).join(",") || "none"}`);
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function sessionTitle(session) {
  const mode = session.surface ? (session.sessionId ? "SDK+CMUX" : "CMUX") : "SDK";
  const name = String(session.name || "GJC").replace(/^GJC:\s*/i, "").replace(/\s+/g, " ").trim();
  return `${mode}\n${name.slice(0, 14)}`;
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
    title(context, focused ? `GJC FOCUS\n${wrapKeyText(focused.title)}` : "NOT GJC\nFOCUSED\nTAB");
    await image(context, "focused-text");
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

async function renderAll() {
  await Promise.all([...contexts].map(([context, state]) => renderContext(context, state)));
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

async function openFrequentProject(settings, context) {
  const slot = Number(settings.slot ?? 0);
  const project = slot === 2 ? { path: homedir() } : frequentProjects[slot];
  if (!project) { alert(context); return; }
  await createTerminalTab(project.path, null, context, null);
}

async function openNewGjcSession(context) {
  await createTerminalTab(null, shellQuote(WORKTREE_LAUNCHER), context, null);
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

async function keyUp(context, state, heldMs) {
  const { action, settings = {} } = state;
  if (action === SESSION_ACTION) {
    const session = sessions[Number(settings.slot ?? 0)];
    if (session) await focusSession(session, context); else alert(context);
    return;
  }
  if (action === CMUX_NAV_ACTION) { await performCmuxNav(settings.op, context); return; }
  if (action === STATUS_ACTION) { await sendFocusedGjcText("proceed", context, true); return; }
  if (action === LAUNCH_ACTION) { await launchPreset(settings.preset, context); return; }
  if (action === SKILL_ACTION) { await sendFocusedGjcText(`/skill:${settings.skill}`, context, false); return; }
  if (action === CONTROL_ACTION) {
    if (settings.answerSlot !== undefined && focusedPendingAsk()) { await answerFocusedAsk(Number(settings.answerSlot), { ...context, heldMs }); return; }
    if (settings.type === "cmuxClose") { await closeFocusedCmuxTab(context); return; }
    if (settings.type === "fixedFolder") { await openFixedFolder(settings, context); return; }
    if (settings.type === "frequentProject") { await openFrequentProject(settings, context); return; }
    if (settings.type === "newGjcTab") { await openNewGjcSession(context); return; }
    if (settings.type === "voice") { await toggleFocusedGjcVoice(context); return; }
    if (settings.type === "command") { await sendFocusedGjcText(settings.value, context, settings.submit !== false); return; }
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
const periodic = setInterval(() => refresh().catch(error => log(`refresh error ${error}`)), 10000);

socket = new WebSocket(`ws://127.0.0.1:${port}`);
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  refresh().catch(error => log(`initial refresh error ${error}`));
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
    } else if (message.event === "didReceiveSettings") {
      const current = contexts.get(context);
      if (current) { current.settings = message.payload?.settings ?? {}; await renderContext(context, current); }
    } else if (message.event === "keyDown") {
      keyDownAt.set(context, Date.now());
    } else if (message.event === "keyUp") {
      const state = contexts.get(context);
      const heldMs = Date.now() - (keyDownAt.get(context) ?? Date.now());
      keyDownAt.delete(context);
      if (state) await keyUp(context, state, heldMs);
    }
  } catch (error) { log(`message error ${error}`); }
});
socket.addEventListener("close", () => { clearInterval(focusPeriodic); clearInterval(periodic); process.exit(0); });
socket.addEventListener("error", error => log(`socket error ${error}`));

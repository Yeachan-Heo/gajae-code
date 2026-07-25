/**
 * Orca agent-status bridge.
 *
 * The Orca terminal exports a loopback agent-hook endpoint into every pane
 * (`ORCA_AGENT_HOOK_ENDPOINT` / `ORCA_PANE_KEY`). Agents that POST lifecycle
 * events to it get live status (working / done), tool activity, prompt, and
 * last-reply previews in Orca's dashboard and pane badges.
 *
 * Orca supports the pi hook protocol (`/hook/gjc` on versions with
 * first-class GJC support, `/hook/pi` everywhere else), which
 * GJC speaks natively as a pi-lineage agent. This module ports the semantics
 * of Orca's managed `orca-agent-status.ts` pi extension onto GJC's bundled
 * extension surface, so GJC panes inside Orca report status without any
 * filesystem extension discovery (which is quarantined) and without any
 * Orca-side changes.
 *
 * Security contract (fail-closed):
 * - Delivery only ever targets `http://127.0.0.1:<port>/hook/gjc` (or the
 *   `/hook/pi` fallback after a 404 negotiation) where the
 *   port is a strictly numeric TCP port; the constructed URL is re-asserted
 *   component-by-component before any request. Coordinates that fail parsing
 *   drop the post instead of degrading.
 * - The hook token must match a conservative charset before it is placed in
 *   a header or argv, so hostile env/file values cannot inject headers.
 * - The endpoint file is opened `O_NOFOLLOW`, must be a regular file owned by
 *   the current user without group/world write, its directory ancestry must
 *   not be writable by other users, and contents are read through the pinned
 *   file descriptor (no path re-dereference between validation and read).
 * - Outbound previews are bounded (prompt/assistant text and serialized tool
 *   input) and the bridge is gated by the `orca.statusBridge` setting plus a
 *   `GJC_ORCA_STATUS_BRIDGE=0` environment kill-switch.
 *
 * Delivery is strictly best-effort: a missing, restarting, or slow Orca must
 * never surface errors inside the session or delay the agent loop.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "../extensibility/extensions";

/** Preferred route on Orca versions with first-class GJC support. */
const ORCA_GJC_HOOK_PATH = "/hook/gjc";
/** Fallback route accepted by every Orca version with pi support. */
const ORCA_PI_HOOK_PATH = "/hook/pi";
const ORCA_HOOK_PATHS = [ORCA_GJC_HOOK_PATH, ORCA_PI_HOOK_PATH] as const;
export type OrcaHookPath = (typeof ORCA_HOOK_PATHS)[number];
const HOOK_POST_TIMEOUT_MS = 1000;
/** Pane-scoped ownership marker shared with Orca's managed pi extension: child
 * processes inherit the pane env, and only one process per pane may report. */
const OWNERSHIP_ENV = "ORCA_PI_STATUS_OWNED";
/** Startup editor prefill delivered by Orca when launching a pi-protocol agent. */
const PREFILL_ENV = "ORCA_PI_PREFILL";
/** Environment kill-switch honored in addition to the `orca.statusBridge` setting. */
const KILL_SWITCH_ENV = "GJC_ORCA_STATUS_BRIDGE";
const AGENT_END_IDLE_RECHECK_MS = 25;
const AGENT_END_IDLE_RECHECK_MAX_MS = 250;
const WINDOWS_CURL_PATH = "/mnt/c/Windows/System32/curl.exe";
/** Bounds for exported previews; Orca renders previews, not transcripts. */
const MAX_PREVIEW_TEXT_CHARS = 2000;
const MAX_TOOL_INPUT_JSON_CHARS = 4096;
const TRUNCATION_MARKER = "…[truncated by GJC]";
/** Hook tokens are Orca-generated UUID-shaped values; anything outside this
 * charset is treated as hostile (prevents header/argv injection). */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{8,256}$/;
const PORT_PATTERN = /^[0-9]{1,5}$/;

export interface OrcaHookCoords {
	port: string | undefined;
	token: string | undefined;
	env: string;
	version: string;
}

export interface OrcaStatusBridgeOptions {
	/** Environment to read Orca coordinates from. Default: `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Fetch implementation. Default: global `fetch`. */
	fetchImpl?: typeof fetch;
	/** WSL runtime probe override (default: `WSL_DISTRO_NAME` presence). */
	isWslRuntime?: () => boolean;
	/** Spawn seam for the WSL → Windows curl fallback. Resolves when the
	 * spawned delivery finishes (used to bound concurrent children). */
	spawnCurl?: (command: string[], body: string) => Promise<void> | void;
	/** POSIX uid override for endpoint-file ownership checks (test seam). */
	ownerUid?: number;
}

/** Validate a hook port value: strictly decimal, 1–65535. */
export function validateOrcaHookPort(value: string | undefined): string | null {
	if (!value || !PORT_PATTERN.test(value)) return null;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return String(port);
}

/** Validate a hook token for safe use in a header value and argv. */
export function validateOrcaHookToken(value: string | undefined): string | null {
	if (!value || !TOKEN_PATTERN.test(value)) return null;
	return value;
}

/**
 * Build the loopback hook URL and re-assert every component after
 * construction, so no input can smuggle authority, credentials, or an
 * alternate path into the request target.
 */
export function buildOrcaHookUrl(
	portValue: string | undefined,
	hookPath: OrcaHookPath = ORCA_GJC_HOOK_PATH,
): string | null {
	const port = validateOrcaHookPort(portValue);
	if (!port) return null;
	if (!ORCA_HOOK_PATHS.includes(hookPath)) return null;
	let url: URL;
	try {
		url = new URL(`http://127.0.0.1:${port}${hookPath}`);
	} catch {
		return null;
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.port !== port ||
		url.pathname !== hookPath ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		return null;
	}
	return url.href;
}

/**
 * Parse an Orca endpoint file (`KEY=VALUE` POSIX env or `set KEY=VALUE`
 * Windows cmd form; tolerates CRLF line endings).
 */
export function parseOrcaEndpointFile(contents: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/);
		if (match) out[match[1]] = match[2].replace(/\r$/, "");
	}
	return out;
}

/** Bound a preview string; previews feed Orca's dashboard, not transcripts. */
export function boundPreviewText(text: string, maxChars: number = MAX_PREVIEW_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/**
 * Bound a raw tool input for export. Small inputs are forwarded verbatim so
 * Orca can derive tool-aware previews server-side; oversized or
 * unserializable inputs collapse to a bounded preview wrapper.
 */
export function boundToolInput(input: unknown): unknown {
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? "";
	} catch {
		return { gjc_truncated: true, preview: "" };
	}
	if (serialized.length <= MAX_TOOL_INPUT_JSON_CHARS) return input;
	return { gjc_truncated: true, preview: serialized.slice(0, MAX_PREVIEW_TEXT_CHARS) + TRUNCATION_MARKER };
}

/**
 * Gate for registering the bridge on a session.
 *
 * Only the root interactive/print session of the pane-owning process reports:
 * - requires the `orca.statusBridge` setting (explicit consent surface) and
 *   the `GJC_ORCA_STATUS_BRIDGE` kill-switch to allow it;
 * - requires an Orca pane identity in the environment;
 * - helper/subagent sessions (task depth, parent prefix, role agent) stay
 *   silent so in-process fan-out does not thrash the pane status;
 * - a pane already owned by another process (inherited `ORCA_PI_STATUS_OWNED`)
 *   stays with that owner.
 */
export function shouldRegisterOrcaStatusBridge(input: {
	env: NodeJS.ProcessEnv;
	/** Value of the `orca.statusBridge` setting. */
	enabled: boolean;
	taskDepth?: number;
	parentTaskPrefix?: string;
	currentAgentType?: string;
}): boolean {
	if (!input.enabled) return false;
	if (input.env[KILL_SWITCH_ENV] === "0") return false;
	if (!input.env.ORCA_PANE_KEY) return false;
	if ((input.taskDepth ?? 0) > 0 || input.parentTaskPrefix !== undefined || input.currentAgentType !== undefined) {
		return false;
	}
	const owner = input.env[OWNERSHIP_ENV];
	if (owner && owner !== String(process.pid)) return false;
	return true;
}

/** Extract concatenated text parts from an assistant message for the dashboard
 * preview; tool_use / reasoning parts are omitted (Orca renders tool activity
 * from the dedicated tool events). */
export function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") out += text;
		}
	}
	return out;
}

interface PendingPost {
	hookEventName: string;
	extra: Record<string, unknown>;
}

/**
 * Register the Orca status bridge on an extension API surface.
 *
 * Event mapping (GJC extension events → Orca pi-protocol payloads):
 * - `session_start` → `session_start` (also applies `ORCA_PI_PREFILL`)
 * - `before_agent_start` → `before_agent_start` + bounded `prompt`
 * - `agent_start` → `agent_start`
 * - `tool_call` / `tool_execution_start` / `tool_execution_end` → same names
 *   with `tool_name` / bounded `tool_input` (Orca derives previews server-side)
 * - assistant `message_end` → `message_end` + bounded visible `text`
 * - `agent_end` → `agent_end`, deferred until `ctx.isIdle()` so queued
 *   follow-up work keeps the pane in `working` instead of flapping to done.
 */
export function createOrcaStatusBridge(pi: ExtensionAPI, options: OrcaStatusBridgeOptions = {}): void {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	env[OWNERSHIP_ENV] = String(process.pid);

	let sessionMetadata: Record<string, unknown> = {};
	let warnedBadEndpoint = false;
	// Latest-only delivery: a stalled Orca receiver must not queue up obsolete
	// snapshots, and status posting must stay off the agent-loop critical path.
	let activePost = false;
	let pendingPost: PendingPost | null = null;
	// Endpoint-file parse cache keyed by fstat identity of the pinned
	// descriptor; ancestry approval is cached per resolved path.
	let cachedEndpointKey = "";
	let cachedEndpointValues: Record<string, string> | null = null;
	let approvedAncestryPath: string | null = null;
	let cachedIsWsl: boolean | null = null;
	let cachedCurlAvailable: boolean | null = null;
	// Bounded curl lifecycle: at most one Windows-side delivery in flight;
	// bursts drop instead of accumulating child processes.
	let curlInFlight = false;

	function updateSessionMetadata(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		sessionMetadata = sessionId
			? { session_id: sessionId, ...(sessionFile ? { session_file: sessionFile } : {}) }
			: {};
	}

	async function getPersistedSessionMetadata(): Promise<Record<string, unknown>> {
		const sessionFile = sessionMetadata.session_file;
		if (typeof sessionFile !== "string" || !sessionFile) return {};
		try {
			// GJC publishes the planned session path before creating the transcript;
			// recheck on every post so the first completed turn becomes resumable.
			return (await Bun.file(sessionFile).exists()) ? sessionMetadata : {};
		} catch {
			return {};
		}
	}

	function ownerUid(): number | null {
		if (options.ownerUid !== undefined) return options.ownerUid;
		return typeof process.getuid === "function" ? process.getuid() : null;
	}

	/** ssh-style strict ancestry: every parent directory must be owned by the
	 * current user or root and must not be writable by group/other, so another
	 * local user cannot swap the endpoint file or a parent directory. */
	async function validateEndpointAncestry(endpointPath: string): Promise<boolean> {
		const resolved = path.resolve(endpointPath);
		if (approvedAncestryPath === resolved) return true;
		const uid = ownerUid();
		if (uid === null) {
			// Windows: no POSIX ownership; rely on O_NOFOLLOW-equivalent open and
			// the loopback-only URL contract.
			approvedAncestryPath = resolved;
			return true;
		}
		let current = path.dirname(resolved);
		for (;;) {
			const stat = await fs.lstat(current);
			if (!stat.isDirectory()) return false;
			if (stat.uid !== uid && stat.uid !== 0) return false;
			// Writable-by-others directories are only tolerated with the sticky
			// bit (e.g. /tmp), where other users cannot rename or unlink entries.
			if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) return false;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		approvedAncestryPath = resolved;
		return true;
	}

	/**
	 * Read the endpoint file fail-closed: `O_NOFOLLOW` open pins the inode,
	 * ownership/mode are validated on the pinned descriptor, and contents are
	 * read through that descriptor so no path re-dereference can race the
	 * validation. Any failure returns null (env coordinates are NOT replaced
	 * by unvalidated file contents).
	 */
	function rejectEndpoint(endpointPath: string, reason: string): null {
		if (!warnedBadEndpoint) {
			warnedBadEndpoint = true;
			logger.warn("Orca status bridge rejected hook endpoint file", { path: endpointPath, reason });
		}
		return null;
	}

	async function readEndpointFile(): Promise<Record<string, string> | null> {
		const endpointPath = env.ORCA_AGENT_HOOK_ENDPOINT;
		if (!endpointPath) return null;
		let handle: fs.FileHandle | undefined;
		try {
			if (!(await validateEndpointAncestry(endpointPath))) {
				return rejectEndpoint(endpointPath, "untrusted directory ancestry");
			}
			handle = await fs.open(endpointPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			const stat = await handle.stat();
			if (!stat.isFile()) return rejectEndpoint(endpointPath, "not a regular file");
			const uid = ownerUid();
			if (uid !== null) {
				if (stat.uid !== uid) return rejectEndpoint(endpointPath, "not owned by the current user");
				if ((stat.mode & 0o022) !== 0) return rejectEndpoint(endpointPath, "writable by group/other");
			}
			const cacheKey = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
			if (cacheKey === cachedEndpointKey && cachedEndpointValues) return cachedEndpointValues;
			const contents = await handle.readFile("utf8");
			cachedEndpointValues = parseOrcaEndpointFile(contents);
			cachedEndpointKey = cacheKey;
			return cachedEndpointValues;
		} catch (error) {
			cachedEndpointKey = "";
			cachedEndpointValues = null;
			const code = (error as { code?: string } | null)?.code;
			if (code !== "ENOENT" && !warnedBadEndpoint) {
				warnedBadEndpoint = true;
				logger.warn("Orca status bridge rejected hook endpoint file", {
					path: endpointPath,
					error: String(error),
				});
			}
			return null;
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	async function resolveHookCoords(): Promise<OrcaHookCoords> {
		const fileEnv = (await readEndpointFile()) ?? {};
		return {
			port: fileEnv.ORCA_AGENT_HOOK_PORT || env.ORCA_AGENT_HOOK_PORT,
			token: fileEnv.ORCA_AGENT_HOOK_TOKEN || env.ORCA_AGENT_HOOK_TOKEN,
			env: fileEnv.ORCA_AGENT_HOOK_ENV || env.ORCA_AGENT_HOOK_ENV || "",
			version: fileEnv.ORCA_AGENT_HOOK_VERSION || env.ORCA_AGENT_HOOK_VERSION || "",
		};
	}

	function isWslRuntime(): boolean {
		if (options.isWslRuntime) return options.isWslRuntime();
		if (cachedIsWsl !== null) return cachedIsWsl;
		cachedIsWsl = Boolean(env.WSL_DISTRO_NAME);
		return cachedIsWsl;
	}

	// WSL loopback is not the Windows loopback, so a WSL-side POST cannot reach
	// Orca. curl.exe runs on the Windows side, where 127.0.0.1 IS the listener
	// Orca binds. The URL and token are the already-validated values, `-q`
	// disables curlrc config processing, and at most one child is in flight.
	async function postViaWindowsCurl(url: string, token: string, body: string): Promise<void> {
		if (curlInFlight) return;
		const command = [
			WINDOWS_CURL_PATH,
			// Must be first: disables .curlrc processing before other options.
			"-q",
			"-sS",
			// The spawn is detached from the event loop, so these bounds size a
			// background process, not TUI latency; WSL→Win32 connects can be slow.
			"--connect-timeout",
			"3",
			"--max-time",
			"10",
			"--noproxy",
			"127.0.0.1",
			"-o",
			"NUL",
			"-X",
			"POST",
			"-H",
			"Content-Type: application/json",
			"-H",
			`X-Orca-Agent-Hook-Token: ${token}`,
			"--data-binary",
			"@-",
			url,
		];
		if (options.spawnCurl) {
			const spawnCurl = options.spawnCurl;
			curlInFlight = true;
			// Fire-and-forget like the real path: delivery completion only clears
			// the single-flight slot, it never blocks the post queue.
			void Promise.resolve()
				.then(() => spawnCurl(command, body))
				.catch(() => {})
				.finally(() => {
					curlInFlight = false;
				});
			return;
		}
		if (cachedCurlAvailable === null) {
			cachedCurlAvailable = await Bun.file(WINDOWS_CURL_PATH)
				.exists()
				.catch(() => false);
		}
		if (!cachedCurlAvailable) return;
		try {
			curlInFlight = true;
			const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
			child.stdin.write(body);
			await child.stdin.end();
			child.unref();
			// Clear the slot when the bounded (--max-time) child exits; delivery
			// itself stays fire-and-forget.
			void child.exited
				.catch(() => {})
				.finally(() => {
					curlInFlight = false;
				});
		} catch {
			curlInFlight = false;
			// Best-effort bridge; a failed spawn must not surface in the session.
		}
	}

	// Route negotiation: prefer the first-class GJC route; an Orca without it
	// answers 404 once and the bridge permanently falls back to the pi route
	// (which such versions render with pi identity but full status support).
	let activeHookPath: OrcaHookPath = ORCA_GJC_HOOK_PATH;

	async function postOnce(hookEventName: string, extra: Record<string, unknown>): Promise<void> {
		const coords = await resolveHookCoords();
		const paneKey = env.ORCA_PANE_KEY;
		const token = validateOrcaHookToken(coords.token);
		if (!token || !paneKey) return;
		const body = JSON.stringify({
			paneKey,
			launchToken: env.ORCA_AGENT_LAUNCH_TOKEN || "",
			tabId: env.ORCA_TAB_ID || "",
			worktreeId: env.ORCA_WORKTREE_ID || "",
			env: coords.env,
			version: coords.version,
			payload: { hook_event_name: hookEventName, ...(await getPersistedSessionMetadata()), ...extra },
		});
		for (;;) {
			const url = buildOrcaHookUrl(coords.port, activeHookPath);
			if (!url) return;
			try {
				const response = await fetchImpl(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Orca-Agent-Hook-Token": token,
					},
					body,
					signal: AbortSignal.timeout(HOOK_POST_TIMEOUT_MS),
				});
				if (response.status === 404 && activeHookPath === ORCA_GJC_HOOK_PATH) {
					activeHookPath = ORCA_PI_HOOK_PATH;
					continue;
				}
				return;
			} catch {
				// Status reporting must never fail the run because Orca is unavailable
				// or restarting; on WSL fall through to the Windows-side listener.
				if (!isWslRuntime()) return;
				await postViaWindowsCurl(url, token, body);
				return;
			}
		}
	}

	function drainPosts(): void {
		if (activePost || !pendingPost) return;
		const next = pendingPost;
		pendingPost = null;
		activePost = true;
		void postOnce(next.hookEventName, next.extra)
			.catch(() => {})
			.finally(() => {
				activePost = false;
				drainPosts();
			});
	}

	function post(hookEventName: string, extra: Record<string, unknown> = {}): void {
		pendingPost = { hookEventName, extra };
		drainPosts();
	}

	function applyStartupPrefill(ctx: ExtensionContext): void {
		const prefill = env[PREFILL_ENV];
		if (!prefill || !ctx.hasUI) return;
		delete env[PREFILL_ENV];
		try {
			ctx.ui.setEditorText(prefill);
		} catch {
			// Prefill is a convenience; ignore hosts without an editor surface.
		}
	}

	// GJC stays non-idle across retry/compaction/queued follow-up work, so a
	// bare agent_end may not be a turn boundary yet. Defer the done post until
	// the session is actually idle, with a capped exponential recheck.
	let agentEndReported = false;
	let agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS;
	let pendingAgentEndCheck: ReturnType<typeof setTimeout> | null = null;
	let pendingAgentEndContext: Pick<ExtensionContext, "isIdle"> | null = null;

	function clearPendingAgentEndCheck(): void {
		if (pendingAgentEndCheck !== null) clearTimeout(pendingAgentEndCheck);
		pendingAgentEndCheck = null;
		pendingAgentEndContext = null;
	}

	function postAgentEndOnce(): void {
		if (agentEndReported) return;
		agentEndReported = true;
		post("agent_end");
	}

	function checkPendingAgentEnd(): void {
		pendingAgentEndCheck = null;
		const ctx = pendingAgentEndContext;
		if (!ctx || agentEndReported) {
			pendingAgentEndContext = null;
			return;
		}
		try {
			if (ctx.isIdle()) {
				pendingAgentEndContext = null;
				postAgentEndOnce();
				return;
			}
		} catch {
			pendingAgentEndContext = null;
			return;
		}
		pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, agentEndIdleRecheckMs);
		pendingAgentEndCheck.unref?.();
		agentEndIdleRecheckMs = Math.min(agentEndIdleRecheckMs * 2, AGENT_END_IDLE_RECHECK_MAX_MS);
	}

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		updateSessionMetadata(ctx);
		applyStartupPrefill(ctx);
		post("session_start");
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		post("before_agent_start", { prompt: boundPreviewText(event.prompt ?? "") });
	});

	pi.on("agent_start", () => {
		clearPendingAgentEndCheck();
		agentEndReported = false;
		post("agent_start");
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		post("tool_call", { tool_name: event.toolName, tool_input: boundToolInput(event.input) });
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		post("tool_execution_start", { tool_name: event.toolName, tool_input: boundToolInput(event.args) });
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		post("tool_execution_end", { tool_name: event.toolName });
	});

	// Capture the assistant's final text on each completed message so the
	// dashboard preview reflects the latest reply before agent_end fires.
	pi.on("message_end", (event: MessageEndEvent) => {
		const message = event.message as { role?: unknown };
		if (message?.role !== "assistant") return;
		const text = extractAssistantText(event.message);
		if (!text) return;
		post("message_end", { role: "assistant", text: boundPreviewText(text) });
	});

	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
		clearPendingAgentEndCheck();
		agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS;
		pendingAgentEndContext = ctx;
		pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, 0);
		pendingAgentEndCheck.unref?.();
	});
}

/**
 * Orca agent-status bridge.
 *
 * The Orca terminal exports a loopback agent-hook endpoint into every pane
 * (`ORCA_AGENT_HOOK_ENDPOINT` / `ORCA_PANE_KEY`). Agents that POST lifecycle
 * events to it get live status (working / done), tool activity, prompt, and
 * last-reply previews in Orca's dashboard and pane badges.
 *
 * Orca has first-class support for the pi hook protocol (`/hook/pi`), which
 * GJC speaks natively as a pi-lineage agent. This module ports the semantics
 * of Orca's managed `orca-agent-status.ts` pi extension onto GJC's bundled
 * extension surface, so GJC panes inside Orca report status without any
 * filesystem extension discovery (which is quarantined) and without any
 * Orca-side changes.
 *
 * Delivery is strictly best-effort: a missing, restarting, or slow Orca must
 * never surface errors inside the session or delay the agent loop.
 */

import * as fs from "node:fs/promises";
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

const ORCA_HOOK_PATH = "/hook/pi";
const HOOK_POST_TIMEOUT_MS = 1000;
/** Pane-scoped ownership marker shared with Orca's managed pi extension: child
 * processes inherit the pane env, and only one process per pane may report. */
const OWNERSHIP_ENV = "ORCA_PI_STATUS_OWNED";
/** Startup editor prefill delivered by Orca when launching a pi-protocol agent. */
const PREFILL_ENV = "ORCA_PI_PREFILL";
const AGENT_END_IDLE_RECHECK_MS = 25;
const AGENT_END_IDLE_RECHECK_MAX_MS = 250;
const WINDOWS_CURL_PATH = "/mnt/c/Windows/System32/curl.exe";

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
	/** WSL runtime probe override (default: cached `/proc` sniff). */
	isWslRuntime?: () => boolean;
	/** Spawn seam for the WSL → Windows curl fallback. */
	spawnCurl?: (command: string[], body: string) => void;
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

/**
 * Gate for registering the bridge on a session.
 *
 * Only the root interactive/print session of the pane-owning process reports:
 * - requires an Orca pane identity in the environment;
 * - helper/subagent sessions (task depth, parent prefix, role agent) stay
 *   silent so in-process fan-out does not thrash the pane status;
 * - a pane already owned by another process (inherited `ORCA_PI_STATUS_OWNED`)
 *   stays with that owner.
 */
export function shouldRegisterOrcaStatusBridge(input: {
	env: NodeJS.ProcessEnv;
	taskDepth?: number;
	parentTaskPrefix?: string;
	currentAgentType?: string;
}): boolean {
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
 * Event mapping (GJC extension events → Orca `/hook/pi` payloads):
 * - `session_start` → `session_start` (also applies `ORCA_PI_PREFILL`)
 * - `before_agent_start` → `before_agent_start` + `prompt`
 * - `agent_start` → `agent_start`
 * - `tool_call` / `tool_execution_start` / `tool_execution_end` → same names
 *   with `tool_name` / raw `tool_input` (Orca derives the preview server-side)
 * - assistant `message_end` → `message_end` + visible `text`
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
	// Endpoint-file cache keyed by stat identity: re-reading on every event is
	// cheap but re-parsing during streaming tool execution is wasteful.
	let cachedEndpointKey = "";
	let cachedEndpointValues: Record<string, string> | null = null;
	let cachedIsWsl: boolean | null = null;
	let cachedCurlAvailable: boolean | null = null;

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

	async function readEndpointFile(): Promise<Record<string, string> | null> {
		const endpointPath = env.ORCA_AGENT_HOOK_ENDPOINT;
		if (!endpointPath) return null;
		try {
			const stat = await fs.stat(endpointPath);
			const cacheKey = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
			if (cacheKey === cachedEndpointKey && cachedEndpointValues) return cachedEndpointValues;
			const contents = await Bun.file(endpointPath).text();
			cachedEndpointValues = parseOrcaEndpointFile(contents);
			cachedEndpointKey = cacheKey;
			return cachedEndpointValues;
		} catch (error) {
			cachedEndpointKey = "";
			cachedEndpointValues = null;
			const code = (error as { code?: string } | null)?.code;
			if (code !== "ENOENT" && !warnedBadEndpoint) {
				warnedBadEndpoint = true;
				logger.warn("Orca status bridge failed to read hook endpoint file", {
					path: endpointPath,
					error: String(error),
				});
			}
			return null;
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
	// Orca binds. Fire-and-forget: blocking on the spawn would stall the TUI.
	async function postViaWindowsCurl(url: string, token: string, body: string): Promise<void> {
		const command = [
			WINDOWS_CURL_PATH,
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
			options.spawnCurl(command, body);
			return;
		}
		if (cachedCurlAvailable === null) {
			cachedCurlAvailable = await Bun.file(WINDOWS_CURL_PATH)
				.exists()
				.catch(() => false);
		}
		if (!cachedCurlAvailable) return;
		try {
			const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
			child.stdin.write(body);
			await child.stdin.end();
			child.unref();
		} catch {
			// Best-effort bridge; a failed spawn must not surface in the session.
		}
	}

	async function postOnce(hookEventName: string, extra: Record<string, unknown>): Promise<void> {
		const coords = await resolveHookCoords();
		const paneKey = env.ORCA_PANE_KEY;
		if (!coords.port || !coords.token || !paneKey) return;
		const url = `http://127.0.0.1:${coords.port}${ORCA_HOOK_PATH}`;
		const body = JSON.stringify({
			paneKey,
			launchToken: env.ORCA_AGENT_LAUNCH_TOKEN || "",
			tabId: env.ORCA_TAB_ID || "",
			worktreeId: env.ORCA_WORKTREE_ID || "",
			env: coords.env,
			version: coords.version,
			payload: { hook_event_name: hookEventName, ...(await getPersistedSessionMetadata()), ...extra },
		});
		try {
			await fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Orca-Agent-Hook-Token": coords.token,
				},
				body,
				signal: AbortSignal.timeout(HOOK_POST_TIMEOUT_MS),
			});
		} catch {
			// Status reporting must never fail the run because Orca is unavailable
			// or restarting; on WSL fall through to the Windows-side listener.
			if (!isWslRuntime()) return;
			await postViaWindowsCurl(url, coords.token, body);
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
		post("before_agent_start", { prompt: event.prompt ?? "" });
	});

	pi.on("agent_start", () => {
		clearPendingAgentEndCheck();
		agentEndReported = false;
		post("agent_start");
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		post("tool_call", { tool_name: event.toolName, tool_input: event.input });
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		post("tool_execution_start", { tool_name: event.toolName, tool_input: event.args });
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
		post("message_end", { role: "assistant", text });
	});

	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
		clearPendingAgentEndCheck();
		agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS;
		pendingAgentEndContext = ctx;
		pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, 0);
		pendingAgentEndCheck.unref?.();
	});
}

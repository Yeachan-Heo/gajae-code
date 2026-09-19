/**
 * Devin CLI provider — an ACP (Agent Client Protocol) client.
 *
 * Devin CLI exposes no raw model-inference endpoint. Its programmatic surface is
 * `devin acp`: an Agent Client Protocol server over stdio that runs the whole
 * agent (https://docs.devin.ai/cli/reference/commands#devin-acp). GJC therefore
 * speaks ACP as the *client* and treats Devin as an agent-level provider:
 *
 * - GJC spawns `devin acp` and speaks ACP over the child's stdio.
 * - One ACP session is reused for the lifetime of a GJC conversation, keyed by
 *   `providerSessionId` and stored in `providerSessionState`; `close()` kills
 *   the child process at session teardown.
 * - Devin owns conversation history, so only the newest user turn is forwarded.
 * - Devin executes its own tools. `session/update` tool calls are rendered as
 *   display-only `toolCall` blocks and every turn terminates with
 *   `stopReason: "stop"`, so GJC never re-executes a Devin tool call.
 * - `session/request_permission` is answered from an explicit policy, never
 *   silently: see {@link DevinAcpPermissionMode}.
 *
 * Boundary (documented in docs/devin-provider.md): GJC tools, skills, workflows,
 * hooks, and permission prompts for GJC's own tools do not apply inside a Devin
 * turn; GJC maintenance work (compaction, handoff, branch summaries) and utility
 * one-shots are refused rather than forwarded to Devin; and Devin bills its own
 * account/ACU usage.
 */

import {
	type ToolCall as AcpToolCall,
	type Agent,
	type Client,
	ClientSideConnection,
	type ContentBlock,
	type InitializeResponse,
	ndJsonStream,
	type PermissionOption,
	type PromptCapabilities,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionNotification,
	type StopReason,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { VERSION } from "@gajae-code/utils";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	ProviderSessionState,
	StreamOptions,
	ToolCall,
} from "../types";
import { kProviderResolvedToolCall, type ProviderResolvedCarrier } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../utils/idle-iterator";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variable overriding the Devin executable GJC spawns. */
export const DEVIN_ACP_CLI_ENV = "GJC_DEVIN_CLI_PATH";
/** Environment variable selecting how GJC answers Devin permission requests. */
export const DEVIN_ACP_PERMISSION_MODE_ENV = "GJC_DEVIN_PERMISSION_MODE";
/** Executable that serves `devin acp` when nothing overrides it. */
export const DEVIN_ACP_DEFAULT_CLI = "devin";
/**
 * Placeholder base URL. The ACP transport never issues an HTTP request, but a
 * model record must carry a non-empty base URL through the model registry.
 */
export const DEVIN_ACP_BASE_URL = "acp://devin-cli";
/**
 * Conservative catalog defaults. ACP exposes no per-model token metadata, and
 * GJC never sends conversation history to an ACP agent, so these values are
 * display-only for this provider rather than a transport budget.
 */
export const DEVIN_ACP_CONTEXT_WINDOW = 200_000;
export const DEVIN_ACP_MAX_TOKENS = 64_000;

const DEVIN_ACP_CLIENT_NAME = "gajae-code";
/** ACP `auth_required` JSON-RPC error code (`RequestError.authRequired()`). */
const ACP_AUTH_REQUIRED_CODE = -32000;
/** Cap on one tool-call `arguments` payload copied into a transcript message. */
const ACP_TOOL_ARGUMENT_MAX_BYTES = 16 * 1024;
const DEVIN_ACP_STDERR_TAIL_BYTES = 4 * 1024;
/** Bound on waiting for a live ACP session before a cancellation settles anyway. */
const DEVIN_ACP_CANCEL_DELIVERY_GRACE_MS = 250;
/** Bound on waiting for a cancelled agent to acknowledge before a child is reaped. */
const DEVIN_ACP_CANCEL_ACK_GRACE_MS = 500;

// ---------------------------------------------------------------------------
// Public provider surface
// ---------------------------------------------------------------------------

/**
 * How GJC answers Devin's `session/request_permission` prompts.
 *
 * - `"allow"` (default) selects `allow_once`. A request that offers no
 *   `allow_once` is cancelled: GJC never grants a persistent approval on its own.
 * - `"deny"` selects `reject_once` before `reject_always`.
 *
 * Neither mode escalates persistently on its own, and an unrecognized
 * `GJC_DEVIN_PERMISSION_MODE` value fails closed to `"deny"`.
 */
export type DevinAcpPermissionMode = "allow" | "deny";

/** A permission request Devin raised for one of its own tool calls. */
export interface DevinAcpPermissionRequest {
	sessionId: string;
	toolCallId: string;
	title: string;
	kind?: string;
	rawInput?: unknown;
	options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
}

/** Selected option id, or `cancelled` to answer with ACP `outcome: cancelled`. */
export type DevinAcpPermissionDecision = { optionId: string } | { cancelled: true };

/** Explicit decision callback; replaces the built-in permission mode policy. */
export type DevinAcpPermissionHandler = (
	request: DevinAcpPermissionRequest,
) => Promise<DevinAcpPermissionDecision> | DevinAcpPermissionDecision;

/** Provider configuration threaded through `StreamOptions.devinAcp`. */
export interface DevinAcpConfig {
	/** Executable serving `devin acp`. Defaults to {@link DEVIN_ACP_CLI_ENV} or `devin`. */
	cliPath?: string;
	/** Extra argv inserted before the `acp` verb. */
	cliArgs?: readonly string[];
	/** Working directory for the agent process. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Overrides the permission policy for this request. Any value other than
	 * `"allow"` fails closed to `"deny"`, including out-of-type values from
	 * untyped callers.
	 */
	permissionMode?: DevinAcpPermissionMode;
	/** Explicit permission decisions. When absent, the configured mode decides. */
	permissionHandler?: DevinAcpPermissionHandler;
}

/**
 * Devin ACP stream options. Every provider-specific field lives on
 * `StreamOptions.devinAcp`; the alias exists so `ApiOptionsMap` can name this
 * API's option type like every other API does.
 */
export type DevinAcpOptions = StreamOptions;

// ---------------------------------------------------------------------------
// Pure helpers (exported for the provider test suite)
// ---------------------------------------------------------------------------

/** Map an ACP tool kind to the display tool name GJC renders. */
export function devinAcpDisplayToolName(kind: string | null | undefined, name?: string | null): string {
	switch (kind) {
		case "read":
			return "read";
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "search":
			return "grep";
		case "execute":
			return "bash";
		case "think":
			return "think";
		case "fetch":
			return "fetch";
		case "switch_mode":
			return "switch_mode";
		default: {
			const explicit = typeof name === "string" ? name.trim() : "";
			return explicit.length > 0 ? explicit : "tool";
		}
	}
}

/**
 * Copy a tool-call `rawInput` payload into a transcript-safe `arguments` record.
 *
 * ACP payloads arrive through JSON-RPC, so they are already JSON-shaped; this
 * only wraps non-objects and refuses to stage an unbounded payload.
 */
export function devinAcpToolArguments(rawInput: unknown): Record<string, unknown> {
	if (rawInput === undefined || rawInput === null) return {};
	if (typeof rawInput !== "object" || Array.isArray(rawInput)) return { value: rawInput };
	let serialized: string;
	try {
		serialized = JSON.stringify(rawInput);
	} catch {
		return {};
	}
	if (serialized === undefined || serialized.length > ACP_TOOL_ARGUMENT_MAX_BYTES) return { truncated: true };
	return rawInput as Record<string, unknown>;
}

/** Map an ACP prompt stop reason onto GJC's assistant stop reason. */
export function devinAcpStopReason(stopReason: StopReason): "stop" | "length" | "aborted" {
	switch (stopReason) {
		case "max_tokens":
		case "max_turn_requests":
			return "length";
		case "cancelled":
			return "aborted";
		default:
			return "stop";
	}
}

/** Flatten ACP select option groups into `{ id, name }` model entries. */
export function devinAcpSelectOptions(
	options: Extract<SessionConfigOption, { type: "select" }>["options"],
): Array<{ id: string; name: string }> {
	const entries: Array<{ id: string; name: string }> = [];
	for (const candidate of options) {
		if ("group" in candidate) {
			for (const grouped of candidate.options) entries.push({ id: grouped.value, name: grouped.name });
			continue;
		}
		entries.push({ id: candidate.value, name: candidate.name });
	}
	return entries;
}

/**
 * Select the option matching the configured policy.
 *
 * `allow` grants a single action and never a persistent one: when the agent
 * offers no `allow_once`, the request is cancelled rather than escalated to
 * `allow_always`. `deny` may fall back to `reject_always`, because a persistent
 * refusal only reduces what the agent may do.
 */
export function devinAcpSelectPermissionOption(
	options: ReadonlyArray<PermissionOption>,
	mode: DevinAcpPermissionMode,
): { optionId: string } | null {
	const preferred = mode === "allow" ? (["allow_once"] as const) : (["reject_once", "reject_always"] as const);
	for (const kind of preferred) {
		const found = options.find(option => option.kind === kind);
		if (found) return { optionId: found.optionId };
	}
	return null;
}

/** Resolve the permission policy from an explicit config value or the environment. */
export function devinAcpResolvePermissionMode(
	configured: DevinAcpPermissionMode | undefined,
	env: Record<string, string | undefined> = process.env,
): DevinAcpPermissionMode {
	// An explicit value always wins and fails closed: an out-of-type value from an
	// untyped caller must never fall through to the permissive default.
	if (configured !== undefined) return configured === "allow" ? "allow" : "deny";
	const raw = env[DEVIN_ACP_PERMISSION_MODE_ENV]?.trim().toLowerCase();
	if (raw === undefined || raw.length === 0) return "allow";
	return raw === "allow" ? "allow" : "deny";
}

/** Build the ACP prompt content blocks for the newest user turn. */
export function devinAcpPromptBlocks(context: Context, supportsImages: boolean): ContentBlock[] {
	const messages = Array.isArray(context.messages) ? context.messages : [];
	let lastUser: (typeof messages)[number] | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			lastUser = messages[index];
			break;
		}
	}
	if (lastUser?.role !== "user") return [];
	const content =
		typeof lastUser.content === "string" ? [{ type: "text" as const, text: lastUser.content }] : lastUser.content;
	const blocks: ContentBlock[] = [];
	for (const item of content) {
		if (item.type === "text") {
			if (item.text.length > 0) blocks.push({ type: "text", text: item.text });
			continue;
		}
		if (item.type === "image") {
			if (!supportsImages) {
				blocks.push({
					type: "text",
					text: `[image attachment omitted: this Devin ACP agent does not advertise image prompt support (${item.mimeType})]`,
				});
				continue;
			}
			blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

interface ActiveTurn {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	textIndex: number | null;
	thinkingIndex: number | null;
	toolCallIndexes: Map<string, number>;
	settled: boolean;
	/**
	 * Resolved by `cancelTurn` so a cancellation that races the ACP handshake stops
	 * the turn instead of waiting for a session that may never be created.
	 */
	cancellation: Promise<void>;
	requestCancellation: () => void;
	/**
	 * Re-arms this turn's idle budget; set only while this turn's ACP prompt is in
	 * flight. It lives on the turn, not the bridge, so a stale turn can never
	 * re-arm — or cancel — the turn that replaced it.
	 */
	rearmIdle: (() => void) | undefined;
}

function closeTextBlock(turn: ActiveTurn): void {
	if (turn.textIndex === null) return;
	const block = turn.output.content[turn.textIndex];
	const text = block?.type === "text" ? block.text : "";
	turn.stream.push({ type: "text_end", contentIndex: turn.textIndex, content: text, partial: turn.output });
	turn.textIndex = null;
}

function closeThinkingBlock(turn: ActiveTurn): void {
	if (turn.thinkingIndex === null) return;
	const block = turn.output.content[turn.thinkingIndex];
	const thinking = block?.type === "thinking" ? block.thinking : "";
	turn.stream.push({
		type: "thinking_end",
		contentIndex: turn.thinkingIndex,
		content: thinking,
		partial: turn.output,
	});
	turn.thinkingIndex = null;
}

function appendTextDelta(turn: ActiveTurn, text: string): void {
	if (text.length === 0) return;
	closeThinkingBlock(turn);
	if (turn.textIndex === null) {
		const index = turn.output.content.length;
		turn.output.content.push({ type: "text", text: "" });
		turn.textIndex = index;
		turn.stream.push({ type: "text_start", contentIndex: index, partial: turn.output });
	}
	const block = turn.output.content[turn.textIndex];
	if (block?.type !== "text") return;
	block.text += text;
	turn.stream.push({ type: "text_delta", contentIndex: turn.textIndex, delta: text, partial: turn.output });
}

function appendThinkingDelta(turn: ActiveTurn, text: string): void {
	if (text.length === 0) return;
	closeTextBlock(turn);
	if (turn.thinkingIndex === null) {
		const index = turn.output.content.length;
		turn.output.content.push({ type: "thinking", thinking: "" });
		turn.thinkingIndex = index;
		turn.stream.push({ type: "thinking_start", contentIndex: index, partial: turn.output });
	}
	const block = turn.output.content[turn.thinkingIndex];
	if (block?.type !== "thinking") return;
	block.thinking += text;
	turn.stream.push({ type: "thinking_delta", contentIndex: turn.thinkingIndex, delta: text, partial: turn.output });
}

/** Metadata GJC attaches to a tool call that ran inside the Devin agent. */
function acpAnnotation(toolCallId: string, kind?: string | null, status?: string | null): Record<string, unknown> {
	return {
		toolCallId,
		...(kind ? { kind } : {}),
		...(status ? { status } : {}),
	};
}

function upsertToolCall(turn: ActiveTurn, toolCall: AcpToolCall | ToolCallUpdate, existingOnly: boolean): void {
	closeTextBlock(turn);
	closeThinkingBlock(turn);
	const kind = "kind" in toolCall ? toolCall.kind : undefined;
	const status = "status" in toolCall ? toolCall.status : undefined;
	const title = toolCall.title ?? "";
	const index = turn.toolCallIndexes.get(toolCall.toolCallId);
	if (index !== undefined) {
		const block = turn.output.content[index];
		if (block?.type !== "toolCall") return;
		const previous = block.arguments._acp as Record<string, unknown> | undefined;
		// ACP tool-call updates carry only changed fields, so merge with what the
		// opening `tool_call` already recorded instead of dropping it.
		block.arguments = {
			...block.arguments,
			_acp: {
				...previous,
				...(kind ? { kind } : {}),
				...(status ? { status } : {}),
			},
		};
		if (title.length > 0) block.intent = title;
		turn.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: turn.output });
		return;
	}
	if (existingOnly) return;
	const block: ToolCall & ProviderResolvedCarrier = {
		type: "toolCall",
		id: toolCall.toolCallId,
		name: devinAcpDisplayToolName(kind, "name" in toolCall ? toolCall.name : undefined),
		arguments: {
			...devinAcpToolArguments("rawInput" in toolCall ? toolCall.rawInput : undefined),
			_acp: acpAnnotation(toolCall.toolCallId, kind, status),
		},
		...(title.length > 0 ? { intent: title } : {}),
		// The agent already ran this call. The marker is what stops the GJC agent
		// loop from dispatching it to a local tool of the same display name.
		[kProviderResolvedToolCall]: true,
	};
	const created = turn.output.content.length;
	turn.output.content.push(block);
	turn.toolCallIndexes.set(toolCall.toolCallId, created);
	turn.stream.push({ type: "toolcall_start", contentIndex: created, partial: turn.output });
	turn.stream.push({ type: "toolcall_end", contentIndex: created, toolCall: block, partial: turn.output });
}

function applySessionUpdate(turn: ActiveTurn, update: SessionNotification["update"]): void {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			if (update.content.type === "text") appendTextDelta(turn, update.content.text);
			return;
		case "agent_thought_chunk":
			if (update.content.type === "text") appendThinkingDelta(turn, update.content.text);
			return;
		case "tool_call":
			upsertToolCall(turn, update, false);
			return;
		case "tool_call_update":
			upsertToolCall(turn, update, true);
			return;
		default:
			// user_message_chunk echoes our own prompt; plan/plan_update/plan_removed,
			// available_commands_update, current_mode_update, config_option_update,
			// session_info_update and usage_update carry no GJC-visible surface. Unknown
			// update kinds are never assumed safe to render into the transcript.
			return;
	}
}

function settleTurn(turn: ActiveTurn, reason: "done" | "error" | "aborted"): void {
	if (turn.settled) return;
	turn.settled = true;
	if (reason === "done") {
		turn.stream.push({
			type: "done",
			reason: turn.output.stopReason === "length" ? "length" : "stop",
			message: turn.output,
		});
	} else {
		turn.stream.push({ type: "error", reason, error: turn.output });
	}
	turn.stream.end();
}

// ---------------------------------------------------------------------------
// ACP bridge
// ---------------------------------------------------------------------------

interface DevinAcpSessionHandle {
	id: string;
	configOptions: SessionConfigOption[] | null;
}

function resolveSessionId(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	return String(error);
}

function isAuthRequired(error: unknown): boolean {
	return error instanceof RequestError && error.code === ACP_AUTH_REQUIRED_CODE;
}

/**
 * Devin turns are interactive session turns only.
 *
 * GJC routes several non-turn requests through a model provider — context
 * compaction, handoff generation, session-title generation, branch summaries —
 * and each of those would otherwise be sent to Devin as a real (billed) agent
 * prompt that cannot answer it. They are refused up front with an actionable
 * message instead.
 */
function refuseNonInteractiveTurn(options: DevinAcpOptions | undefined): void {
	if (options?.maintenanceCall || options?.initiatorOverride === "agent") {
		throw new Error(
			"Devin ACP cannot serve GJC maintenance calls (context compaction, handoff, branch summaries): it is an agent, not a text model. Switch to a non-Devin model for that operation — Devin manages its own conversation context, so GJC-side compaction is not needed for a Devin turn.",
		);
	}
	if (!resolveSessionId(options?.providerSessionId) && !resolveSessionId(options?.sessionId)) {
		throw new Error(
			"Devin ACP turns require a session identity (providerSessionId). GJC utility one-shots such as session-title generation are not supported on a Devin model.",
		);
	}
}

const DEVIN_ACP_INSTALL_HINT =
	"Install Devin CLI (https://docs.devin.ai/cli) and run `devin auth login`, or point GJC_DEVIN_CLI_PATH at the executable.";

/** Turn a launch failure (missing binary, permissions) into an actionable message. */
function spawnFailureMessage(error: unknown): string {
	const base = errorMessage(error);
	return /ENOENT|not found|EACCES/i.test(base) ? `${base} ${DEVIN_ACP_INSTALL_HINT}` : base;
}

class DevinAcpBridge implements ProviderSessionState {
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #connection: ClientSideConnection;
	readonly #cwd: string;
	/** Re-applied per turn: the bridge is cached, the policy is not. */
	#permissionMode: DevinAcpPermissionMode;
	#permissionHandler: DevinAcpPermissionHandler | undefined;
	#init: Promise<InitializeResponse> | undefined;
	#session: Promise<DevinAcpSessionHandle> | undefined;
	#promptCapabilities: PromptCapabilities | undefined;
	#turn: ActiveTurn | null = null;
	#stderrTail = "";
	#exitError: Error | null = null;
	#disposed = false;

	constructor(config: {
		argv: readonly string[];
		cwd: string;
		permissionMode: DevinAcpPermissionMode;
		permissionHandler?: DevinAcpPermissionHandler;
	}) {
		this.#cwd = config.cwd;
		this.#permissionMode = config.permissionMode;
		this.#permissionHandler = config.permissionHandler;
		this.#proc = Bun.spawn([...config.argv], {
			cwd: config.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const sink = this.#proc.stdin;
		const output = new WritableStream<Uint8Array>({
			async write(chunk) {
				sink.write(chunk);
				await sink.flush();
			},
			async close() {
				await sink.end();
			},
			async abort() {
				try {
					await sink.end();
				} catch {
					// The child already closed its end of the pipe.
				}
			},
		});
		this.#connection = new ClientSideConnection(
			(_agent: Agent) => this.#client(),
			ndJsonStream(output, this.#proc.stdout),
		);
		void this.#drainStderr();
		void this.#watchExit();
	}

	get exitError(): Error | null {
		return this.#exitFailure();
	}

	/**
	 * Terminal child-process failure, if any. Read from the live exit code as well
	 * as the exit watcher so a turn that races the watcher still reports the real
	 * cause instead of a generic transport error.
	 */
	#exitFailure(): Error | null {
		if (this.#exitError) return this.#exitError;
		const code = this.#proc.exitCode;
		if (code === null) return null;
		const tail = this.#stderrTail.trim();
		return new Error(`Devin ACP process exited with code ${code}${tail.length > 0 ? `: ${tail}` : "."}`);
	}

	get supportsImages(): boolean {
		return this.#promptCapabilities?.image === true;
	}

	#client(): Client {
		return {
			requestPermission: params => this.#handlePermission(params),
			sessionUpdate: notification => {
				const turn = this.#turn;
				if (!turn || turn.settled) return;
				// The idle budget is the gap between agent updates, not a whole-turn wall
				// clock: a long but active Devin turn must never be killed by it.
				turn.rearmIdle?.();
				applySessionUpdate(turn, notification.update);
			},
		};
	}

	async #drainStderr(): Promise<void> {
		try {
			const decoder = new TextDecoder();
			for await (const chunk of this.#proc.stderr as ReadableStream<Uint8Array>) {
				this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(
					-DEVIN_ACP_STDERR_TAIL_BYTES,
				);
			}
		} catch {
			// Diagnostics only; the protocol path reports real failures.
		}
	}

	async #watchExit(): Promise<void> {
		await this.#proc.exited;
		if (this.#disposed) return;
		this.#disposed = true;
		this.#exitError = this.#exitFailure();
		const turn = this.#turn;
		if (turn && !turn.settled) {
			turn.output.stopReason = "error";
			turn.output.errorMessage = this.#exitError?.message ?? "Devin ACP process exited.";
			settleTurn(turn, "error");
		}
	}

	async #ensureInitialized(): Promise<InitializeResponse> {
		this.#init ??= this.#connection.initialize({
			protocolVersion: 1,
			clientCapabilities: { fs: {}, terminal: false },
			clientInfo: { name: DEVIN_ACP_CLIENT_NAME, version: VERSION },
		});
		try {
			const response = await this.#init;
			this.#promptCapabilities = response.agentCapabilities?.promptCapabilities ?? undefined;
			return response;
		} catch (error) {
			this.#init = undefined;
			throw error;
		}
	}

	async #ensureSession(): Promise<DevinAcpSessionHandle> {
		this.#session ??= (async () => {
			await this.#ensureInitialized();
			try {
				const response = await this.#connection.newSession({ cwd: this.#cwd, mcpServers: [] });
				return { id: response.sessionId, configOptions: response.configOptions ?? null };
			} catch (error) {
				if (isAuthRequired(error)) {
					throw new Error(
						"Devin CLI is not authenticated. Run `devin auth login` (or set WINDSURF_API_KEY for enterprise builds) and retry.",
					);
				}
				throw error;
			}
		})();
		try {
			return await this.#session;
		} catch (error) {
			this.#session = undefined;
			throw error;
		}
	}

	#modelConfigOption(session: DevinAcpSessionHandle): Extract<SessionConfigOption, { type: "select" }> | undefined {
		return session.configOptions?.find(
			(candidate): candidate is Extract<SessionConfigOption, { type: "select" }> =>
				candidate.category === "model" && candidate.type === "select",
		);
	}

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		const session = await this.#ensureSession();
		const option = this.#modelConfigOption(session);
		return option ? devinAcpSelectOptions(option.options) : [];
	}

	/**
	 * Apply the GJC-selected model to the ACP session.
	 *
	 * When the session advertises a model selector, a model the account cannot
	 * use fails loudly instead of silently running a different (possibly more
	 * expensive) model. Agents without a model selector keep their own default.
	 */
	async #selectModel(modelId: string): Promise<void> {
		if (modelId.length === 0) return;
		const session = await this.#ensureSession();
		const option = this.#modelConfigOption(session);
		if (!option) return;
		if (option.currentValue === modelId) return;
		const available = devinAcpSelectOptions(option.options).some(entry => entry.id === modelId);
		if (!available) {
			throw new Error(
				`Devin account does not offer model "${modelId}". Run \`devin models list\` or pick a discovered Devin model.`,
			);
		}
		const response = await this.#connection.setSessionConfigOption({
			sessionId: session.id,
			configId: option.id,
			value: modelId,
		});
		session.configOptions = response.configOptions;
	}

	async #handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		const request: DevinAcpPermissionRequest = {
			sessionId: params.sessionId,
			toolCallId: params.toolCall.toolCallId,
			title: params.toolCall.title ?? "",
			...(params.toolCall.kind ? { kind: params.toolCall.kind } : {}),
			...(params.toolCall.rawInput !== undefined ? { rawInput: params.toolCall.rawInput } : {}),
			options: params.options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
		};
		let decision: DevinAcpPermissionDecision | null = null;
		if (this.#permissionHandler) {
			try {
				decision = await this.#permissionHandler(request);
			} catch {
				// A broken handler must never become an implicit approval.
				decision = null;
			}
		} else {
			decision = devinAcpSelectPermissionOption(params.options, this.#permissionMode);
		}
		if (!decision || "cancelled" in decision) return { outcome: { outcome: "cancelled" } };
		if (!params.options.some(option => option.optionId === decision.optionId))
			return { outcome: { outcome: "cancelled" } };
		return { outcome: { outcome: "selected", optionId: decision.optionId } };
	}

	/**
	 * Start one ACP prompt turn. Returns synchronously with the caller's stream;
	 * the returned promise settles when the turn finishes.
	 *
	 * One ACP session carries one turn at a time: a concurrent call would
	 * interleave two transcripts into the same session.
	 */
	beginTurn(
		turn: ActiveTurn,
		model: Model<"devin-acp">,
		context: Context,
		options: DevinAcpOptions | undefined,
	): Promise<void> {
		const active = this.#turn;
		if (active && !active.settled) {
			turn.output.stopReason = "error";
			turn.output.errorMessage = "A Devin ACP turn is already running on this session.";
			settleTurn(turn, "error");
			return Promise.resolve();
		}
		this.#turn = turn;
		return this.#runTurn(turn, model, context, options);
	}

	async #runTurn(
		turn: ActiveTurn,
		model: Model<"devin-acp">,
		context: Context,
		options: DevinAcpOptions | undefined,
	): Promise<void> {
		const { output } = turn;
		// Every provider opens with a start event carrying its partial assistant
		// message: the loop uses it to publish streaming updates and to hold the
		// partial while the turn runs.
		turn.stream.push({ type: "start", partial: output });
		try {
			refuseNonInteractiveTurn(options);
		} catch (error) {
			output.stopReason = "error";
			output.errorMessage = errorMessage(error);
			settleTurn(turn, "error");
			if (this.#turn === turn) this.#turn = null;
			return;
		}
		// The bridge is cached per conversation, so the permission policy is applied
		// per turn: a later turn that tightens the mode, or supplies its own handler,
		// must not inherit whichever turn happened to create the child.
		this.#permissionMode = devinAcpResolvePermissionMode(options?.devinAcp?.permissionMode);
		this.#permissionHandler = options?.devinAcp?.permissionHandler;
		const startedAt = Date.now();
		const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
		const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const arm = (budgetMs: number | undefined, label: string) => {
			if (watchdog !== undefined) clearTimeout(watchdog);
			if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs <= 0) return;
			watchdog = setTimeout(() => {
				void this.cancelTurn(new Error(`Devin ACP ${label} timed out after ${budgetMs}ms`));
			}, budgetMs);
		};
		const onAbort = () => {
			void this.cancelTurn();
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const exited = this.#exitFailure();
			if (exited) throw exited;
			if (options?.signal?.aborted) {
				output.stopReason = "aborted";
				settleTurn(turn, "aborted");
				return;
			}
			arm(firstEventTimeoutMs, "first-agent-update");
			// Race the handshake against cancellation: a `devin acp` child that never
			// answers `initialize`/`session/new` must not hang the turn (or leak the
			// child) after the caller already cancelled it.
			const handshake = this.#ensureSession();
			void handshake.catch(() => undefined);
			const session = await Promise.race([handshake, turn.cancellation.then(() => null)]);
			if (session === null || turn.settled) return;
			await this.#selectModel(model.id);
			if (turn.settled) return;
			const blocks = devinAcpPromptBlocks(context, this.supportsImages);
			if (blocks.length === 0) {
				throw new Error(
					"Devin ACP turns require a user message to forward; an empty prompt is not sent to the agent.",
				);
			}
			arm(idleTimeoutMs, "agent-update");
			turn.rearmIdle = () => arm(idleTimeoutMs, "agent-update");
			const promptCall = this.#connection.prompt({ sessionId: session.id, prompt: blocks });
			// A child that never answers `session/prompt` must not park `#runTurn` forever,
			// or a disposable bridge could never be reaped.
			void promptCall.catch(() => undefined);
			const response = await Promise.race([
				promptCall,
				turn.cancellation.then(async () => {
					// Grace for the cancelled agent to answer `session/cancel` before a
					// disposable child is reaped; a hung agent still unwinds after this bound.
					await Bun.sleep(DEVIN_ACP_CANCEL_ACK_GRACE_MS);
					return null;
				}),
			]);
			// A cancel that raced the prompt settles the stream first; never rewrite the
			// terminal state of a turn that has already been published.
			if (response === null || turn.settled) return;
			closeTextBlock(turn);
			closeThinkingBlock(turn);
			if (options?.signal?.aborted) {
				output.stopReason = "aborted";
				settleTurn(turn, "aborted");
				return;
			}
			output.stopReason = devinAcpStopReason(response.stopReason);
			if (output.stopReason === "length") {
				output.errorMessage = "Devin ended the turn at its own turn or token limit.";
			}
			output.duration = Date.now() - startedAt;
			settleTurn(turn, "done");
		} catch (error) {
			closeTextBlock(turn);
			closeThinkingBlock(turn);
			const mapped = (await this.#settledExitFailure()) ?? error;
			// A turn already published by a racing cancel keeps its terminal state.
			if (!turn.settled) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = errorMessage(mapped);
				settleTurn(turn, output.stopReason === "aborted" ? "aborted" : "error");
			}
		} finally {
			if (watchdog !== undefined) clearTimeout(watchdog);
			turn.rearmIdle = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
			if (this.#turn === turn) this.#turn = null;
		}
	}

	async #settledExitFailure(): Promise<Error | null> {
		const immediate = this.#exitFailure();
		if (immediate) return immediate;
		// The ACP transport can report a closed connection before the exit watcher
		// observes the child's status; give the process a bounded moment to settle so
		// the turn reports the real cause (exit code and stderr tail).
		await Promise.race([this.#proc.exited, Bun.sleep(250)]);
		return this.#exitFailure();
	}

	/** Cancel the in-flight turn: notify the agent best-effort, then settle the stream. */
	async cancelTurn(reason?: Error): Promise<void> {
		const turn = this.#turn;
		const session = await Promise.race([
			this.#session?.catch(() => undefined) ?? Promise.resolve(undefined),
			Bun.sleep(DEVIN_ACP_CANCEL_DELIVERY_GRACE_MS).then(() => undefined),
		]);
		if (session) {
			try {
				await this.#connection.cancel({ sessionId: session.id });
			} catch {
				// The agent may already have finished; the turn settles below regardless.
			}
		}
		// Only now wake a parked handshake or prompt: the cancellation must be delivered
		// before `#runTurn` unwinds and a disposable child is reaped.
		turn?.requestCancellation();
		if (turn && !turn.settled) {
			turn.output.stopReason = reason ? "error" : "aborted";
			if (reason) turn.output.errorMessage = errorMessage(reason);
			settleTurn(turn, reason ? "error" : "aborted");
		}
	}

	close(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const turn = this.#turn;
		if (turn && !turn.settled) {
			turn.output.stopReason = "aborted";
			settleTurn(turn, "aborted");
		}
		try {
			this.#proc.kill();
		} catch {
			// Already exited.
		}
	}
}

// ---------------------------------------------------------------------------
// Provider entry points
// ---------------------------------------------------------------------------

function createTurn(model: Model<"devin-acp">): ActiveTurn {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "devin-acp" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const cancellation = Promise.withResolvers<void>();
	return {
		stream,
		output,
		textIndex: null,
		thinkingIndex: null,
		toolCallIndexes: new Map(),
		settled: false,
		cancellation: cancellation.promise,
		requestCancellation: cancellation.resolve,
		rearmIdle: undefined,
	};
}

/**
 * Stable identity for the cached ACP child.
 *
 * `cwd` is part of the identity on purpose: `/move` changes `process.cwd()`, and a
 * cached child keeps the directory it was spawned in, so a cwd change must miss the
 * cache and respawn instead of running Devin's tools in the abandoned tree.
 */
export function devinAcpBridgeIdentity(
	conversationId: string | undefined,
	cwd: string,
	argv: readonly string[],
): string {
	return `devin-acp:${conversationId ?? "ephemeral"}:${cwd}\u0000${argv.join("\u0000")}`;
}

/**
 * Resolve (or create) the ACP bridge for this conversation.
 *
 * A bridge is stored in the caller-owned `providerSessionState` map so its child
 * process is killed by GJC's session teardown. Without that map the caller gets a
 * disposable bridge, and `streamDevinAcp` closes it when the turn settles.
 */
function resolveBridge(config: { streamOptions: DevinAcpOptions | undefined; conversationId: string | undefined }): {
	bridge: DevinAcpBridge;
	owned: boolean;
} {
	const acp = config.streamOptions?.devinAcp;
	const cliPath = acp?.cliPath ?? process.env[DEVIN_ACP_CLI_ENV]?.trim() ?? DEVIN_ACP_DEFAULT_CLI;
	const argv = [cliPath, ...(acp?.cliArgs ?? []), "acp"];
	const cwd = acp?.cwd ?? process.cwd();
	const spawn = () =>
		new DevinAcpBridge({
			argv,
			cwd,
			permissionMode: devinAcpResolvePermissionMode(acp?.permissionMode),
			permissionHandler: acp?.permissionHandler,
		});
	const stateMap = config.streamOptions?.providerSessionState;
	if (!stateMap) return { bridge: spawn(), owned: true };
	const key = devinAcpBridgeIdentity(config.conversationId, cwd, argv);
	const existing = stateMap.get(key);
	if (existing instanceof DevinAcpBridge && !existing.exitError) return { bridge: existing, owned: false };
	if (existing) existing.close();
	// One conversation maps to one live child. A cwd (or argv) change supersedes the
	// previous bridge, and leaving it in the map would keep a child bound to the
	// abandoned directory running until session teardown.
	const prefix = `devin-acp:${config.conversationId ?? "ephemeral"}:`;
	for (const [candidateKey, candidate] of stateMap) {
		if (candidateKey === key || !candidateKey.startsWith(prefix)) continue;
		stateMap.delete(candidateKey);
		if (candidate instanceof DevinAcpBridge) candidate.close();
	}
	const created = spawn();
	stateMap.set(key, created);
	return { bridge: created, owned: false };
}

export const streamDevinAcp: (
	model: Model<"devin-acp">,
	context: Context,
	options?: DevinAcpOptions,
) => AssistantMessageEventStreamType = (model, context, options) => {
	try {
		const conversationId = resolveSessionId(options?.providerSessionId) ?? resolveSessionId(options?.sessionId);
		const { bridge, owned } = resolveBridge({ streamOptions: options, conversationId });
		const turn = createTurn(model);
		const settled = bridge.beginTurn(turn, model, context, options);
		if (owned) {
			// A disposable child is reaped as soon as the turn unwinds, which the
			// cancellation races above guarantee even for an agent that never answers.
			void settled.then(
				() => bridge.close(),
				() => bridge.close(),
			);
		}
		return turn.stream;
	} catch (error) {
		// Launch failures must surface as a stream error, never as a thrown
		// provider call: callers (and the lazy dispatch wrapper) expect a stream.
		const turn = createTurn(model);
		turn.output.stopReason = "error";
		turn.output.errorMessage = spawnFailureMessage(error);
		settleTurn(turn, "error");
		return turn.stream;
	}
};

/**
 * Discover the account's Devin models over ACP.
 *
 * `devin models list --format json` is deliberately not parsed: its schema is
 * undocumented, while the session's own `model` config option is the
 * authoritative ACP surface for the authenticated account and enterprise
 * allowlists. Returns `null` when the CLI is missing, unauthenticated, or the
 * agent advertises no model selector — which the model registry treats as
 * "no dynamic models".
 */
export async function fetchDevinAcpModels(
	config: { cliPath?: string; cliArgs?: readonly string[]; cwd?: string } = {},
): Promise<Model<"devin-acp">[] | null> {
	const cliPath = config.cliPath ?? process.env[DEVIN_ACP_CLI_ENV]?.trim() ?? DEVIN_ACP_DEFAULT_CLI;
	const bridge = (() => {
		try {
			return new DevinAcpBridge({
				argv: [cliPath, ...(config.cliArgs ?? []), "acp"],
				cwd: config.cwd ?? process.cwd(),
				permissionMode: "deny",
			});
		} catch {
			// A missing or unlaunchable CLI is "no discovered models", not a failure.
			return null;
		}
	})();
	if (!bridge) return null;
	try {
		const models = await bridge.listModels();
		if (models.length === 0) return null;
		const input = bridge.supportsImages ? (["text", "image"] as const) : (["text"] as const);
		return models.map(entry => ({
			id: entry.id,
			name: entry.name,
			api: "devin-acp",
			provider: "devin",
			baseUrl: DEVIN_ACP_BASE_URL,
			reasoning: false,
			input: [...input],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEVIN_ACP_CONTEXT_WINDOW,
			maxTokens: DEVIN_ACP_MAX_TOKENS,
		}));
	} catch {
		return null;
	} finally {
		bridge.close();
	}
}

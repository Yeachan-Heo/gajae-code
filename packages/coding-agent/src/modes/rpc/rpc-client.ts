/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionResult } from "@gajae-code/agent-core/compaction";
import type { ImageContent, Model } from "@gajae-code/ai";
import { isRecord, ptree, readJsonl } from "@gajae-code/utils";
import type { BashResult } from "../../exec/bash-executor";
import type { SessionStats } from "../../session/agent-session";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
	RpcUnattendedAccepted,
	RpcUnattendedDeclaration,
	RpcWorkflowGate,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string" || isRecord(value.error);
	}
	return true;
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function isRpcWorkflowGate(value: unknown): value is RpcWorkflowGate {
	if (!isRecord(value)) return false;
	return (
		value.type === "workflow_gate" &&
		typeof value.gate_id === "string" &&
		typeof value.stage === "string" &&
		typeof value.kind === "string" &&
		isRecord(value.schema) &&
		typeof value.schema_hash === "string" &&
		isRecord(value.context) &&
		typeof value.created_at === "string" &&
		value.required === true
	);
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#process: ptree.ChildProcess | null = null;
	#eventListeners: RpcEventListener[] = [];
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#extensionUiListeners: Set<(req: RpcExtensionUIRequest) => void> = new Set();
	#workflowGateListeners: Set<(gate: RpcWorkflowGate) => void> = new Set();
	#abortController = new AbortController();

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.#process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.#process = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
			stderr: "full",
		});
		const startupStderrPromise = this.#process.stderr
			? new Response(this.#process.stderr).text().catch(() => "")
			: Promise.resolve("");
		const getStartupStderr = async () => this.#process?.peekStderr() || (await startupStderrPromise);

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;

		// Process lines in background, intercepting the ready signal
		const lines = readJsonl(this.#process.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					readySettled = true;
					readyResolve();
					continue;
				}
				this.#handleLine(line);
			}
			// Stream ended without ready signal — process exited. Wait for the
			// managed process wrapper so stderr is fully drained before reporting.
			if (!readySettled) {
				const proc = this.#process;
				const exitCode = proc ? await proc.exited.catch(() => proc.exitCode ?? -1) : undefined;
				if (!readySettled) {
					const stderr = await getStartupStderr();
					readySettled = true;
					readyReject(
						new Error(
							`Agent process exited${exitCode === undefined ? "" : ` with code ${exitCode}`} before ready. Stderr: ${stderr}`,
						),
					);
				}
			}
		})().catch((err: Error) => {
			if (!readySettled) {
				readySettled = true;
				readyReject(err);
			}
		});

		// Also race against process exit (in case stdout closes before we read it)
		void this.#process.exited.then(async (exitCode: number) => {
			if (!readySettled) {
				const stderr = await getStartupStderr();
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${stderr}`));
			}
		});

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			void getStartupStderr().then(stderr => {
				readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${stderr}`));
			});
		});

		try {
			await readyPromise;
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop() {
		if (!this.#process) return;

		this.#process.kill();
		this.#abortController.abort();
		this.#process = null;
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort();
		}
		this.#pendingHostToolCalls.clear();
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		try {
			this.stop();
		} catch {
			// Ignore cleanup errors
		}
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to workflow lifecycle gates emitted by RPC mode.
	 */
	onWorkflowGate(listener: (gate: RpcWorkflowGate) => void): () => void {
		this.#workflowGateListeners.add(listener);
		return () => {
			this.#workflowGateListeners.delete(listener);
		};
	}

	/**
	 * Answer a workflow lifecycle gate and wait for the server resolution envelope.
	 */
	async respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<RpcWorkflowGateResolution> {
		const response = await this.#send({
			type: "workflow_gate_response",
			gate_id: gateId,
			answer,
			idempotency_key: idempotencyKey,
		});
		return this.#getData(response);
	}

	/**
	 * Subscribe to extension UI requests emitted by the server (e.g. select /
	 * input / editor / confirm). Returns an unsubscribe function.
	 */
	onExtensionUiRequest(listener: (req: RpcExtensionUIRequest) => void): () => void {
		this.#extensionUiListeners.add(listener);
		return () => {
			this.#extensionUiListeners.delete(listener);
		};
	}

	/**
	 * Enter unattended mode by declaring budget + scopes + action allowlist.
	 * Returns the accepted declaration, or rejects (fail-closed) on refusal.
	 */
	async negotiateUnattended(declaration: RpcUnattendedDeclaration): Promise<RpcUnattendedAccepted> {
		const response = await this.#send({ type: "negotiate_unattended", declaration });
		return this.#getData(response);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Hand off session context to a new session.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get list of OAuth providers available for login, with their current authentication status.
	 */
	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * The server will emit an `open_url` extension_ui_request for the auth URL.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must open
	 *   it in a browser for the callback-server OAuth flow to complete.
	 */
	async login(
		providerId: string,
		options?: { onOpenUrl?: (url: string, instructions?: string) => void },
	): Promise<{ providerId: string }> {
		const { onOpenUrl } = options ?? {};
		const listener = onOpenUrl
			? (req: RpcExtensionUIRequest) => {
					if (req.method === "open_url") onOpenUrl(req.url, req.instructions);
				}
			: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcWorkflowGate(data)) {
			for (const listener of this.#workflowGateListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (!isAgentEvent(data)) return;

		// Otherwise it's an event
		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcWorkflowGateResponse | RpcHostToolResult | RpcHostToolUpdate,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const stdin = this.#process.stdin as import("bun").FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (flushResult instanceof Promise) {
			flushResult.catch((err: Error) => {
				onError?.(err);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(
				typeof errorResponse.error === "string" ? errorResponse.error : JSON.stringify(errorResponse.error),
			);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}

import type { BridgeClientCommand, BridgeCommandHelpers, BridgeCommandOptions } from "./commands";
import type { BridgeFrame } from "./reference-consumer";

export * from "./commands";
export * from "./reference-consumer";
export * from "./workflow-gate";

import type { UnattendedDeclaration, WorkflowGate, WorkflowGateResolver } from "./workflow-gate";
import { isWorkflowGateFrame } from "./workflow-gate";
export type BridgeCapability =
	| "events"
	| "prompt"
	| "permission"
	| "elicitation"
	| "ui.declarative"
	| "ui.editor"
	| "ui.terminal_input"
	| "host_tools"
	| "host_uri"
	| "client_bridge.read_text_file"
	| "client_bridge.write_text_file"
	| "client_bridge.create_terminal"
	| "workflow_gate";

export type BridgeCommandScope =
	| "prompt"
	| "control"
	| "bash"
	| "export"
	| "session"
	| "model"
	| "message:read"
	| "host_tools"
	| "host_uri"
	| "admin";

export interface BridgeProtocolRange {
	min: number;
	max: number;
}

export interface BridgeHandshakeRequest {
	protocol_version_range: BridgeProtocolRange;
	capabilities: BridgeCapability[];
	requested_scopes: BridgeCommandScope[];
	last_seq?: number;
	unattended?: UnattendedDeclaration;
}

export interface BridgeHandshakeAccepted {
	status: "accepted";
	protocol_version: number;
	session_id: string;
	accepted_capabilities: BridgeCapability[];
	accepted_scopes: BridgeCommandScope[];
	unsupported: BridgeCapability[];
	endpoints: {
		events: string;
		commands: string;
		uiResponses: string;
		claimControl: string;
		hostToolResults: string;
		disconnectControl: string;
		hostUriResults: string;
	};
	frame_types: string[];
	accepted_unattended?: UnattendedDeclaration;
}

export interface BridgeHandshakeRejected {
	status: "rejected";
	reason: "incompatible_version" | "unauthorized" | "invalid_request";
	message: string;
}

export type BridgeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type BridgeHandshakeResponse = BridgeHandshakeAccepted | BridgeHandshakeRejected;
function parseSseData(buffer: string): { frames: BridgeFrame[]; rest: string } {
	const frames: BridgeFrame[] = [];
	let rest = buffer.replaceAll("\r\n", "\n");
	let boundary = rest.indexOf("\n\n");
	while (boundary >= 0) {
		const block = rest.slice(0, boundary);
		rest = rest.slice(boundary + 2);
		for (const line of block.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			frames.push(JSON.parse(line.slice(6)) as BridgeFrame);
		}
		boundary = rest.indexOf("\n\n");
	}
	return { frames, rest };
}

export interface BridgeClientOptions {
	baseUrl: string;
	token: string;
	fetch?: BridgeFetch;
	allowInsecureLocalhost?: boolean;
}

function isLocalhostUrl(url: URL): boolean {
	return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export class BridgeClient implements BridgeCommandHelpers {
	readonly #baseUrl: URL;
	readonly #token: string;
	readonly #fetch: BridgeFetch;

	constructor(options: BridgeClientOptions) {
		this.#baseUrl = new URL(options.baseUrl);
		if (this.#baseUrl.protocol !== "https:" && !isLocalhostUrl(this.#baseUrl)) {
			throw new Error("BridgeClient refuses bearer tokens over non-HTTPS bridge URLs");
		}
		if (isLocalhostUrl(this.#baseUrl) && !options.allowInsecureLocalhost) {
			throw new Error(
				"BridgeClient refuses bearer tokens over HTTP localhost unless allowInsecureLocalhost is true",
			);
		}
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	async handshake(request: BridgeHandshakeRequest): Promise<BridgeHandshakeResponse> {
		return this.#json<BridgeHandshakeResponse>("/v1/handshake", {
			method: "POST",
			body: JSON.stringify(request),
			headers: { "Content-Type": "application/json" },
		});
	}

	async command(command: BridgeClientCommand, sessionId: string, idempotencyKey: string): Promise<unknown> {
		return this.#json(`/v1/sessions/${encodeURIComponent(sessionId)}/commands`, {
			method: "POST",
			body: JSON.stringify(command),
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": idempotencyKey,
			},
		});
	}

	#command(
		type: BridgeClientCommand["type"],
		sessionId: string,
		fields: Record<string, unknown> = {},
		options: BridgeCommandOptions = {},
		prefix: string = type,
	): Promise<unknown> {
		return this.command(
			{ id: options.id, type, ...fields },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey(prefix),
		);
	}

	prompt(
		sessionId: string,
		message: string,
		options: {
			id?: string;
			images?: unknown[];
			streamingBehavior?: "steer" | "followUp";
			idempotencyKey?: string;
		} = {},
	): Promise<unknown> {
		return this.command(
			{
				id: options.id,
				type: "prompt",
				message,
				images: options.images,
				streamingBehavior: options.streamingBehavior,
			},
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("prompt"),
		);
	}

	steer(
		sessionId: string,
		message: string,
		options: { id?: string; images?: unknown[]; idempotencyKey?: string } = {},
	): Promise<unknown> {
		return this.command(
			{ id: options.id, type: "steer", message, images: options.images },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("steer"),
		);
	}

	followUp(
		sessionId: string,
		message: string,
		options: { id?: string; images?: unknown[]; idempotencyKey?: string } = {},
	): Promise<unknown> {
		return this.command(
			{ id: options.id, type: "follow_up", message, images: options.images },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("follow-up"),
		);
	}

	bash(sessionId: string, command: string, options: { id?: string; idempotencyKey?: string } = {}): Promise<unknown> {
		return this.command(
			{ id: options.id, type: "bash", command },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("bash"),
		);
	}

	getState(sessionId: string, options: { id?: string; idempotencyKey?: string } = {}): Promise<unknown> {
		return this.command(
			{ id: options.id, type: "get_state" },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("get-state"),
		);
	}

	getMessages(sessionId: string, options: { id?: string; idempotencyKey?: string } = {}): Promise<unknown> {
		return this.command(
			{ id: options.id, type: "get_messages" },
			sessionId,
			options.idempotencyKey ?? this.createIdempotencyKey("get-messages"),
		);
	}

	abort(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("abort", sessionId, {}, options);
	}

	abortAndPrompt(
		sessionId: string,
		message: string,
		options: { id?: string; images?: unknown[]; idempotencyKey?: string } = {},
	): Promise<unknown> {
		return this.#command(
			"abort_and_prompt",
			sessionId,
			{ message, images: options.images },
			options,
			"abort-and-prompt",
		);
	}

	newSession(sessionId: string, options: BridgeCommandOptions & { parentSession?: string } = {}): Promise<unknown> {
		return this.#command("new_session", sessionId, { parentSession: options.parentSession }, options, "new-session");
	}

	setTodos(sessionId: string, phases: unknown[], options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_todos", sessionId, { phases }, options, "set-todos");
	}

	setHostTools(sessionId: string, tools: unknown[], options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_host_tools", sessionId, { tools }, options, "set-host-tools");
	}

	setHostUriSchemes(sessionId: string, schemes: unknown[], options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_host_uri_schemes", sessionId, { schemes }, options, "set-host-uri-schemes");
	}

	getPendingWorkflowGates(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_pending_workflow_gates", sessionId, {}, options, "get-pending-workflow-gates");
	}

	setModel(
		sessionId: string,
		provider: string,
		modelId: string,
		options: BridgeCommandOptions = {},
	): Promise<unknown> {
		return this.#command("set_model", sessionId, { provider, modelId }, options, "set-model");
	}

	cycleModel(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("cycle_model", sessionId, {}, options, "cycle-model");
	}

	getAvailableModels(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_available_models", sessionId, {}, options, "get-available-models");
	}

	setThinkingLevel(sessionId: string, level: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_thinking_level", sessionId, { level }, options, "set-thinking-level");
	}

	cycleThinkingLevel(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("cycle_thinking_level", sessionId, {}, options, "cycle-thinking-level");
	}

	setSteeringMode(
		sessionId: string,
		mode: "all" | "one-at-a-time",
		options: BridgeCommandOptions = {},
	): Promise<unknown> {
		return this.#command("set_steering_mode", sessionId, { mode }, options, "set-steering-mode");
	}

	setFollowUpMode(
		sessionId: string,
		mode: "all" | "one-at-a-time",
		options: BridgeCommandOptions = {},
	): Promise<unknown> {
		return this.#command("set_follow_up_mode", sessionId, { mode }, options, "set-follow-up-mode");
	}

	setInterruptMode(
		sessionId: string,
		mode: "immediate" | "wait",
		options: BridgeCommandOptions = {},
	): Promise<unknown> {
		return this.#command("set_interrupt_mode", sessionId, { mode }, options, "set-interrupt-mode");
	}

	compact(sessionId: string, options: BridgeCommandOptions & { customInstructions?: string } = {}): Promise<unknown> {
		return this.#command("compact", sessionId, { customInstructions: options.customInstructions }, options);
	}

	setAutoCompaction(sessionId: string, enabled: boolean, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_auto_compaction", sessionId, { enabled }, options, "set-auto-compaction");
	}

	setAutoRetry(sessionId: string, enabled: boolean, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_auto_retry", sessionId, { enabled }, options, "set-auto-retry");
	}

	abortRetry(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("abort_retry", sessionId, {}, options, "abort-retry");
	}

	abortBash(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("abort_bash", sessionId, {}, options, "abort-bash");
	}

	getSessionStats(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_session_stats", sessionId, {}, options, "get-session-stats");
	}

	exportHtml(sessionId: string, options: BridgeCommandOptions & { outputPath?: string } = {}): Promise<unknown> {
		return this.#command("export_html", sessionId, { outputPath: options.outputPath }, options, "export-html");
	}

	switchSession(sessionId: string, sessionPath: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("switch_session", sessionId, { sessionPath }, options, "switch-session");
	}

	branch(sessionId: string, entryId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("branch", sessionId, { entryId }, options);
	}

	getBranchMessages(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_branch_messages", sessionId, {}, options, "get-branch-messages");
	}

	getLastAssistantText(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_last_assistant_text", sessionId, {}, options, "get-last-assistant-text");
	}

	setSessionName(sessionId: string, name: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("set_session_name", sessionId, { name }, options, "set-session-name");
	}

	handoff(sessionId: string, options: BridgeCommandOptions & { customInstructions?: string } = {}): Promise<unknown> {
		return this.#command("handoff", sessionId, { customInstructions: options.customInstructions }, options);
	}

	getLoginProviders(sessionId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("get_login_providers", sessionId, {}, options, "get-login-providers");
	}

	login(sessionId: string, providerId: string, options: BridgeCommandOptions = {}): Promise<unknown> {
		return this.#command("login", sessionId, { providerId }, options);
	}

	createIdempotencyKey(prefix = "cmd"): string {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	async *events(sessionId: string, lastSeq?: number): AsyncGenerator<BridgeFrame> {
		const response = await this.connectEvents(sessionId, lastSeq);
		if (!response.ok) throw new Error(`Bridge event stream failed: ${response.status}`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Bridge event stream response had no body");
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffered += decoder.decode(chunk.value, { stream: true });
				const parsed = parseSseData(buffered);
				buffered = parsed.rest;
				for (const frame of parsed.frames) yield frame;
			}
			buffered += decoder.decode();
			const parsed = parseSseData(buffered);
			for (const frame of parsed.frames) yield frame;
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
	claimControl(sessionId: string, ownerToken?: string): Promise<unknown> {
		return this.#json(`/v1/sessions/${encodeURIComponent(sessionId)}/control:claim`, {
			method: "POST",
			headers: ownerToken ? { "X-GJC-Bridge-Owner-Token": ownerToken } : undefined,
		});
	}
	disconnectControl(sessionId: string, ownerToken: string): Promise<unknown> {
		return this.#json(`/v1/sessions/${encodeURIComponent(sessionId)}/control:disconnect`, {
			method: "POST",
			headers: { "X-GJC-Bridge-Owner-Token": ownerToken },
		});
	}

	respondToUiRequest(
		sessionId: string,
		correlationId: string,
		ownerToken: string,
		response: unknown,
		idempotencyKey?: string,
	): Promise<unknown> {
		return this.#json(
			`/v1/sessions/${encodeURIComponent(sessionId)}/ui-responses/${encodeURIComponent(correlationId)}`,
			{
				method: "POST",
				body: JSON.stringify(response),
				headers: {
					"Content-Type": "application/json",
					"X-GJC-Bridge-Owner-Token": ownerToken,
					...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
				},
			},
		);
	}

	/**
	 * Answer a `workflow_gate` by posting to the UI-response endpoint and return
	 * the gate resolution envelope. Authorization is bearer auth plus the
	 * `control` scope; `ownerToken` is carried for idempotency/controller
	 * correlation, not as the gate authorization boundary.
	 */
	respondGate(
		sessionId: string,
		gateId: string,
		ownerToken: string,
		answer: unknown,
		options: { idempotencyKey?: string; id?: string } = {},
	): Promise<unknown> {
		return this.#json(`/v1/sessions/${encodeURIComponent(sessionId)}/ui-responses/${encodeURIComponent(gateId)}`, {
			method: "POST",
			body: JSON.stringify({ gate_id: gateId, answer, idempotency_key: options.idempotencyKey }),
			headers: {
				"Content-Type": "application/json",
				"X-GJC-Bridge-Owner-Token": ownerToken,
				...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
			},
		});
	}

	/**
	 * Headless policy: stream the session's frames, route every received
	 * `workflow_gate` to the agent `resolver`, and post its answer back. Yields
	 * each handled gate. The resolver supplies the agent's memory-backed answer.
	 */
	async *consumeWorkflowGates(
		sessionId: string,
		ownerToken: string,
		resolver: WorkflowGateResolver,
		options: { lastSeq?: number } = {},
	): AsyncGenerator<{ gate: WorkflowGate; answer: unknown }> {
		for await (const frame of this.events(sessionId, options.lastSeq)) {
			if (!isWorkflowGateFrame(frame)) continue;
			const gate = frame.payload as WorkflowGate;
			const answer = await resolver(gate);
			await this.respondGate(sessionId, gate.gate_id, ownerToken, answer);
			yield { gate, answer };
		}
	}

	respondToHostTool(sessionId: string, correlationId: string, result: unknown): Promise<unknown> {
		return this.#json(
			`/v1/sessions/${encodeURIComponent(sessionId)}/host-tool-results/${encodeURIComponent(correlationId)}`,
			{
				method: "POST",
				body: JSON.stringify(result),
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	respondToHostUri(sessionId: string, correlationId: string, result: unknown): Promise<unknown> {
		return this.#json(
			`/v1/sessions/${encodeURIComponent(sessionId)}/host-uri-results/${encodeURIComponent(correlationId)}`,
			{
				method: "POST",
				body: JSON.stringify(result),
				headers: { "Content-Type": "application/json" },
			},
		);
	}
	connectEvents(sessionId: string, lastSeq?: number): Promise<Response> {
		const path = `/v1/sessions/${encodeURIComponent(sessionId)}/events${lastSeq === undefined ? "" : `?last_seq=${lastSeq}`}`;
		return this.#request(path, { method: "GET" });
	}

	#request(pathname: string, init: RequestInit): Promise<Response> {
		const url = new URL(pathname, this.#baseUrl);
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.#token}`);
		return this.#fetch(url, { ...init, headers });
	}

	async #json<T>(pathname: string, init: RequestInit): Promise<T> {
		const response = await this.#request(pathname, init);
		if (!response.ok) {
			throw new Error(`Bridge request failed: ${response.status}`);
		}
		return (await response.json()) as T;
	}
}

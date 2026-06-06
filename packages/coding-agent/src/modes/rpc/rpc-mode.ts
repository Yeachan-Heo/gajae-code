/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { $env, readJsonl, Snowflake } from "@gajae-code/utils";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { initializeExtensions } from "../runtime-init";
import { dispatchRpcCommand } from "../shared/agent-wire/command-dispatch";
import { rpcError as error } from "../shared/agent-wire/responses";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcWorkflowGateEvent,
	RpcWorkflowGateResponse,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function schemaForWorkflowGate(request: Record<string, unknown>): Record<string, unknown> {
	const method = request.method;
	if (method === "confirm") return { type: "boolean" };
	if (method === "select") {
		const options = Array.isArray(request.options)
			? request.options.filter(option => typeof option === "string")
			: [];
		return options.length > 0 ? { type: "string", enum: options } : { type: "string" };
	}
	if (method === "input" || method === "editor") return { type: "string" };
	return {};
}

function workflowGateKindFor(request: Record<string, unknown>): RpcWorkflowGateEvent["kind"] {
	return request.method === "confirm" ? "approval" : "question";
}

function validateWorkflowGateAnswer(schema: Record<string, unknown>, value: unknown, path = "answer"): string | null {
	if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
		return `${path} must match one of the advertised enum values`;
	}
	if ("const" in schema && !Object.is(schema.const, value)) {
		return `${path} must match the advertised const value`;
	}
	const schemaType = schema.type;
	if (typeof schemaType === "string") {
		if (schemaType === "array") {
			if (!Array.isArray(value)) return `${path} must be an array`;
			const itemSchema = schema.items;
			if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
				for (let i = 0; i < value.length; i++) {
					const itemError = validateWorkflowGateAnswer(
						itemSchema as Record<string, unknown>,
						value[i],
						`${path}[${i}]`,
					);
					if (itemError) return itemError;
				}
			}
			return null;
		}
		if (schemaType === "object") {
			if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
			const record = value as Record<string, unknown>;
			if (Array.isArray(schema.required)) {
				for (const key of schema.required) {
					if (typeof key === "string" && !(key in record)) return `${path}.${key} is required`;
				}
			}
			const properties = schema.properties;
			if (properties && typeof properties === "object" && !Array.isArray(properties)) {
				for (const [key, propertySchema] of Object.entries(properties)) {
					if (
						!(key in record) ||
						!propertySchema ||
						typeof propertySchema !== "object" ||
						Array.isArray(propertySchema)
					)
						continue;
					const propertyError = validateWorkflowGateAnswer(
						propertySchema as Record<string, unknown>,
						record[key],
						`${path}.${key}`,
					);
					if (propertyError) return propertyError;
				}
			}
			if (schema.additionalProperties === false) {
				const allowed = new Set(Object.keys((properties as Record<string, unknown> | undefined) ?? {}));
				for (const key of Object.keys(record)) {
					if (!allowed.has(key)) return `${path}.${key} is not allowed`;
				}
			}
			return null;
		}
		if (schemaType === "integer") return Number.isInteger(value) ? null : `${path} must be an integer`;
		if (schemaType === "number")
			return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number`;
		if (schemaType === "string") return typeof value === "string" ? null : `${path} must be a string`;
		if (schemaType === "boolean") return typeof value === "boolean" ? null : `${path} must be a boolean`;
		if (schemaType === "null") return value === null ? null : `${path} must be null`;
	}
	return null;
}

function workflowGateResponseToExtensionResponse(response: RpcWorkflowGateResponse): RpcExtensionUIResponse {
	if (typeof response.answer === "boolean") {
		return { type: "extension_ui_response", id: response.gate_id, confirmed: response.answer };
	}
	return { type: "extension_ui_response", id: response.gate_id, value: String(response.answer) };
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const pendingWorkflowGates = new Map<string, Record<string, unknown>>();

	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | RpcWorkflowGateEvent | object) => void,
		) {}

		/** Helper for dialog methods with signal/timeout support */
		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingRequests.delete(id);
				pendingWorkflowGates.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => {
					opts.onTimeout?.();
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			const workflowSchema = schemaForWorkflowGate(request);
			pendingWorkflowGates.set(id, workflowSchema);
			const activeSkill = session.getActiveSkillState();
			const activePhase = session.getActiveSkillPhase();
			this.output({
				type: "workflow_gate",
				gate_id: id,
				stage: activeSkill?.skill
					? `${activeSkill.skill}:${activePhase ?? "unknown"}`
					: String(request.method ?? "ui"),
				kind: workflowGateKindFor(request),
				schema: workflowSchema,
				...(Array.isArray(request.options) ? { options: request.options as string[] } : {}),
				context: {
					method: request.method,
					...(typeof request.title === "string" ? { title: request.title } : {}),
					...(typeof request.message === "string" ? { message: request.message } : {}),
					...(typeof request.timeout === "number" ? { timeout: request.timeout } : {}),
					...(activeSkill?.skill ? { skill: activeSkill.skill } : {}),
					...(activePhase ? { phase: activePhase } : {}),
				},
			} satisfies RpcWorkflowGateEvent);
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);

			return promise;
		}

		select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "select", title, options, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "editor", title, prefill, promptStyle: editorOptions?.promptStyle },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	// Handle a single command through the shared agent-wire dispatcher so RPC
	// and bridge mode use one command surface.
	const handleCommand = (command: RpcCommand): Promise<RpcResponse> =>
		dispatchRpcCommand(command, {
			session,
			output,
			hostToolRegistry: hostToolBridge,
			hostUriRegistry: hostUriBridge,
			createUiContext: () => new RpcExtensionUIContext(pendingExtensionRequests, output),
		});

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownState.requested) return;

		if (session.extensionRunner?.hasHandlers("session_shutdown")) {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}

		process.exit(0);
	}

	// Listen for JSON input using Bun's stdin
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		try {
			// Handle extension UI responses
			if ((parsed as RpcExtensionUIResponse).type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pending.resolve(response);
				}
				continue;
			}

			if ((parsed as RpcWorkflowGateResponse).type === "workflow_gate_response") {
				const response = parsed as RpcWorkflowGateResponse;
				const schema = pendingWorkflowGates.get(response.gate_id);
				const pending = pendingExtensionRequests.get(response.gate_id);
				if (!schema || !pending) {
					output({
						...error(response.id, "workflow_gate_response", `workflow gate not found: ${response.gate_id}`),
						errorCode: "workflow_gate_not_found",
					});
					continue;
				}
				const validationError = validateWorkflowGateAnswer(schema, response.answer);
				if (validationError) {
					output({
						...error(response.id, "workflow_gate_response", `invalid_workflow_gate_response: ${validationError}`),
						errorCode: "invalid_workflow_gate_response",
					});
					continue;
				}
				pending.resolve(workflowGateResponseToExtensionResponse(response));
				output({ id: response.id, type: "response", command: "workflow_gate_response", success: true });
				continue;
			}

			if (isRpcHostToolResult(parsed)) {
				hostToolBridge.handleResult(parsed);
				continue;
			}

			if (isRpcHostToolUpdate(parsed)) {
				hostToolBridge.handleUpdate(parsed);
				continue;
			}

			if (isRpcHostUriResult(parsed)) {
				hostUriBridge.handleResult(parsed);
				continue;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: any) {
			output(error(undefined, "parse", `Failed to parse command: ${e.message}`));
		}
	}

	// stdin closed — RPC client is gone, exit cleanly
	hostToolBridge.rejectAllPending("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	process.exit(0);
}

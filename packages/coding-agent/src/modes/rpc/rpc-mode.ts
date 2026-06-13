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
import * as path from "node:path";
import { $env, readLines, Snowflake } from "@gajae-code/utils";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { initializeExtensions } from "../runtime-init";
import { dispatchRpcCommand } from "../shared/agent-wire/command-dispatch";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../shared/agent-wire/event-envelope";
import { rpcError as error } from "../shared/agent-wire/responses";
import { defaultAuditPath, UnattendedAuditLog } from "../shared/agent-wire/unattended-audit";
import { UnattendedSessionControlPlane } from "../shared/agent-wire/unattended-session";
import { FileGateStore } from "../shared/agent-wire/workflow-gate-broker";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcResponse,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

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

function auditOutcomeFor(event: string): "accepted" | "rejected" | "denied" | "exceeded" | "aborted" | "info" {
	if (event.includes("denied")) return "denied";
	if (event.includes("exceeded")) return "exceeded";
	if (event.includes("abort")) return "aborted";
	if (event.includes("rejected") || event.includes("conflict")) return "rejected";
	if (event.includes("accepted") || event.includes("negotiated") || event.includes("emitted")) return "accepted";
	return "info";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
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
	const decodeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const auditLog = new UnattendedAuditLog(defaultAuditPath(session.sessionId, session.sessionManager.getCwd()), {
		redactAnswers: true,
	});
	const recordAudit = (event: { event: string; [key: string]: unknown }) => {
		const payload =
			typeof event.payload === "object" && event.payload !== null
				? (event.payload as Record<string, unknown>)
				: undefined;
		const gateId =
			typeof event.gate_id === "string"
				? event.gate_id
				: typeof payload?.gate_id === "string"
					? payload.gate_id
					: undefined;
		auditLog.record({
			run_id: session.sessionId,
			session_id: session.sessionId,
			actor: typeof event.actor === "string" ? event.actor : undefined,
			event: event.event,
			outcome: auditOutcomeFor(event.event),
			dedupe_key: `${event.event}:${gateId ?? "run"}:${JSON.stringify(payload ?? event)}`,
			gate_id: gateId,
			stage: typeof event.stage === "string" ? (event.stage as never) : undefined,
			kind: typeof event.kind === "string" ? (event.kind as never) : undefined,
			scope: typeof payload?.scope === "string" ? payload.scope : undefined,
			action: typeof payload?.action === "string" ? payload.action : undefined,
			budget: event.event === "budget_exceeded" ? (payload as never) : undefined,
			answer_hash: typeof event.answer_hash === "string" ? event.answer_hash : undefined,
			error: payload && event.event.endsWith("denied") ? payload : undefined,
		});
	};
	// Unattended control plane (#318/#319/#323/G011): routes negotiate_unattended +
	// workflow_gate_response and lets skill runtimes emit gates over RPC.
	const gateStore = new FileGateStore(
		path.join(session.sessionManager.getCwd(), ".gjc", "state", "workflow-gates", `${session.sessionId}.json`),
	);
	const unattendedControlPlane = new UnattendedSessionControlPlane({
		runId: session.sessionId,
		sessionId: session.sessionId,
		emitFrame: gate => output(gate),
		store: gateStore,
		audit: recordAudit,
		getUsageSnapshot: () => {
			const stats = session.getSessionStats();
			return { tokens: stats.tokens.total, costUsd: stats.cost };
		},
	});
	unattendedControlPlane
		.recover()
		.catch(err =>
			output(error(undefined, "workflow_gate_recover", err instanceof Error ? err.message : String(err))),
		);
	session.setWorkflowGateEmitter(unattendedControlPlane);

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };
	let shutdownStarted = false;
	async function shutdown(exitCode: number, reason: string): Promise<never> {
		if (shutdownStarted) {
			process.exit(exitCode);
		}
		shutdownStarted = true;
		hostToolBridge.rejectAllPending(`${reason} before host tool execution completed`);
		hostUriBridge.clear(`${reason} before host URI request completed`);
		try {
			await session.sessionManager.ensureOnDisk();
		} catch (err) {
			output(error(undefined, "shutdown", decodeError(err)));
			process.exit(1);
		}
		try {
			await session.dispose();
		} catch (err) {
			output(error(undefined, "shutdown", decodeError(err)));
			process.exit(1);
		}
		process.exit(exitCode);
	}

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
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
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
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

	// Output all agent events as canonical agent-wire `event` frames (docs/rpc.md):
	// { type:"event", protocol_version, session_id, seq, frame_id, payload:{ event_type, event } }.
	const eventSequencer = new AgentWireFrameSequencer(session.sessionId);
	session.subscribe(event => {
		output(toAgentWireEventFrame(event, eventSequencer));
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
			unattendedControlPlane,
		});

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownState.requested) return;
		await shutdown(0, "RPC shutdown requested");
	}

	// Listen for JSONL input using Bun's stdin. Parse frame-by-frame so a malformed
	// command reports a parse error without poisoning the whole long-lived RPC session.
	const inputDecoder = new TextDecoder("utf-8", { fatal: false });
	for await (const line of readLines(Bun.stdin.stream())) {
		const text = inputDecoder.decode(line).trim();
		if (!text) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			output(error(undefined, "parse", `Failed to parse command: ${decodeError(err)}`));
			continue;
		}

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
		} catch (err) {
			output(error(undefined, "parse", `Failed to parse command: ${decodeError(err)}`));
		}
	}

	// stdin closed — RPC client is gone, flush durable state and exit cleanly
	await shutdown(0, "RPC client disconnected");
	throw new Error("RPC shutdown returned unexpectedly");
}

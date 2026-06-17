import type { AgentMessage } from "@gajae-code/agent-core";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcWorkflowGate,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import type { RpcBackendConfig, RpcBackendPort, RpcBackendState } from "./types";

type RpcLifecycleEvent = { type: string; [key: string]: unknown };

type RpcClientWithTransportError = RpcClient & { onTransportError?: (listener: (error: Error) => void) => () => void };
type RpcClientWithPr4 = RpcClient & {
	respondExtensionUi(response: RpcExtensionUIResponse): void;
	getPendingWorkflowGates(): Promise<RpcWorkflowGate[]>;
};

type SocketSecurityModule = { assertSafeClientSocket(socketPath: string): Promise<void> };

async function validateClientSocket(socketPath: string): Promise<void> {
	const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
	const security = (await importer("@gajae-code/coding-agent/modes/rpc/rpc-socket-security")) as SocketSecurityModule;
	await security.assertSafeClientSocket(socketPath);
}

export class RpcBackend implements RpcBackendPort {
	readonly #config: RpcBackendConfig;
	#client: RpcClient | null = null;
	#connected = false;
	#socketPath: string;
	#eventListeners = new Set<(event: RpcLifecycleEvent) => void>();
	#transportErrorListeners = new Set<(error: Error) => void>();
	#commandIgnoredListeners = new Set<(error: Error) => void>();
	#extensionUiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
	#workflowGateListeners = new Set<(gate: RpcWorkflowGate) => void>();
	#unsubscribeExtensionUi: (() => void) | null = null;
	#unsubscribeWorkflowGate: (() => void) | null = null;
	#unsubscribeEvents: (() => void) | null = null;
	#unsubscribeTransportError: (() => void) | null = null;

	constructor(config: RpcBackendConfig) {
		this.#config = config;
		this.#socketPath = config.socketPath;
	}

	async connect(socketPath = this.#config.socketPath): Promise<void> {
		await validateClientSocket(socketPath);
		this.#socketPath = socketPath;
		const client = new RpcClient({
			transport: "uds",
			socketPath,
			onTransportError: (error: Error) => this.#emitTransportError(error),
		} as ConstructorParameters<typeof RpcClient>[0] & { transport: "uds"; socketPath: string });
		this.#unsubscribeEvents = client.onEvent(event => this.#emitEvent(event as RpcLifecycleEvent));
		this.#unsubscribeTransportError =
			(client as RpcClientWithTransportError).onTransportError?.((error: Error) =>
				this.#emitTransportError(error),
			) ?? null;
		this.#unsubscribeExtensionUi = client.onExtensionUiRequest(request => this.#emitExtensionUi(request));
		this.#unsubscribeWorkflowGate = client.onWorkflowGate(gate => this.#emitWorkflowGate(gate));
		await client.start();
		console.warn("gtr_rpc_backend_connect", { socket: "set" });
		this.#client = client;
		this.#connected = true;
	}

	async close(): Promise<void> {
		this.#unsubscribeEvents?.();
		this.#unsubscribeTransportError?.();
		this.#unsubscribeExtensionUi?.();
		this.#unsubscribeWorkflowGate?.();
		this.#unsubscribeEvents = null;
		this.#unsubscribeTransportError = null;
		this.#unsubscribeExtensionUi = null;
		this.#unsubscribeWorkflowGate = null;
		this.#client?.stop();
		this.#client = null;
		this.#connected = false;
	}

	async getState(): Promise<RpcBackendState> {
		const session = this.#client ? await this.#client.getState().catch(() => undefined) : undefined;
		return { connected: this.#connected, socketPath: this.#socketPath, session };
	}

	async prompt(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().prompt(message));
	}

	async steer(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().steer(message));
	}

	async abort(): Promise<void> {
		await this.#callCommand(() => this.#requireClient().abort());
	}

	async abortAndPrompt(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().abortAndPrompt(message));
	}

	respondExtensionUi(response: RpcExtensionUIResponse): void {
		(this.#requireClient() as RpcClientWithPr4).respondExtensionUi(response);
	}

	async respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown> {
		return this.#requireClient().respondGate(gateId, answer, idempotencyKey);
	}

	async getPendingWorkflowGates(): Promise<RpcWorkflowGate[]> {
		return (this.#requireClient() as RpcClientWithPr4).getPendingWorkflowGates();
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.#requireClient().getMessages();
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#requireClient().getLastAssistantText();
	}

	onEvents(listener: (event: RpcLifecycleEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onTransportError(listener: (error: Error) => void): () => void {
		this.#transportErrorListeners.add(listener);
		return () => this.#transportErrorListeners.delete(listener);
	}

	onCommandIgnored(listener: (error: Error) => void): () => void {
		this.#commandIgnoredListeners.add(listener);
		return () => this.#commandIgnoredListeners.delete(listener);
	}

	onExtensionUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}

	onWorkflowGate(listener: (gate: RpcWorkflowGate) => void): () => void {
		this.#workflowGateListeners.add(listener);
		return () => this.#workflowGateListeners.delete(listener);
	}

	#requireClient(): RpcClient {
		if (!this.#client || !this.#connected) throw new Error("rpc_backend_not_connected");
		return this.#client;
	}

	async #callCommand(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (/timeout|ignored/i.test(normalized.message)) this.#emitCommandIgnored(normalized);
			throw normalized;
		}
	}

	#emitEvent(event: RpcLifecycleEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	#emitExtensionUi(request: RpcExtensionUIRequest): void {
		for (const listener of this.#extensionUiListeners) listener(request);
	}

	#emitWorkflowGate(gate: RpcWorkflowGate): void {
		for (const listener of this.#workflowGateListeners) listener(gate);
	}

	#emitTransportError(error: Error): void {
		console.warn("gtr_rpc_backend_disconnect", { reason: "transport_error" });
		this.#connected = false;
		for (const listener of this.#transportErrorListeners) listener(error);
	}

	#emitCommandIgnored(error: Error): void {
		console.warn("gtr_rpc_backend_controller_lost", {});
		this.#connected = false;
		for (const listener of this.#commandIgnoredListeners) listener(error);
	}
}

export class FakeRpcBackend implements RpcBackendPort {
	connected = false;
	connectCalls = 0;
	closeCalls = 0;
	calls: Array<{
		method:
			| "connect"
			| "close"
			| "getState"
			| "prompt"
			| "steer"
			| "abort"
			| "abortAndPrompt"
			| "respondExtensionUi"
			| "respondGate"
			| "getPendingWorkflowGates"
			| "getMessages"
			| "getLastAssistantText";
		args?: unknown;
	}> = [];
	state: RpcBackendState;
	transportErrorListeners = new Set<(error: Error) => void>();
	commandIgnoredListeners = new Set<(error: Error) => void>();
	extensionUiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
	workflowGateListeners = new Set<(gate: RpcWorkflowGate) => void>();
	eventListeners = new Set<(event: RpcLifecycleEvent) => void>();
	pendingWorkflowGates: RpcWorkflowGate[] = [];
	messages: AgentMessage[] = [];
	lastAssistantText: string | null = null;

	constructor(socketPath = "/tmp/gjc-rpc.sock") {
		this.state = { connected: false, socketPath };
	}

	async connect(socketPath?: string): Promise<void> {
		this.calls.push({ method: "connect", args: socketPath });
		this.connectCalls += 1;
		this.connected = true;
		this.state = { ...this.state, connected: true, socketPath: socketPath ?? this.state.socketPath };
	}

	async close(): Promise<void> {
		this.calls.push({ method: "close" });
		this.closeCalls += 1;
		this.connected = false;
		this.state = { ...this.state, connected: false };
	}

	async getState(): Promise<RpcBackendState> {
		this.calls.push({ method: "getState" });
		return { ...this.state };
	}

	async prompt(message: string): Promise<void> {
		this.calls.push({ method: "prompt", args: message });
	}

	async steer(message: string): Promise<void> {
		this.calls.push({ method: "steer", args: message });
	}

	async abort(): Promise<void> {
		this.calls.push({ method: "abort" });
	}

	async abortAndPrompt(message: string): Promise<void> {
		this.calls.push({ method: "abortAndPrompt", args: message });
	}

	failRespondExtensionUi = false;
	respondExtensionUi(response: RpcExtensionUIResponse): void {
		if (this.failRespondExtensionUi) throw new Error("write failed");
		this.calls.push({ method: "respondExtensionUi", args: response });
	}

	async respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown> {
		this.calls.push({ method: "respondGate", args: { gateId, answer, idempotencyKey } });
		return { gate_id: gateId, accepted: true };
	}

	async getPendingWorkflowGates(): Promise<RpcWorkflowGate[]> {
		this.calls.push({ method: "getPendingWorkflowGates" });
		return [...this.pendingWorkflowGates];
	}

	async getMessages(): Promise<AgentMessage[]> {
		this.calls.push({ method: "getMessages" });
		return [...this.messages];
	}

	async getLastAssistantText(): Promise<string | null> {
		this.calls.push({ method: "getLastAssistantText" });
		return this.lastAssistantText;
	}

	onExtensionUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUiListeners.add(listener);
		return () => this.extensionUiListeners.delete(listener);
	}

	onWorkflowGate(listener: (gate: RpcWorkflowGate) => void): () => void {
		this.workflowGateListeners.add(listener);
		return () => this.workflowGateListeners.delete(listener);
	}

	onEvents(listener: (event: RpcLifecycleEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	emitExtensionUiRequest(request: RpcExtensionUIRequest): void {
		for (const listener of this.extensionUiListeners) listener(request);
	}

	emitWorkflowGate(gate: RpcWorkflowGate): void {
		for (const listener of this.workflowGateListeners) listener(gate);
	}

	emitEvent(event: RpcLifecycleEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}

	onTransportError(listener: (error: Error) => void): () => void {
		this.transportErrorListeners.add(listener);
		return () => this.transportErrorListeners.delete(listener);
	}

	onCommandIgnored(listener: (error: Error) => void): () => void {
		this.commandIgnoredListeners.add(listener);
		return () => this.commandIgnoredListeners.delete(listener);
	}

	emitTransportError(error = new Error("transport_error")): void {
		for (const listener of this.transportErrorListeners) listener(error);
	}

	emitCommandIgnored(error = new Error("command ignored")): void {
		for (const listener of this.commandIgnoredListeners) listener(error);
	}

	countOf(method: (typeof this.calls)[number]["method"]): number {
		return this.calls.filter(call => call.method === method).length;
	}
}

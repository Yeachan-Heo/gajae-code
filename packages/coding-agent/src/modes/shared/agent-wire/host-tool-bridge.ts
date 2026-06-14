import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Static, TSchema } from "@gajae-code/ai";
import { Snowflake } from "@gajae-code/utils";
import { applyToolProxy } from "../../../extensibility/tool-proxy";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "../../rpc/rpc-types";
import type { Theme } from "../../theme/theme";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.every(item => !!item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string")
	);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown; isError?: unknown };
	return (
		frame.type === "host_tool_result" &&
		typeof frame.id === "string" &&
		isAgentToolResult(frame.result) &&
		(frame.isError === undefined || typeof frame.isError === "boolean")
	);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme>
	implements AgentTool<TParams, unknown, TTheme>
{
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#pendingCalls = new Map<string, PendingHostToolCall>();

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	setTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		if (tools.some(tool => tool.name === "ask")) {
			throw new Error('RPC host tool "ask" is reserved and cannot be supplied by the host');
		}
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		return tools.map(tool => new RpcHostToolAdapter(tool, this));
	}

	handleResult(frame: RpcHostToolResult): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
		});

		this.#output({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
		});

		return promise;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(error);
		}
	}
}

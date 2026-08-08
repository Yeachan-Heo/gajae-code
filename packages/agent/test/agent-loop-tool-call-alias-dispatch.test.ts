import { afterEach, describe, expect, it, vi } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { logger } from "@gajae-code/utils";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

type QuerySchema = z.ZodObject<{ query: z.ZodString }>;
type QueryTool = AgentTool<QuerySchema, Record<string, never>>;

/**
 * A proxied bridge exposes the session's tools under `mcp__<server>__<instance>_<tool>`
 * and mints a fresh instance segment per session. The registry knows both names a
 * tool is reachable under — the harness-internal one and the bridge-qualified one —
 * and that pair is what proves where the instance segment ends and the tool name
 * begins. Without it `mcp__brave__web_search` is indistinguishable from a stale
 * `search`, so it is not dispatched at all.
 */
function bridgeForm(base: string, instance = "wbg7pcrl46bd"): string {
	return `mcp__jzi2uzmxd57z__${instance}_${base}`;
}

/** Stale name a model replays after the bridge minted a new instance segment. */
const STALE_SEARCH_CALL = bridgeForm("search", "mr6er53iidr3");

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeQueryTool(
	name: string,
	options: { customWireName?: string; onExecute?: (args: { query: string }) => void } = {},
): QueryTool {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({ query: z.string() }),
		...(options.customWireName === undefined ? {} : { customWireName: options.customWireName }),
		async execute(_toolCallId, args) {
			options.onExecute?.(args);
			return { content: [{ type: "text", text: `${name}:${args.query}` }], details: {} };
		},
	};
}

async function runToolCall(
	tools: QueryTool[],
	toolCall: { name: string; arguments: Record<string, unknown> },
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>,
): Promise<Array<{ toolName: string; isError?: boolean; text: string }>> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tc-1", name: toolCall.name, arguments: toolCall.arguments }] },
			{ content: ["recovered"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...(beforeToolCall === undefined ? {} : { beforeToolCall }),
	};
	const results: Array<{ toolName: string; isError?: boolean; text: string }> = [];
	const stream = agentLoop([createUserMessage("do the thing")], context, config, undefined, mock.stream);
	for await (const event of stream) {
		if (event.type === "tool_execution_end") {
			const first = event.result.content?.[0];
			results.push({
				toolName: event.toolName,
				isError: event.isError,
				text: first?.type === "text" ? first.text : "",
			});
		}
	}
	return results;
}

describe("agentLoop: unresolvable tool call names with exactly one active match", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("executes the resolved tool instead of rejecting the call", async () => {
		const executed: Array<{ query: string }> = [];
		const results = await runToolCall(
			[
				makeQueryTool("search", {
					customWireName: bridgeForm("search"),
					onExecute: args => executed.push(args),
				}),
				makeQueryTool("read"),
			],
			{ name: STALE_SEARCH_CALL, arguments: { query: "alpha" } },
		);

		expect(executed).toEqual([{ query: "alpha" }]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toBe("search:alpha");
		expect(results[0].toolName).toBe("search");
	});

	// The reported failure named `todo_write`: the base name itself contains the
	// separator, so only the bridge prefix may be stripped.
	it("resolves a base name that contains underscores", async () => {
		const executed: Array<{ query: string }> = [];
		const results = await runToolCall(
			[
				makeQueryTool("todo_write", {
					customWireName: bridgeForm("todo_write"),
					onExecute: args => executed.push(args),
				}),
			],
			{
				name: bridgeForm("todo_write", "mr6er53iidr3"),
				arguments: { query: "init" },
			},
		);

		expect(executed).toEqual([{ query: "init" }]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toBe("todo_write:init");
		expect(results[0].toolName).toBe("todo_write");
	});

	it("logs the redirect with the requested and resolved names", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});

		await runToolCall([makeQueryTool("search", { customWireName: bridgeForm("search") })], {
			name: STALE_SEARCH_CALL,
			arguments: { query: "beta" },
		});

		const redirects = info.mock.calls.filter(call => call[0] === "Tool call renamed to its single active alias");
		expect(redirects).toHaveLength(1);
		expect(redirects[0][1]).toEqual({
			toolCallId: "tc-1",
			requestedName: STALE_SEARCH_CALL,
			resolvedName: "search",
		});
	});

	it("does not log a redirect for a call name that already resolves", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});

		const results = await runToolCall([makeQueryTool("search")], {
			name: "search",
			arguments: { query: "gamma" },
		});

		expect(results[0].text).toBe("search:gamma");
		expect(info.mock.calls.filter(call => call[0] === "Tool call renamed to its single active alias")).toHaveLength(
			0,
		);
	});

	it("validates arguments against the resolved tool's schema", async () => {
		const executed: Array<{ query: string }> = [];
		const results = await runToolCall(
			[
				makeQueryTool("search", {
					customWireName: bridgeForm("search"),
					onExecute: args => executed.push(args),
				}),
			],
			{
				name: STALE_SEARCH_CALL,
				arguments: { query: 42 },
			},
		);

		expect(executed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain('Validation failed for tool "search"');
		expect(results[0].text).not.toContain("not found");
	});

	it("runs beforeToolCall against the resolved tool and honours a block", async () => {
		const executed: Array<{ query: string }> = [];
		const seen: Array<{ name: string; args: unknown }> = [];
		const results = await runToolCall(
			[
				makeQueryTool("search", {
					customWireName: bridgeForm("search"),
					onExecute: args => executed.push(args),
				}),
			],
			{ name: STALE_SEARCH_CALL, arguments: { query: "delta" } },
			context => {
				seen.push({ name: context.toolCall.name, args: context.args });
				return { block: true, reason: "denied by policy" };
			},
		);

		expect(seen).toEqual([{ name: "search", args: { query: "delta" } }]);
		expect(executed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("denied by policy");
	});

	// The bridge-qualified form the registry knows can be the customWireName: the
	// pair still proves that only the instance segment went stale.
	it("dispatches a stale call name via a bridge form exposed as customWireName", async () => {
		const executed: Array<{ query: string }> = [];
		const results = await runToolCall(
			[
				makeQueryTool("internal_edit", {
					customWireName: "mcp__srv__abc_internal_edit",
					onExecute: args => executed.push(args),
				}),
			],
			{ name: "mcp__srv__stale_internal_edit", arguments: { query: "epsilon" } },
		);

		expect(executed).toEqual([{ query: "epsilon" }]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toBe("internal_edit:epsilon");
	});

	// Two candidates are a guess, and guessing routes the model at the wrong
	// server's tool — strictly worse than the dead end it replaces.
	it("never guesses between two candidates", async () => {
		const executed: string[] = [];
		const results = await runToolCall(
			[
				makeQueryTool("mcp__srv__abc_search", { onExecute: () => executed.push("abc") }),
				makeQueryTool("mcp__srv__xyz_search", { onExecute: () => executed.push("xyz") }),
			],
			{ name: "mcp__srv__stale_search", arguments: { query: "zeta" } },
		);

		expect(executed).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool mcp__srv__stale_search not found");
	});
});

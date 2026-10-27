import { describe, expect, test } from "bun:test";
import { listPrompts, listResources, listResourceTemplates, listTools } from "../src/runtime-mcp/client";
import type {
	MCPRequestOptions,
	MCPServerCapabilities,
	MCPServerConnection,
	MCPTransport,
} from "../src/runtime-mcp/types";
import { MCPExpectedFailure } from "../src/runtime-mcp/types";
import { createMockConnection } from "./mcp-test-utils";

type ListFunction = (connection: MCPServerConnection, options?: MCPRequestOptions) => Promise<unknown[]>;

interface Endpoint {
	method: string;
	key: string;
	capabilities: MCPServerCapabilities;
	list: ListFunction;
	item: Record<string, unknown>;
	cache(connection: MCPServerConnection): unknown;
}

const endpoints: Endpoint[] = [
	{
		method: "tools/list",
		key: "tools",
		capabilities: { tools: {} },
		list: listTools,
		item: { name: "tool", inputSchema: { type: "object" } },
		cache: connection => connection.tools,
	},
	{
		method: "resources/list",
		key: "resources",
		capabilities: { resources: {} },
		list: listResources,
		item: { uri: "test://resource", name: "resource" },
		cache: connection => connection.resources,
	},
	{
		method: "resources/templates/list",
		key: "resourceTemplates",
		capabilities: { resources: {} },
		list: listResourceTemplates,
		item: { uriTemplate: "test://{id}", name: "template" },
		cache: connection => connection.resourceTemplates,
	},
	{
		method: "prompts/list",
		key: "prompts",
		capabilities: { prompts: {} },
		list: listPrompts,
		item: { name: "prompt" },
		cache: connection => connection.prompts,
	},
];

function page(endpoint: Endpoint, items: unknown[], nextCursor?: string): Record<string, unknown> {
	return { [endpoint.key]: items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function transport(
	responses: unknown[] | ((call: number, options?: MCPRequestOptions) => unknown),
	calls: Array<{ params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> = [],
): MCPTransport {
	return {
		connected: true,
		async request<T>(_method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
			const call = calls.length;
			calls.push({ params, options });
			return (typeof responses === "function" ? responses(call, options) : responses[call]) as T;
		},
		async notify() {},
		async close() {},
	};
}

function expected(method: string, detail: string): MCPExpectedFailure {
	return new MCPExpectedFailure(new Error(`MCP ${method} pagination ${detail}`));
}

describe("MCP list pagination limits", () => {
	for (const endpoint of endpoints) {
		test(`${endpoint.method} forwards cursors/options and caches by identity`, async () => {
			const calls: Array<{
				params: Record<string, unknown> | undefined;
				options: MCPRequestOptions | undefined;
			}> = [];
			const signal = new AbortController().signal;
			const options = { signal };
			const connection = createMockConnection(
				endpoint.capabilities,
				transport([page(endpoint, [endpoint.item], "Next"), page(endpoint, [endpoint.item])], calls),
			);
			const first = await endpoint.list(connection, options);
			const second = await endpoint.list(connection, options);
			expect(first).toHaveLength(2);
			expect(second).toBe(first);
			expect(endpoint.cache(connection)).toBe(first);
			expect(calls.map(call => call.params)).toEqual([{}, { cursor: "Next" }]);
			expect(calls.every(call => call.options === options && call.options.signal === signal)).toBe(true);
		});

		test(`${endpoint.method} rejects an immediate repeated cursor`, async () => {
			const connection = createMockConnection(
				endpoint.capabilities,
				transport([page(endpoint, [], "secret"), page(endpoint, [], "secret")]),
			);
			await expect(endpoint.list(connection)).rejects.toEqual(expected(endpoint.method, "repeated a cursor"));
			expect(endpoint.cache(connection)).toBeUndefined();
		});
	}

	test("detects a longer cursor cycle before budgets", async () => {
		const endpoint = endpoints[0];
		const connection = createMockConnection(
			endpoint.capabilities,
			transport([page(endpoint, [], "A"), page(endpoint, [], "B"), page(endpoint, [], "A")]),
		);
		await expect(endpoint.list(connection)).rejects.toEqual(expected(endpoint.method, "repeated a cursor"));
	});

	test("treats an empty cursor as terminal", async () => {
		const endpoint = endpoints[1];
		const calls: Array<{ params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> = [];
		const connection = createMockConnection(
			endpoint.capabilities,
			transport([page(endpoint, [endpoint.item], "")], calls),
		);
		expect(await endpoint.list(connection)).toEqual([endpoint.item]);
		expect(calls).toHaveLength(1);
	});

	test.each([false, true])("enforces the page boundary (continuation=%s)", async continuation => {
		const endpoint = endpoints[0];
		const calls: Array<{ params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> = [];
		const responses = Array.from({ length: 100 }, (_, index) =>
			page(endpoint, [], index === 99 && !continuation ? undefined : `cursor-${index + 1}`),
		);
		const connection = createMockConnection(endpoint.capabilities, transport(responses, calls));
		if (continuation) {
			await expect(endpoint.list(connection)).rejects.toEqual(
				expected(endpoint.method, "did not complete within the 100-page budget"),
			);
			expect(endpoint.cache(connection)).toBeUndefined();
		} else {
			expect(await endpoint.list(connection)).toEqual([]);
		}
		expect(calls).toHaveLength(100);
	});

	test.each([
		[10_000, false, true],
		[10_000, true, false],
		[10_001, false, false],
	])("enforces the item boundary (%i items, continuation=%s)", async (count, continuation, succeeds) => {
		const endpoint = endpoints[3];
		const calls: Array<{ params: Record<string, unknown> | undefined; options: MCPRequestOptions | undefined }> = [];
		const connection = createMockConnection(
			endpoint.capabilities,
			transport([page(endpoint, Array(count).fill(endpoint.item), continuation ? "more" : undefined)], calls),
		);
		if (succeeds) {
			expect(await endpoint.list(connection)).toHaveLength(10_000);
		} else {
			await expect(endpoint.list(connection)).rejects.toEqual(
				expected(endpoint.method, "did not complete within the 10000-item budget"),
			);
			expect(endpoint.cache(connection)).toBeUndefined();
		}
		expect(calls).toHaveLength(1);
	});

	test("counts duplicate items toward the budget", async () => {
		const endpoint = endpoints[2];
		const connection = createMockConnection(
			endpoint.capabilities,
			transport([
				page(endpoint, Array(5_001).fill(endpoint.item), "more"),
				page(endpoint, Array(5_000).fill(endpoint.item)),
			]),
		);
		await expect(endpoint.list(connection)).rejects.toEqual(
			expected(endpoint.method, "did not complete within the 10000-item budget"),
		);
	});

	test("preserves abort rejection and leaves cache unset", async () => {
		const endpoint = endpoints[0];
		const controller = new AbortController();
		const reason = new Error("stop now");
		controller.abort(reason);
		const connection = createMockConnection(
			endpoint.capabilities,
			transport((_call, options) => {
				throw options?.signal?.reason;
			}),
		);
		await expect(endpoint.list(connection, { signal: controller.signal })).rejects.toBe(reason);
		expect(endpoint.cache(connection)).toBeUndefined();
	});

	for (const endpoint of endpoints.slice(1)) {
		test.each([
			null,
			{},
			{ [endpoint.key]: {} },
			{ [endpoint.key]: [], nextCursor: 1 },
		])(`${endpoint.method} rejects malformed envelope %#`, async malformed => {
			const connection = createMockConnection(endpoint.capabilities, transport([malformed]));
			await expect(endpoint.list(connection)).rejects.toBeInstanceOf(MCPExpectedFailure);
			expect(endpoint.cache(connection)).toBeUndefined();
		});
	}
});

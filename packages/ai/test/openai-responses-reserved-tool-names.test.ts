import { describe, expect, it } from "bun:test";
import { convertTools, resolveReservedToolNames } from "../src/providers/openai-responses";
import type { Model, Tool } from "../src/types";

/**
 * OpenCode Zen/Go reserve `web_search` for their own built-in and reject it as a
 * custom function declaration with a request-scoped 400:
 *
 *   invalid tools in request: custom function name "web_search" is reserved
 *
 * One colliding declaration fails the entire tools array before any token
 * streams, so every agent carrying that tool (critic/planner/architect) is
 * permanently broken on the provider.
 */

function model(provider: string, compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> {
	return {
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-responses",
		provider,
		baseUrl: "https://opencode.ai/zen/v1",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 500_000,
		...(compat ? { compat } : {}),
	} as Model<"openai-responses">;
}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } as Tool;
}

const TOOLS = [tool("read"), tool("web_search"), tool("bash")];

describe("resolveReservedToolNames", () => {
	it("reserves web_search on opencode-go", () => {
		expect(resolveReservedToolNames(model("opencode-go"))).toEqual(["web_search"]);
	});

	it("reserves web_search on opencode-zen", () => {
		expect(resolveReservedToolNames(model("opencode-zen"))).toEqual(["web_search"]);
	});

	it("reserves nothing on unrelated providers", () => {
		expect(resolveReservedToolNames(model("openai"))).toEqual([]);
	});

	it("lets an explicit compat override replace the provider default", () => {
		const compat = { reservedToolNames: ["bash"] } as Model<"openai-responses">["compat"];
		expect(resolveReservedToolNames(model("opencode-go", compat))).toEqual(["bash"]);
	});

	it("lets an explicit empty compat override opt out of the provider default", () => {
		const compat = { reservedToolNames: [] } as Model<"openai-responses">["compat"];
		expect(resolveReservedToolNames(model("opencode-go", compat))).toEqual([]);
	});
});

describe("convertTools reserved-name handling", () => {
	it("omits the reserved declaration so the request is accepted", () => {
		const names = convertTools(TOOLS, false, model("opencode-go")).map(t => (t as { name: string }).name);
		expect(names).toEqual(["read", "bash"]);
	});

	it("keeps every non-reserved tool intact", () => {
		const converted = convertTools(TOOLS, false, model("opencode-go"));
		expect(converted).toHaveLength(2);
		expect((converted[0] as { type: string }).type).toBe("function");
	});

	it("declares web_search normally on providers that do not reserve it", () => {
		const names = convertTools(TOOLS, false, model("openai")).map(t => (t as { name: string }).name);
		expect(names).toEqual(["read", "web_search", "bash"]);
	});

	it("drops the reserved name selected by a compat override", () => {
		const compat = { reservedToolNames: ["bash"] } as Model<"openai-responses">["compat"];
		const names = convertTools(TOOLS, false, model("opencode-go", compat)).map(t => (t as { name: string }).name);
		expect(names).toEqual(["read", "web_search"]);
	});

	it("leaves the caller's tool array unmutated", () => {
		convertTools(TOOLS, false, model("opencode-go"));
		expect(TOOLS.map(t => t.name)).toEqual(["read", "web_search", "bash"]);
	});
});

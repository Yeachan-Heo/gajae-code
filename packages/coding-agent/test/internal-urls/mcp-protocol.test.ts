import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InternalUrlRouter } from "../../src/internal-urls";
import { McpProtocolHandler } from "../../src/internal-urls/mcp-protocol";
import { MCPManager } from "../../src/runtime-mcp/manager";
import type { MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "../../src/runtime-mcp/types";
import { parseInternalUrl } from "../../src/internal-urls/parse";

let scopedManager: MCPManager | undefined;
function scopedRouter(manager: MCPManager | undefined = scopedManager): Pick<InternalUrlRouter, "resolve"> {
	const router = InternalUrlRouter.instance();
	return {
		resolve: (input, context) => router.resolve(input, { ...context, mcpManager: context?.mcpManager ?? manager }),
	};
}
function createMockManager(opts: {
	servers?: string[];
	resources?: Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>;
	readResult?: MCPResourceReadResult | undefined;
	readError?: Error;
}) {
	return {
		getConnectedServers: () => opts.servers ?? [],
		getServerResources: (name: string) => opts.resources?.get(name),
		readServerResource: async (_name: string, _uri: string) => {
			if (opts.readError) throw opts.readError;
			return opts.readResult;
		},
	} as unknown as MCPManager;
}

function setTemplateManager(templates: string[], text = "matched"): Pick<InternalUrlRouter, "resolve"> {
	const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
	resources.set("template-server", {
		resources: [],
		templates: templates.map((uriTemplate, index) => ({ uriTemplate, name: `template-${index}` })),
	});
	const manager = createMockManager({
		servers: ["template-server"],
		resources,
		readResult: { contents: [{ uri: "test://result", text }] },
	});
	return scopedRouter(manager);
}

describe("McpProtocolHandler", () => {
	beforeEach(() => {
		MCPManager.resetForTests();
		scopedManager = undefined;
		InternalUrlRouter.resetForTests();
		InternalUrlRouter.instance().register(new McpProtocolHandler());
	});

	afterEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
		vi.restoreAllMocks();
	});

	it("returns error when no MCP manager is available", async () => {
		const router = scopedRouter();
		await expect(router.resolve("mcp://test://resource")).rejects.toThrow("No MCP manager");
	});

	it("uses the scope-held manager without consulting MCPManager.instance()", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("scoped", { resources: [{ uri: "test://scoped", name: "scoped" }], templates: [] });
		const manager = createMockManager({
			servers: ["scoped"],
			resources,
			readResult: { contents: [{ uri: "test://scoped", text: "scope" }] },
		});
		const instanceSpy = vi.spyOn(MCPManager, "instance").mockImplementation(() => {
			throw new Error("process-global MCPManager.instance() must not route mcp://");
		});
		try {
			const resource = await InternalUrlRouter.instance().resolve("mcp://test://scoped", { mcpManager: manager });
			expect(resource.content).toBe("scope");
		} finally {
			instanceSpy.mockRestore();
		}
	});

	it("rejects omitted context even when a process-global manager is populated", async () => {
		MCPManager.setInstance(createMockManager({ servers: ["populated"] }));
		const handler = new McpProtocolHandler();
		await expect(handler.resolve(parseInternalUrl("mcp://test://resource"))).rejects.toThrow("No MCP manager");
	});

	it("requires resource URI in mcp URL", async () => {
		const manager = createMockManager({ servers: ["server-a"] });
		const router = scopedRouter(manager);
		await expect(router.resolve("mcp://")).rejects.toThrow("mcp:// URL requires a resource URI");
	});

	it("returns error listing available resources when no server matches", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("server-a", {
			resources: [{ uri: "file://known", name: "known-resource" }],
			templates: [],
		});
		const manager = createMockManager({ servers: ["server-a"], resources });
		const router = scopedRouter(manager);

		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("No MCP server has resource");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("file://known");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("server-a");
	});

	it("reads resource by exact URI match", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("my-server", {
			resources: [{ uri: "test://doc", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["my-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc", text: "hello world" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://doc");
		expect(resource.content).toBe("hello world");
		expect(resource.notes).toEqual(["MCP server: my-server"]);
	});

	it("preserves query parameters in MCP resource URI", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-server", {
			resources: [{ uri: "test://doc?q=1", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["query-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc?q=1", text: "query resource" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://doc?q=1");
		expect(resource.content).toBe("query resource");
	});

	it("matches URI templates when no exact URI exists", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs/{id}/raw", name: "doc-template" }],
		});
		const manager = createMockManager({
			servers: ["tmpl-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs/foo/raw", text: "from template" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://docs/foo/raw");
		expect(resource.content).toBe("from template");
	});

	it("matches templates when an expression expands to an empty string", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-template-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs{?cursor}", name: "query-template" }],
		});
		const manager = createMockManager({
			servers: ["query-template-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs", text: "empty expansion" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://docs");
		expect(resource.content).toBe("empty expansion");
	});

	it("accepts resource URIs at the limit and rejects larger URIs without echoing them", async () => {
		const exactUri = `test://${"a".repeat(16_384 - 7)}`;
		const router = setTemplateManager(["test://{id}"]);
		expect((await router.resolve(`mcp://${exactUri}`)).content).toBe("matched");

		const oversizedUri = `${exactUri}z`;
		try {
			await router.resolve(`mcp://${oversizedUri}`);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("MCP resource URI exceeds the 16384-character limit.");
			expect((error as Error).message).not.toContain(oversizedUri);
		}
	});

	it("applies the resource URI limit before trimming edge whitespace", async () => {
		const normalizedUri = "test://doc";
		const oversizedRawUri = `${normalizedUri}${" ".repeat(16_384 - normalizedUri.length + 1)}`;
		const router = setTemplateManager(["test://{id}"]);

		await expect(router.resolve(`mcp://${oversizedRawUri}`)).rejects.toThrow(
			"MCP resource URI exceeds the 16384-character limit.",
		);
	});

	it.each([
		["LF", "\n"],
		["CR", "\r"],
		["LINE SEPARATOR", "\u2028"],
		["PARAGRAPH SEPARATOR", "\u2029"],
	])("rejects %s inside a template expression expansion", async (_name, lineTerminator) => {
		const router = setTemplateManager(["test://{id}"]);
		await expect(router.resolve(`mcp://test://a${lineTerminator}b`)).rejects.toThrow("No MCP server has resource");
	});

	it("skips templates beyond the length limit while accepting the exact boundary", async () => {
		const exactTemplate = `test://${"a".repeat(8_192 - 11)}{id}`;
		const exactUri = `${exactTemplate.slice(0, -4)}x`;
		expect((await setTemplateManager([exactTemplate]).resolve(`mcp://${exactUri}`)).content).toBe("matched");

		const oversizedTemplate = `${exactTemplate}z`;
		const resource = await setTemplateManager([oversizedTemplate, "test://{id}"]).resolve("mcp://test://ok");
		expect(resource.content).toBe("matched");
	});

	it("skips templates beyond the expression limit while accepting the exact boundary", async () => {
		const exactTemplate = `test://${"{id}".repeat(32)}`;
		expect((await setTemplateManager([exactTemplate]).resolve("mcp://test://")).content).toBe("matched");

		const oversizedTemplate = `${exactTemplate}{extra}`;
		const resource = await setTemplateManager([oversizedTemplate, "test://{id}"]).resolve("mcp://test://ok");
		expect(resource.content).toBe("matched");
	});

	it("matches ordered literal segments with overlapping prefix and suffix text", async () => {
		const router = setTemplateManager(["test://aba{first}aba{second}bab"]);
		expect((await router.resolve("mcp://test://abaxabaxybab")).content).toBe("matched");
		await expect(router.resolve("mcp://test://ababaxaba")).rejects.toThrow("No MCP server has resource");
	});

	it("treats empty and unclosed braces as literal template text", async () => {
		const router = setTemplateManager(["test://literal/{}", "test://literal/{unclosed", "test://literal/{}{id}"]);
		expect((await router.resolve("mcp://test://literal/{}")).content).toBe("matched");
		expect((await router.resolve("mcp://test://literal/{unclosed")).content).toBe("matched");
		expect((await router.resolve("mcp://test://literal/{}value")).content).toBe("matched");
	});

	it("rejects adversarial adjacent-expression nonmatches within a bounded timeout", async () => {
		const template = `test://${"{id}".repeat(32)}suffix`;
		const uri = `test://${"a".repeat(16_000)}not-ending`;
		await expect(setTemplateManager([template]).resolve(`mcp://${uri}`)).rejects.toThrow(
			"No MCP server has resource",
		);
	}, 1_000);

	it("bounds scanning across multiple max-length unmatched-brace templates", async () => {
		const attackerTemplate = `test://${"{".repeat(8_192 - 7)}`;
		try {
			await setTemplateManager(Array.from({ length: 32 }, () => attackerTemplate)).resolve("mcp://test://miss");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("No MCP server has resource");
			expect((error as Error).message).not.toContain(attackerTemplate);
		}
	}, 500);

	it("picks the most specific matching template across overlapping schemes", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("broad-server", {
			resources: [],
			templates: [{ uriTemplate: "test://{path}", name: "broad" }],
		});
		resources.set("specific-server", {
			resources: [],
			templates: [{ uriTemplate: "test://foo/{id}", name: "specific" }],
		});
		const manager = createMockManager({
			servers: ["broad-server", "specific-server"],
			resources,
			readResult: { contents: [{ uri: "test://foo/123", text: "from specific" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://foo/123");
		expect(resource.notes).toEqual(["MCP server: specific-server"]);
	});

	it("uses connected server order when matching templates are equally specific", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "first-template" }],
		});
		resources.set("second", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "second-template" }],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://foo", text: "from first" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://foo");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("does not match template with different scheme prefix", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "testing://{id}", name: "testing-template" }],
		});
		const manager = createMockManager({ servers: ["tmpl-server"], resources });
		const router = scopedRouter(manager);

		await expect(router.resolve("mcp://test://foo")).rejects.toThrow("No MCP server has resource");
	});

	it("returns error when readServerResource returns undefined", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("null-server", {
			resources: [{ uri: "test://empty", name: "empty" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["null-server"],
			resources,
			readResult: undefined,
		});
		const router = scopedRouter(manager);

		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("returned no content");
		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("null-server");
	});

	it("formats binary content with mime type and base64 length", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("bin-server", {
			resources: [{ uri: "test://image", name: "image" }],
			templates: [],
		});
		const blobData = "iVBORw0KGgo=";
		const manager = createMockManager({
			servers: ["bin-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://image", mimeType: "image/png", blob: blobData }],
			},
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://image");
		expect(resource.content).toContain("[Binary content:");
		expect(resource.content).toContain("image/png");
		expect(resource.content).toContain(`base64 length ${blobData.length}`);
	});

	it("joins mixed text and binary content with --- separator", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("mix-server", {
			resources: [{ uri: "test://mixed", name: "mixed" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["mix-server"],
			resources,
			readResult: {
				contents: [
					{ uri: "test://mixed", text: "part one" },
					{ uri: "test://mixed", blob: "AAAA", mimeType: "application/octet-stream" },
				],
			},
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://mixed");
		expect(resource.content).toContain("part one");
		expect(resource.content).toContain("\n---\n");
		expect(resource.content).toContain("[Binary content:");
	});

	it("returns (empty resource) when content items have neither text nor blob", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("empty-server", {
			resources: [{ uri: "test://blank", name: "blank" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["empty-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://blank" }],
			},
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://blank");
		expect(resource.content).toBe("(empty resource)");
	});

	it("returns error with message when readServerResource throws", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("err-server", {
			resources: [{ uri: "test://fail", name: "fail" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["err-server"],
			resources,
			readError: new Error("connection refused"),
		});
		const router = scopedRouter(manager);

		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("MCP resource read error:");
		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("connection refused");
	});

	it("picks the first server with a matching resource", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		resources.set("second", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://shared", text: "from first" }] },
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://shared");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("shows (none) when no servers have any resources", async () => {
		const manager = createMockManager({ servers: ["lonely-server"] });
		const router = scopedRouter(manager);

		await expect(router.resolve("mcp://test://anything")).rejects.toThrow("(none)");
	});

	it("uses unknown for binary content without mimeType", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("bin-server", {
			resources: [{ uri: "test://bin", name: "bin" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["bin-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://bin", blob: "data" }],
			},
		});
		const router = scopedRouter(manager);

		const resource = await router.resolve("mcp://test://bin");
		expect(resource.content).toContain("[Binary content: unknown,");
	});
});

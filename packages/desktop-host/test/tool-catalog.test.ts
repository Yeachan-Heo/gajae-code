import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";
import { parseRequest } from "../src/protocol";
import { projectToolCatalog, type ToolCatalogSession } from "../src/tool-catalog";
import { DESKTOP_TOOL_LIMITS, type DesktopToolList } from "../src/tool-protocol";

interface FakeTool {
	name: string;
	label?: string;
	description?: string;
	summary?: string;
	loadMode?: "essential" | "discoverable";
	mcpServerName?: string;
}

function fakeSession(
	tools: FakeTool[],
	state: { active: string[]; discoverable: string[]; selected: string[]; discovery?: boolean },
): ToolCatalogSession {
	return {
		getAllToolNames: () => tools.map(tool => tool.name),
		getActiveToolNames: () => [...state.active],
		getToolByName: name => tools.find(tool => tool.name === name),
		getDiscoverableTools: () =>
			tools
				.filter(tool => state.discoverable.includes(tool.name))
				.map(tool => ({ name: tool.name, serverName: tool.mcpServerName })),
		getSelectedDiscoveredToolNames: () => [...state.selected],
		isToolDiscoveryEnabled: () => state.discovery ?? true,
	};
}

describe("tools.list projection", () => {
	test("returns the SDK name lists in order, each name through the redactor", () => {
		const seen: string[] = [];
		const redact = (text: string) => {
			seen.push(text);
			return text.replaceAll("secret-token", "[redacted]");
		};
		const result = projectToolCatalog(
			fakeSession([{ name: "read" }, { name: "mcp_secret-token_search" }, { name: "bash" }], {
				active: ["bash", "read"],
				discoverable: [],
				selected: [],
			}),
			redact,
		);
		// tools.list is a projected control method: the Host emits this result without redacting it again.
		expect(result.available).toEqual(["read", "mcp_[redacted]_search", "bash"]);
		expect(result.active).toEqual(["bash", "read"]);
		expect(result.tools?.map(tool => tool.name)).toEqual(["read", "mcp_[redacted]_search", "bash"]);
		expect(seen).toContain("mcp_secret-token_search");
	});

	test("describes each tool's origin, search state and MCP server", () => {
		const result = projectToolCatalog(
			fakeSession(
				[
					{ name: "read", label: "Read", summary: "Read files and URLs", loadMode: "essential" },
					{
						name: "todo_write",
						label: "Todo Write",
						description:
							"Write a structured todo list. Use it for multi-step work.\n\n<instruction>…</instruction>",
						loadMode: "discoverable",
					},
					{
						name: "ast_grep",
						label: "AST Grep",
						summary: "Search code with AST patterns",
						loadMode: "discoverable",
					},
					{
						name: "mcp_github_search",
						label: "github/search",
						description: "Search GitHub.",
						mcpServerName: "github",
					},
					{ name: "mcp_docs_lookup", label: "docs/lookup", mcpServerName: "docs" },
					{ name: "custom_tool", description: "A custom extension tool" },
				],
				{
					active: ["read", "ast_grep", "mcp_docs_lookup", "custom_tool"],
					discoverable: ["todo_write", "mcp_github_search"],
					selected: ["ast_grep", "mcp_docs_lookup"],
				},
			),
			text => text,
		);
		expect(result.discovery).toEqual({ enabled: true });
		expect(result.tools).toEqual([
			{
				name: "read",
				label: "Read",
				description: "Read files and URLs",
				active: true,
				origin: "essential",
				discovered: false,
			},
			{
				name: "todo_write",
				label: "Todo Write",
				description: "Write a structured todo list.",
				active: false,
				origin: "discoverable",
				discovered: false,
				hidden: true,
			},
			{
				name: "ast_grep",
				label: "AST Grep",
				description: "Search code with AST patterns",
				active: true,
				origin: "discoverable",
				discovered: true,
			},
			{
				name: "mcp_github_search",
				label: "github/search",
				description: "Search GitHub.",
				active: false,
				origin: "discoverable",
				discovered: false,
				hidden: true,
				mcpServer: "github",
			},
			// A selected MCP tool may have been picked by a person rather than found, so it is never "found".
			{
				name: "mcp_docs_lookup",
				label: "docs/lookup",
				active: true,
				origin: "discoverable",
				discovered: false,
				mcpServer: "docs",
			},
			// A tool without a label shows its name; one without a sentence terminator keeps its line.
			{
				name: "custom_tool",
				label: "custom_tool",
				description: "A custom extension tool",
				active: true,
				origin: "other",
				discovered: false,
			},
		]);
	});

	test("never marks a tool hidden or found while tool search is off", () => {
		const result = projectToolCatalog(
			fakeSession(
				[
					{ name: "todo_write", loadMode: "discoverable" },
					{ name: "ast_grep", loadMode: "discoverable" },
				],
				{ active: ["ast_grep"], discoverable: ["todo_write"], selected: ["ast_grep"], discovery: false },
			),
			text => text,
		);
		expect(result.discovery).toEqual({ enabled: false });
		expect(result.tools?.[0]).toMatchObject({ name: "todo_write", active: false, origin: "discoverable" });
		expect(result.tools?.[0]?.hidden).toBeUndefined();
		expect(result.tools?.[1]).toMatchObject({ name: "ast_grep", active: true, discovered: false });
	});

	test("redacts a whole description before cutting it, and bounds labels, descriptions and the list", () => {
		const secret = "sk-live-0123456789abcdef";
		const long = `${"x".repeat(DESKTOP_TOOL_LIMITS.description - 8)}${secret} and more words without an ending`;
		const seen: string[] = [];
		const redact = (text: string) => {
			seen.push(text);
			return text.replaceAll(secret, "[redacted]");
		};
		const tools: FakeTool[] = [
			{ name: "long", label: "L".repeat(500), summary: long, mcpServerName: `server-${secret}` },
			...Array.from({ length: DESKTOP_TOOL_LIMITS.catalog + 5 }, (_, index) => ({ name: `tool_${index}` })),
		];
		const result = projectToolCatalog(
			fakeSession(tools, { active: ["long"], discoverable: [], selected: [] }),
			redact,
		);
		const first = result.tools?.[0];
		// The secret straddles the cut, so a cut-then-redact projection would leak its first characters.
		expect(seen).toContain(long);
		expect(first?.description).not.toContain("sk-live");
		expect(first?.description?.length).toBe(DESKTOP_TOOL_LIMITS.description);
		expect(first?.description?.endsWith("…")).toBe(true);
		expect(first?.label.length).toBe(DESKTOP_TOOL_LIMITS.description);
		expect(first?.mcpServer).toBe("server-[redacted]");
		expect(result.tools).toHaveLength(DESKTOP_TOOL_LIMITS.catalog);
		// The name lists stay complete: they are what `tools.set` validates against.
		expect(result.available).toHaveLength(tools.length);
	});

	test("redacts a label and a summary before trimming their edges", () => {
		// Trimming first would strip the edge that makes the source an exact secret match.
		const secret = " edge-secret-42";
		const redact = (text: string) => text.replaceAll(secret, "[redacted]");
		const result = projectToolCatalog(
			fakeSession([{ name: "edge", label: `${secret} `, summary: `Reads${secret}\n` }], {
				active: ["edge"],
				discoverable: [],
				selected: [],
			}),
			redact,
		);
		expect(result.tools?.[0]).toMatchObject({ label: "[redacted]", description: "Reads[redacted]" });
		expect(JSON.stringify(result)).not.toContain("edge-secret");
	});
});

describe("tools.list on a real SDK session", () => {
	let environment: NodeJS.ProcessEnv;
	let agentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		environment = { ...process.env };
		agentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		spies.push(vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined));
	});
	afterEach(async () => {
		try {
			for (const cleanup of cleanups.splice(0)) await cleanup();
		} finally {
			for (const spy of spies.splice(0)) spy.mockRestore();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(agentDir);
		}
	});

	async function fixture() {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-catalog-")));
		const dataDir = path.join(directory, "app");
		const projectDir = path.join(directory, "project");
		await fs.mkdir(projectDir);
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const frames: DesktopFrame[] = [];
		const sessions: CreateAgentSessionResult[] = [];
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const result = await createAgentSession(options);
				sessions.push(result);
				return result;
			},
		});
		cleanups.push(async () => {
			await host.close();
			await Promise.all(sessions.map(result => result.session.awaitDisposeCompletion()));
			await fs.rm(directory, { recursive: true, force: true });
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}) => {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		const list = () => call<DesktopToolList>("tools.list", { sessionId: session.id });
		return { call, list, session, sdk: sessions[0]!.session };
	}

	test("todo_write waits for a tool search, then reads as found by it once activated", async () => {
		const h = await fixture();
		const before = await h.list();
		expect(before.discovery).toEqual({ enabled: true });
		expect(before.available).toEqual(h.sdk.getAllToolNames());
		expect(before.tools?.map(tool => tool.name)).toEqual(h.sdk.getAllToolNames());
		const todo = () => h.list().then(list => list.tools?.find(tool => tool.name === "todo_write"));
		expect(await todo()).toMatchObject({
			label: expect.any(String),
			description: expect.any(String),
			active: false,
			origin: "discoverable",
			discovered: false,
			hidden: true,
		});
		const read = before.tools?.find(tool => tool.name === "read");
		expect(read).toMatchObject({ active: true, origin: "essential", discovered: false });
		expect(read?.hidden).toBeUndefined();
		// Every description is one line within its bound.
		for (const tool of before.tools ?? []) {
			expect(tool.description ?? "").not.toContain("\n");
			expect((tool.description ?? "").length).toBeLessThanOrEqual(DESKTOP_TOOL_LIMITS.description);
		}

		expect(await h.sdk.activateDiscoveredTools(["todo_write"])).toEqual(["todo_write"]);
		const found = await todo();
		expect(found).toMatchObject({ active: true, origin: "discoverable", discovered: true });
		expect(found?.hidden).toBeUndefined();
	}, 30_000);

	test("only a tool search marks a tool found; a save keeps or clears that mark with the tool", async () => {
		const h = await fixture();
		const find = (list: DesktopToolList) => list.tools?.find(tool => tool.name === "todo_write");
		const before = await h.list();
		await h.call("tools.set", { sessionId: h.session.id, names: [...before.active, "todo_write"] });
		const pinned = await h.list();
		// An explicit selection is not a tool search, so it never reads as "found by tool search".
		expect(find(pinned)).toMatchObject({ active: true, origin: "discoverable", discovered: false });
		expect(find(pinned)?.hidden).toBeUndefined();

		await h.call("tools.set", { sessionId: h.session.id, names: before.active });
		expect(await h.sdk.activateDiscoveredTools(["todo_write"])).toEqual(["todo_write"]);
		const found = await h.list();
		await h.call("tools.set", { sessionId: h.session.id, names: found.active });
		expect(find(await h.list())).toMatchObject({ active: true, discovered: true });

		await h.call("tools.set", {
			sessionId: h.session.id,
			names: found.active.filter(name => name !== "todo_write"),
		});
		expect(find(await h.list())).toMatchObject({ active: false, discovered: false, hidden: true });
	}, 30_000);
});

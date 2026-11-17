/**
 * An internal tool refresh (MCP catalog, /ssh, plugin and subskill tools) in a shared
 * session stages its selection and publishes it before any live tool changes: a held
 * lease, a refused publication, or an unknown outcome must never leave the session
 * running on tools its transcript does not name.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { AgentSession } from "../src/session/agent-session";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { withManagedSessionTransaction } from "../src/session/internal/managed-session-transaction";
import { SessionManager } from "../src/session/session-manager";
import { createModel } from "./helpers/mock-model";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function readTool(): AgentTool {
	return {
		name: "read",
		label: "Read",
		description: "Read tool",
		parameters: z.object({ value: z.string() }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: "read" }] };
		},
	};
}

function mcpTool(name: string, server: string): CustomTool {
	return {
		name,
		label: `${server}/${name}`,
		description: `${name} tool`,
		parameters: z.object({ query: z.string() }),
		mcpServerName: server,
		mcpToolName: name,
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	} as CustomTool;
}

const docs = mcpTool("mcp__docs_search", "docs");
const pager = mcpTool("mcp__pager_list", "pager");

async function fixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-tool-refresh-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	const read = readTool();
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [read], messages: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "mcp.discoveryMode": true, "compaction.enabled": false }),
		modelRegistry: {
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		toolRegistry: new Map<string, AgentTool>([[read.name, read]]),
		mcpDiscoveryEnabled: true,
		rootInteractiveSharedAppend: true,
		thinkingLevel: ThinkingLevel.Off,
		rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
	});
	sessions.push(session);
	session.agent.emitExternalEvent({ type: "message_end", message: user("root") });
	await session.awaitSessionSettlement();
	await session.refreshMCPTools([docs, pager], { persistMCPSelection: false });
	await session.setActiveToolsByName(["read", docs.name, pager.name]);
	expect(session.getSelectedMCPToolNames()).toEqual([docs.name, pager.name]);
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing transcript");
	return { session, manager, file };
}

async function selections(file: string): Promise<string[][]> {
	return (await Bun.file(file).text())
		.split("\n")
		.filter(line => line.includes('"type":"mcp_tool_selection"'))
		.map(line => (JSON.parse(line) as { selectedToolNames: string[] }).selectedToolNames);
}

describe("shared internal tool refresh publishes before promotion", () => {
	it("keeps the previous tools live while a peer holds the transaction lease", async () => {
		const f = await fixture();
		const before = await selections(f.file);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lease = withManagedSessionTransaction(
			{
				locksDirectory: managedSessionTransactionLocksDirectory(path.dirname(f.file)),
				sessionId: f.manager.getSessionId(),
			},
			async () => {
				held.resolve();
				await release.promise;
			},
		);
		await held.promise;
		const refresh = f.session.refreshMCPTools([docs]);
		try {
			await Bun.sleep(100);
			// The pager server disappeared, but its selection is not published yet.
			expect(f.session.getActiveToolNames()).toEqual(["read", docs.name, pager.name]);
			expect(await selections(f.file)).toEqual(before);
		} finally {
			release.resolve();
			await lease;
		}
		await refresh;
		expect(await selections(f.file)).toEqual([...before, [docs.name]]);
		expect(f.session.getActiveToolNames()).toEqual(["read", docs.name]);
		expect(f.session.getSelectedMCPToolNames()).toEqual([docs.name]);
	});

	it("leaves the live tools unchanged when the publication is refused", async () => {
		const f = await fixture();
		const before = await selections(f.file);
		vi.spyOn(f.manager, "appendToolSelectionsSharingSession").mockResolvedValue({
			kind: "rejected",
			error: new Error("refused"),
		});
		await expect(f.session.refreshMCPTools([docs])).rejects.toMatchObject({
			name: "SharedControlPublicationError",
			outcome: { kind: "rejected" },
		});
		expect(f.session.getActiveToolNames()).toEqual(["read", docs.name, pager.name]);
		expect(await selections(f.file)).toEqual(before);
	});

	it("closes on an unknown outcome with the attempted ids, never promoting the selection", async () => {
		const f = await fixture();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		const failure = new Error("post-write failure");
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementationOnce(function (
			this: ManagedSessionDescendantStore,
			...args: Parameters<typeof original>
		) {
			original.apply(this, args);
			throw failure;
		});
		await expect(f.session.refreshMCPTools([docs])).rejects.toMatchObject({ outcome: { kind: "unknown" } });
		expect(f.session.getActiveToolNames()).toEqual(["read", docs.name, pager.name]);
		const receipt = f.manager.getUnknownSharedPublication();
		if (receipt?.publication !== "entries") throw new Error("Missing receipt");
		expect(receipt.outcome.error).toMatchObject({ message: failure.message });
		expect(receipt.outcome.ids).toHaveLength(1);
		const written = (await Bun.file(f.file).text())
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => (JSON.parse(line) as { id?: string }).id);
		expect(written).toContain(receipt.outcome.ids[0]);
		await expect(f.session.prompt("after the uncertain refresh")).rejects.toMatchObject({
			name: "SharedSessionClosedError",
			receipt,
		});
	});
});

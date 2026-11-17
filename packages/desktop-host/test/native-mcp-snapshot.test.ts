import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { getSessionClientControls } from "@gajae-code/coding-agent/sdk/session-client-controls";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { MCPManager } from "../../coding-agent/src/runtime-mcp/manager";
import { openNativeSession } from "../src/native-session";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-mcp-read-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const manager = new MCPManager(cwd);
	const opened = await openNativeSession({
		options: {
			cwd,
			agentDir,
			authStorage: auth,
			model,
			mcpManager: manager,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
			deferMemoryBackendStartup: true,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
			toolNames: ["read"],
		},
		storage: { directory: path.join(root, "sessions") },
	});
	if (opened.kind !== "opened") throw new Error(`Expected native open, got ${opened.kind}`);
	const session = opened.session;
	cleanups.push(async () => {
		expect(await session.disconnect()).toEqual({ kind: "disconnected" });
		await manager.disconnectAll();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { session, manager };
}

test("native MCP reads reuse writer references during a held transition without admitting another writer", async () => {
	const { session, manager } = await fixture();
	const target = { name: "fixture-server", generation: 1, binding: "fixture-binding" };
	const snapshot = vi.spyOn(manager, "getServerControlSnapshot").mockReturnValue([
		{
			target,
			state: "connected",
			transport: "stdio",
			scope: "manager",
			sharing: "per-session",
			toolCount: 0,
			controls: ["reconnect"],
		},
	]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const backend = vi.spyOn(manager, "controlServer").mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return { target, status: "reconnected", cleanup: "not_certified" };
	});
	let operation: Promise<unknown> | undefined;
	try {
		const first = await session.runtime.mcp.snapshot();
		const ref = first.servers[0]!.ref;
		operation = session.runtime.mcp.operate(ref, "reconnect");
		await entered.promise;
		expect(session.sdk.sessionLifecycle.transitioning).toBe(true);
		expect(() => getSessionClientControls(session.sdk)).toThrow("lifecycle transition");
		const held = await session.runtime.mcp.snapshot();
		expect(held.servers[0]).toMatchObject({ ref, controls: [] });
		expect(await session.runtime.session.setSessionName("must not apply", "user")).toMatchObject({
			kind: "refused",
			reason: "context_mismatch",
		});
		expect(backend).toHaveBeenCalledTimes(1);
		expect(backend).toHaveBeenCalledWith(target, "reconnect", { signal: expect.any(AbortSignal) });
	} finally {
		release.resolve();
		try {
			if (operation) expect(await operation).toMatchObject({ kind: "applied", value: { status: "reconnected" } });
		} finally {
			backend.mockRestore();
			snapshot.mockRestore();
		}
	}
});

test("retained native MCP readers refuse after disconnect", async () => {
	const { session } = await fixture();
	const runtime = session.runtime;
	await runtime.mcp.snapshot();
	expect(await session.disconnect()).toEqual({ kind: "disconnected" });
	await expect(runtime.mcp.snapshot()).rejects.toMatchObject({ code: "resource_gone" });
	expect(await runtime.mcp.operate("unknown", "reconnect")).toMatchObject({
		kind: "refused",
		reason: "manager_closed",
	});
});

test("native MCP readers refuse a changed owner instead of rebuilding controls for it", async () => {
	const { session } = await fixture();
	await session.runtime.mcp.snapshot();
	const owner = vi.spyOn(session.sdk, "getAgentId").mockReturnValue("foreign-owner");
	try {
		await expect(session.runtime.mcp.snapshot()).rejects.toMatchObject({ code: "resource_gone" });
	} finally {
		owner.mockRestore();
	}
});

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { MCPManager } from "../../src/runtime-mcp/manager";
import { ActivityControlError, ActivityControls } from "../../src/sdk/activity-controls";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { getSessionClientControls } from "../../src/sdk/session-client-controls";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function disconnect(opened: Opened): Promise<void> {
	if (opened.result.session.sessionManager.getStrictCloseState().kind !== "none_started") return;
	const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
	if (!preparation.inventory) throw new Error("Missing native work inventory");
	const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
		stopAndJoin: true,
		work: { inventory: preparation.inventory, targets: [] },
	});
	if (!consent) throw new Error("Missing native termination consent");
	await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-mcp-")));
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
	const mcpManager = new MCPManager(cwd);
	const opened = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		authStorage: auth,
		model,
		storage: { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: false,
		mcpManager,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferMemoryBackendStartup: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		toolNames: ["read"],
	});
	if (opened.kind !== "opened") throw new Error(`Expected native open, got ${opened.kind}`);
	cleanups.push(async () => {
		await disconnect(opened);
		await mcpManager.disconnectAll();
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

describe("native runtime MCP family", () => {
	it("returns the existing activity snapshot under native admission", async () => {
		const opened = await fixture();
		const snapshot = spyOn(ActivityControls.prototype, "getMcpSnapshot");
		try {
			const result = await opened.runtime.mcp.snapshot();
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(snapshot.mock.results[0]?.value).toBe(result);
			expect(result).toEqual({
				scope: "factory_manager_may_be_shared",
				servers: [],
				truncated: false,
			});
		} finally {
			snapshot.mockRestore();
		}
	});

	it("keeps raw MCP guarded while admitted operations reach domain validation", async () => {
		const opened = await fixture();
		const activity = getSessionClientControls(opened.result.session).activity;
		if (!activity) throw new Error("Missing native activity controls");
		expect(() => activity.operateMcp({ ref: "unknown-server" }, "reconnect")).toThrow(NativeRuntimeRefusal);
		expect(() => activity.getMcpSnapshot()).toThrow(NativeRuntimeRefusal);

		// Missing targets remain domain failures, rather than native context mismatches.
		const operation = opened.runtime.mcp.operate("unknown-server", "reconnect");
		await expect(operation).rejects.toBeInstanceOf(ActivityControlError);
		await expect(operation).rejects.toMatchObject({ code: "not_found" });
		await expect(operation).rejects.not.toBeInstanceOf(NativeRuntimeRefusal);
	});

	it("applies server operations through the existing MCP control admission", async () => {
		const opened = await fixture();
		const manager = opened.result.mcpManager;
		if (!manager) throw new Error("Missing fixture MCP manager");
		const target = { name: "fixture-server", generation: 1, binding: "fixture-binding" };
		const snapshot = spyOn(manager, "getServerControlSnapshot").mockReturnValue([
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
		const backend = spyOn(manager, "controlServer").mockResolvedValue({
			target,
			status: "reconnected",
			cleanup: "not_certified",
		});
		try {
			const observed = await opened.runtime.mcp.snapshot();
			const server = observed.servers[0];
			if (!server) throw new Error("Missing fixture MCP server");
			expect(await opened.runtime.mcp.operate(server.ref, "reconnect")).toMatchObject({
				kind: "applied",
				value: { status: "reconnected", cleanup: "not_certified" },
			});
			expect(backend).toHaveBeenCalledTimes(1);
			expect(backend).toHaveBeenCalledWith(target, "reconnect", { signal: expect.any(AbortSignal) });
		} finally {
			backend.mockRestore();
			snapshot.mockRestore();
		}
	});

	it("returns structured admission refusals after native disconnect", async () => {
		const opened = await fixture();
		await disconnect(opened);
		await expect(opened.runtime.mcp.snapshot()).rejects.toMatchObject({ code: "resource_gone" });
		expect(await opened.runtime.mcp.operate("unknown-server", "reconnect")).toMatchObject({
			kind: "refused",
			reason: "manager_closed",
		});
	});
});

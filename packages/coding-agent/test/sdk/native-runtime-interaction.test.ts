import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { AuthStorage } from "../../src/session/auth-storage";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedInteraction,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";

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

async function fixture(): Promise<Opened> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-interaction-")));
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
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

describe("native runtime interaction bridge", () => {
	it("exposes the registered service that owns this runtime's questions", async () => {
		const opened = await fixture();
		const interaction = currentEmbeddedInteraction(opened.handle);
		expect(interaction.ownership).toBe("owned");
		expect(interaction.connectionId.length).toBeGreaterThan(0);
		const state = interaction.service.snapshot();
		expect(state.connected).toBe(true);
		expect(state.disposed).toBe(false);
		// The runtime presents every question through this service, so an empty queue is
		// the observable state a host bridges before it can answer anything.
		expect(state.pending).toEqual([]);
	});

	it("gives each runtime its own connection and disposes it on retirement", async () => {
		const first = await fixture();
		const second = await fixture();
		const firstInteraction = currentEmbeddedInteraction(first.handle);
		expect(firstInteraction.connectionId).not.toBe(currentEmbeddedInteraction(second.handle).connectionId);
		await disconnect(first);
		// A retired runtime must never leave a host answering questions into a dead session.
		expect(firstInteraction.service.snapshot().disposed).toBe(true);
		expect(currentEmbeddedInteraction(second.handle).service.snapshot().disposed).toBe(false);
	});
});

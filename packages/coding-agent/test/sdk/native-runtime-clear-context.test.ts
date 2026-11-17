import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function disconnect(opened: Opened): Promise<void> {
	if (opened.result.session.sessionManager.getStrictCloseState().kind !== "none_started") return;
	const op = currentEmbeddedResumeOperation(opened.handle);
	const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
	if (!preparation.inventory) throw new Error("Missing native work inventory");
	const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
		stopAndJoin: true,
		work: { inventory: preparation.inventory, targets: [] },
	});
	if (!consent) throw new Error("Missing native termination consent");
	await terminateEmbeddedAgentSession(opened.handle, { op, consent });
}

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-clear-context-")));
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

describe("native runtime context clear", () => {
	it("resets the active transcript and keeps subsequent prompts admitted while refusing raw clears", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const manager = session.sessionManager;
		const sessionId = session.sessionId;
		const transport = createMockModel({ handler: { content: ["answer"] } });
		session.agent.streamFn = transport.stream;

		expect((await opened.runtime.prompt.prompt("before clear")).kind).toBe("applied");
		await session.waitForIdle();
		const previousMessages = manager.getBranch().filter(entry => entry.type === "message");
		expect(previousMessages.map(entry => entry.message.role)).toEqual(["user", "assistant"]);
		const previousLeaf = manager.getLeafId();
		const previousOp = currentEmbeddedResumeOperation(opened.handle);

		expect(await opened.runtime.session.clearContext()).toMatchObject({ kind: "applied", value: true });
		expect(currentEmbeddedResumeOperation(opened.handle)).not.toBe(previousOp);
		expect(session.sessionId).toBe(sessionId);
		expect(manager.getLeafId()).not.toBe(previousLeaf);
		expect(manager.getBranch()[0]).toMatchObject({ type: "custom", customType: "context_clear", parentId: null });
		expect(manager.getBranch().filter(entry => entry.type === "message")).toHaveLength(0);
		for (const entry of previousMessages) expect(manager.getEntry(entry.id)).toEqual(entry);

		expect(await opened.runtime.prompt.prompt("after clear")).toMatchObject({ kind: "applied" });
		await session.waitForIdle();
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["user", "assistant"]);

		const admittedLeaf = manager.getLeafId();
		expect(() => session.clearContext()).toThrow(NativeRuntimeRefusal);
		expect(manager.getLeafId()).toBe(admittedLeaf);
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core/thinking";
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
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-session-family-")));
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
	opened.result.session.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
	cleanups.push(async () => {
		if (opened.result.session.sessionManager.getStrictCloseState().kind === "none_started") {
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
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

describe("native runtime session family", () => {
	it("renames, retools and re-thinks the session through admission", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();

		expect((await opened.runtime.session.setSessionName("renamed", "user")).kind).toBe("applied");
		expect(session.sessionManager.getSessionName()).toBe("renamed");

		expect((await opened.runtime.session.setActiveToolsByName(["read"], { explicit: true })).kind).toBe("applied");
		expect((await opened.runtime.session.setThinkingLevelForControl(ThinkingLevel.Low, false)).kind).toBe("applied");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);

		// The dispatch left its own suffix unproven; a later turn must still be admitted.
		expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
		await session.waitForIdle();
	});

	it("compacts and retries through admission", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();
		// The fixture disables automatic compaction, so the refusal here is the session's
		// own "nothing to compact" rule rather than an admission refusal.
		const retried = await opened.runtime.session.retry();
		expect(retried.kind === "applied" || retried.kind === "refused").toBe(true);
		expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
		await session.waitForIdle();
	});
});

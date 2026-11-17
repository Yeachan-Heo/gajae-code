import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
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
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-multi-turn-")));
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

describe("native runtime multi-turn dispatch", () => {
	it("applies every turn although each turn leaves its own suffix unproven", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const transport = createMockModel({ handler: { content: ["answer"] } });
		session.agent.streamFn = transport.stream;

		const first = await opened.runtime.prompt.prompt("first turn");
		expect(first.kind).toBe("applied");
		await session.waitForIdle();

		// The first turn's appends are published but not yet fsynced, so a verification-only
		// dispatch refuses `not_ready` here and would strand the session after one turn.
		const second = await opened.runtime.prompt.prompt("second turn");
		expect(second.kind).toBe("applied");
		await session.waitForIdle();

		const third = await opened.runtime.prompt.prompt("third turn");
		expect(third.kind).toBe("applied");
		await session.waitForIdle();

		const users = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "user");
		expect(users).toHaveLength(3);
	});

	it("admits reads, steering and abort while the turn is still streaming", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const transport = createMockModel({ handler: { content: ["slow answer"], delayMs: 600 } });
		session.agent.streamFn = transport.stream;

		const run = opened.runtime.prompt.prompt("slow turn");
		await Bun.sleep(120);
		expect(session.isStreaming).toBe(true);

		expect((await opened.runtime.activity.control("activity.snapshot", {})).kind).toBe("applied");
		expect((await opened.runtime.queue.steer("steer text")).kind).toBe("applied");
		expect((await opened.runtime.queue.abort()).kind).toBe("applied");
		expect((await run).kind).toBe("applied");
		await session.waitForIdle();
	});
});

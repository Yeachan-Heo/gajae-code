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
import { invokeNativeRuntime, NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-revision-")));
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
	const cleanup = async (): Promise<void> => {
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
	};
	cleanups.push(cleanup);
	return opened;
}

function userEntries(session: Opened["result"]["session"]) {
	return session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "message" && entry.message.role === "user");
}

describe("native runtime view transitions", () => {
	it("keeps dispatching after a revision edit advances the session generation", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();
		const generationBefore = session.sessionLifecycle.generation;

		const edited = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: userEntries(session)[0]!.id, action: "edit", body: "edited prompt" }),
		);
		expect(edited.kind).toBe("applied");
		await session.waitForIdle();
		// The edit navigates the tree, so the view generation really did advance.
		expect(session.sessionLifecycle.generation).toBeGreaterThan(generationBefore);

		const next = await opened.runtime.prompt.prompt("after edit");
		expect(next.kind).toBe("applied");
		await session.waitForIdle();
	});

	it("adopts the cursor a durable selection committed", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();
		expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
		await session.waitForIdle();
		// Editing the first prompt forks a sibling branch, so selecting the retained one
		// has to move the execution leaf instead of resolving to the active tail.
		const edited = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: userEntries(session)[0]!.id, action: "edit", body: "edited prompt" }),
		);
		expect(edited.kind).toBe("applied");
		await session.waitForIdle();

		const before = currentEmbeddedResumeOperation(opened.handle);
		const retained = userEntries(session).find(entry => entry.id !== userEntries(session)[0]!.id);
		if (!retained) throw new Error("Missing retained user prompt");
		const selected = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: retained.id, action: "select" }),
		);
		expect(selected.kind).toBe("applied");
		expect(currentEmbeddedResumeOperation(opened.handle)).not.toBe(before);

		expect((await opened.runtime.prompt.prompt("after selection")).kind).toBe("applied");
		await session.waitForIdle();
	});

	it("refuses a view transition attempted outside its own admitted dispatch", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();

		// A raw tree move is not this runtime's admitted work: the entry point itself
		// refuses, so nothing is adopted and the runtime stays coherent.
		await expect(session.navigateTree(userEntries(session)[0]!.id)).rejects.toBeInstanceOf(NativeRuntimeRefusal);
		expect((await opened.runtime.prompt.prompt("after refused navigation")).kind).toBe("applied");
		await session.waitForIdle();
	});
});

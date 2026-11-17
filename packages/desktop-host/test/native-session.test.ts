import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core/thinking";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { openNativeSession } from "../src/native-session";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-native-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const sessions = path.join(root, "sessions");
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
	cleanups.push(async () => {
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return {
		cwd,
		agentDir,
		sessions,
		auth,
		options: {
			cwd,
			agentDir,
			authStorage: auth,
			model,
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
	};
}

describe("desktop native session", () => {
	it("creates, mutates through admission and retires on explicit Disconnect", async () => {
		const f = await fixture();
		const opened = await openNativeSession({ options: f.options, storage: { directory: f.sessions } });
		expect(opened.kind).toBe("opened");
		if (opened.kind !== "opened") return;
		const session = opened.session;
		session.sdk.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;

		expect(session.state).toBe("connected");
		expect((await session.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.sdk.waitForIdle();
		expect((await session.runtime.session.setSessionName("renamed", "user")).kind).toBe("applied");
		expect((await session.runtime.session.setThinkingLevelForControl(ThinkingLevel.Low, false)).kind).toBe(
			"applied",
		);

		const before = session.epoch;
		expect(await session.disconnect()).toEqual({ kind: "disconnected" });
		expect(session.epoch).toBe(before + 1);
		expect(session.state).toBe("disconnected");
		expect(session.sdk.sessionManager.getStrictCloseState().kind).toBe("closed");
	});

	it("takes over the retired transcript from its exact checkpoint", async () => {
		const f = await fixture();
		const first = await openNativeSession({ options: f.options, storage: { directory: f.sessions } });
		if (first.kind !== "opened") throw new Error(`Expected open, got ${first.kind}`);
		first.session.sdk.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
		expect((await first.session.runtime.prompt.prompt("first")).kind).toBe("applied");
		await first.session.sdk.waitForIdle();
		const file = first.session.sdk.sessionManager.getSessionFile();
		const leaf = first.session.sdk.sessionManager.getLeafId();
		if (!file) throw new Error("Missing session file");
		expect(await first.session.disconnect()).toEqual({ kind: "disconnected" });

		const reopened = await openNativeSession({ options: f.options, storage: { directory: f.sessions }, file });
		expect(reopened.kind).toBe("opened");
		if (reopened.kind !== "opened") return;
		expect(reopened.session.sdk.sessionManager.getLeafId()).toBe(leaf);
		expect(reopened.session.sdk.messages.length).toBeGreaterThan(0);
		reopened.session.sdk.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
		expect((await reopened.session.runtime.prompt.prompt("second")).kind).toBe("applied");
		await reopened.session.sdk.waitForIdle();
		expect(await reopened.session.disconnect()).toEqual({ kind: "disconnected" });
	});
});

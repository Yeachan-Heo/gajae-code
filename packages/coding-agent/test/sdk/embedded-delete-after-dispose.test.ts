import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { YAML } from "bun";
import {
	createEmbeddedAgentSession,
	deleteEmbeddedSession,
	type EmbeddedAgentSessionResult,
} from "../../src/sdk/embedding";
import { AuthStorage } from "../../src/session/auth-storage";

describe("embedded deletion after cooperative disposal", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function open(): Promise<{ result: EmbeddedAgentSessionResult; file: string }> {
		const dir = TempDir.createSync(path.join(os.tmpdir(), "sdk-embedded-delete-"));
		cleanups.push(() => dir.removeSync());
		const cwd = path.join(dir.path(), "workspace");
		const agentDir = path.join(dir.path(), "agent");
		await fs.mkdir(cwd, { recursive: true });
		const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
		cleanups.push(() => auth.close());
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled test model");
		auth.setRuntimeApiKey(bundled.provider, "test-only-key");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				compaction: { enabled: false },
				retry: { enabled: false },
				tools: { discoveryMode: "off" },
				modelRoles: { default: `${bundled.provider}/${bundled.id}` },
			}),
		);
		const result = await createEmbeddedAgentSession({
			cwd,
			agentDir,
			authStorage: auth,
			model: bundled,
			storage: { directory: path.join(dir.path(), "sessions") },
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
		cleanups.push(() => result.releaseResources());
		// Real factory, prompt engine and storage; only the provider transport is local.
		result.session.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
		await result.session.prompt("hello");
		await result.session.waitForIdle();
		await result.session.awaitSessionSettlement();
		const file = result.session.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted transcript");
		return { result, file };
	}

	it("refuses a live cooperative member, then deletes once the factory owner actually closed and released", async () => {
		const { result, file } = await open();
		expect(result.session.sessionManager.getOwnerMembership()).toBeDefined();
		await expect(deleteEmbeddedSession(file)).rejects.toMatchObject({ code: "owned_by_other" });
		expect(await Bun.file(file).exists()).toBe(true);

		await result.session.dispose();
		await result.session.awaitDisposeCompletion();
		expect(result.session.sessionManager.getStrictCloseState().kind).toBe("closed");
		// Closure alone retains the member token; only the owning factory release retires it.
		expect(result.session.sessionManager.getOwnerMembership()).toBeDefined();
		await expect(deleteEmbeddedSession(file)).rejects.toMatchObject({ code: "owned_by_other" });
		await result.releaseResources();
		expect(result.session.sessionManager.getOwnerMembership()).toBeUndefined();

		await deleteEmbeddedSession(file);
		expect(await Bun.file(file).exists()).toBe(false);
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { testModelRegistryConsumerLease } from "./helpers/model-registry";

describe("AgentSession model registry consumer lease", () => {
	let session: AgentSession | undefined;
	let registry: ModelRegistry | undefined;
	let auth: AuthStorage | undefined;
	let dir: string | undefined;

	afterEach(async () => {
		await session?.dispose();
		await registry?.dispose();
		auth?.close();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	async function setup(): Promise<{ session: AgentSession; registry: ModelRegistry }> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-lease-"));
		auth = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "compaction.enabled": false });
		registry = new ModelRegistry(auth, path.join(dir, "models.yml"), settings, {
			agentDir: dir,
			automaticRefresh: false,
		});
		session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(dir),
			settings,
			modelRegistry: registry,
		});
		return { session, registry };
	}

	it("holds the real registry lease until an admitted prompt settles", async () => {
		const { session, registry } = await setup();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const events: string[] = [];
		const prompt = session.runWithPromptAdmissionForTests(async () => {
			events.push("prompt");
			entered.resolve();
			await finish.promise;
			events.push("settled");
		});
		await entered.promise;
		const publication = registry.acquirePublicationFence().then(release => {
			events.push("publication");
			release();
		});
		try {
			await Bun.sleep(5);
			expect(events).toEqual(["prompt"]);
		} finally {
			finish.resolve();
			await Promise.all([prompt, publication]);
		}
		expect(events).toEqual(["prompt", "settled", "publication"]);
	});

	it("waits for publication and releases the real lease after prompt rejection", async () => {
		const { session, registry } = await setup();
		const release = await registry.acquirePublicationFence();
		let entered = false;
		const prompt = session.runWithPromptAdmissionForTests(async () => {
			entered = true;
			throw new Error("prompt failed");
		});
		const rejection = prompt.catch((error: unknown) => error);
		try {
			await Bun.sleep(5);
			expect(entered).toBe(false);
		} finally {
			release();
		}
		expect(await rejection).toMatchObject({ message: "prompt failed" });
		expect(entered).toBe(true);
		const releaseNext = await registry.acquirePublicationFence();
		releaseNext();
	});

	it("static test registries propagate callback results and failures", async () => {
		await expect(testModelRegistryConsumerLease.withConsumerLease(() => "result")).resolves.toBe("result");
		await expect(
			testModelRegistryConsumerLease.withConsumerLease(async () => {
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");
	});

	it("static test registries reject pre-aborted admission without invoking its callback", async () => {
		const controller = new AbortController();
		controller.abort(new Error("admission cancelled"));
		let called = false;
		await expect(
			testModelRegistryConsumerLease.withConsumerLease(() => {
				called = true;
			}, controller.signal),
		).rejects.toThrow("admission cancelled");
		expect(called).toBe(false);
	});
});

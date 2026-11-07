import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { openLifecycleSessionManager } from "../src/commands/sdk";
import { deriveLifecycleDeadlines, readSessionLifecycleLaunchRequest, type SessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";

describe("ephemeral lifecycle host startup", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ephemeral-host-"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function request(ephemeral: boolean): SessionLifecycleLaunchRequest {
		return {
			operation: "session.create",
			sessionId: "ephemeral-fixture",
			cwd: root,
			stateRoot: path.join(root, ".gjc", "state"),
			effectMarker: "ephemeral-fixture-marker",
			...deriveLifecycleDeadlines(Date.now(), 30_000),
			ephemeral,
		};
	}

	it("rejects a nonboolean persistence flag", () => {
		expect(() => readSessionLifecycleLaunchRequest(JSON.stringify({ ...request(true), ephemeral: "true" }))).toThrow("invalid");
	});

	for (const ephemeral of [true, false]) {
		it(`${ephemeral ? "ephemeral" : "persistent"} host selects the appropriate transcript storage`, async () => {
			const agentDir = path.join(root, "agent");
			const { sessionManager } = await openLifecycleSessionManager(request(ephemeral), root, agentDir);
			if (!ephemeral) {
				// Ordinary create defers manager construction to createAgentSession.
				expect(sessionManager).toBeUndefined();
				return;
			}
			if (!sessionManager) throw new Error("Host did not return a session manager");
			try {
				sessionManager.appendMessage({ role: "user", content: "temporary fixture message", timestamp: Date.now() });
				await sessionManager.ensureOnDisk();
				const sessionFile = sessionManager.getSessionFile();
				if (ephemeral) {
					const files = await fs.readdir(root, { recursive: true });
					expect(files.filter(file => file.endsWith(".jsonl"))).toEqual([]);
					expect(sessionManager.getEntries().length).toBeGreaterThan(0);
				} else {
					expect(sessionFile).toBeTruthy();
					expect(await Bun.file(sessionFile).exists()).toBe(true);
					expect(await Bun.file(sessionFile).text()).toContain("temporary fixture message");
				}
			} finally {
				await sessionManager.close();
			}
		});
	}

	it("rejects an ephemeral fork at the actual host entry point", async () => {
		const fork: SessionLifecycleLaunchRequest = {
			...request(true),
			operation: "session.fork",
			sourceSessionId: "source-session",
			sourceSessionPath: path.join(root, "source.jsonl"),
		};
		await expect(openLifecycleSessionManager(fork, root, path.join(root, "agent"))).rejects.toThrow(
			"Ephemeral sessions cannot be created via session.fork operations",
		);
	});
});

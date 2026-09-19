import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, getBundledModel } from "@gajae-code/ai";
import { FileLockAcquireError, withFileLock } from "../src/config/file-lock";
import { Settings } from "../src/config/settings";
import { registerDirectSession } from "../src/main";
import { createAgentSession } from "../src/sdk";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { SessionManager } from "../src/session/session-manager";

async function makeTempRoot(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempRoot(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true });
}

describe("direct CLI session-index registration", () => {
	test("ephemeral child does not create a session-index lock", async () => {
		const root = await makeTempRoot("gjc-5438-ephemeral-");
		try {
			const sessionsDir = path.join(root, "sdk", "sessions");
			const logPath = path.join(sessionsDir, "index.jsonl");
			const lockPath = `${logPath}.lock`;

			await expect(
				registerDirectSession(SessionManager.inMemory(root), root, undefined, {
					registerPostmortem: () => () => {},
				}),
			).resolves.toBeUndefined();
			expect(await fs.stat(lockPath).catch(() => undefined)).toBeUndefined();
			expect(await fs.stat(logPath).catch(() => undefined)).toBeUndefined();
		} finally {
			await removeTempRoot(root);
		}
	});

	test("ephemeral child succeeds without touching a contended standalone index lock", async () => {
		const root = await makeTempRoot("gjc-5438-ephemeral-contended-");
		try {
			const sessionsDir = path.join(root, "sdk", "sessions");
			const logPath = path.join(sessionsDir, "index.jsonl");
			const lockPath = `${logPath}.lock`;
			await fs.mkdir(lockPath, { recursive: true });
			await Bun.write(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: process.pid, start_time: "unknown", timestamp: Date.now() }),
			);

			await expect(
				registerDirectSession(SessionManager.inMemory(root), root, undefined, {
					registerPostmortem: () => () => {},
				}),
			).resolves.toBeUndefined();
			expect(await fs.stat(lockPath)).toBeDefined();
			expect(await fs.stat(logPath).catch(() => undefined)).toBeUndefined();
		} finally {
			await removeTempRoot(root);
		}
	});

	test("durable direct session still publishes a host registration", async () => {
		const root = await makeTempRoot("gjc-5438-durable-");
		try {
			const manager = SessionManager.create(root, SessionManager.explicitDestination(path.join(root, "sessions")));
			await registerDirectSession(manager, root, undefined, {
				processIncarnation: () => undefined,
				registerPostmortem: () => () => {},
			});

			const index = await new SessionIndex(root).open();
			expect(index.listSessions().sessions).toHaveLength(1);
			expect(index.listSessions().sessions[0]).toMatchObject({
				sessionId: manager.getSessionId(),
				pid: process.pid,
				endpointGeneration: 0,
			});
		} finally {
			await removeTempRoot(root);
		}
	});

	test("durable registration surfaces genuine index contention", async () => {
		const root = await makeTempRoot("gjc-5438-contention-");
		try {
			const sessionsDir = path.join(root, "sdk", "sessions");
			const logPath = path.join(sessionsDir, "index.jsonl");
			const lockPath = `${logPath}.lock`;
			await fs.mkdir(lockPath, { recursive: true });
			await Bun.write(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: process.pid, start_time: "unknown", timestamp: Date.now() }),
			);

			const manager = SessionManager.create(root, SessionManager.explicitDestination(path.join(root, "sessions")));
			const index = new SessionIndex(root);
			const append = index.append.bind(index);
			index.append = input => withFileLock(logPath, () => append(input), { retries: 1, retryDelayMs: 1 });
			await expect(
				registerDirectSession(manager, root, undefined, {
					createIndex: () => index,
					registerPostmortem: () => () => {},
				}),
			).rejects.toBeInstanceOf(FileLockAcquireError);
			expect(await fs.stat(lockPath)).toBeDefined();
		} finally {
			await removeTempRoot(root);
		}
	});

	test("top-level in-memory SDK sessions retain SDK hosting", async () => {
		const root = await makeTempRoot("gjc-5438-sdk-host-");
		const authStorage = await AuthStorage.create(":memory:");
		const priorNotifications = process.env.GJC_NOTIFICATIONS;
		const priorSdkDisable = process.env.GJC_SDK_DISABLE;
		delete process.env.GJC_NOTIFICATIONS;
		delete process.env.GJC_SDK_DISABLE;
		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				authStorage,
				model: getBundledModel("openai", "gpt-4o-mini"),
				settings: Settings.isolated({ "notifications.enabled": false }),
				sessionManager: SessionManager.inMemory(root),
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(session.extensionRunner?.getCommand("notify")).toBeDefined();
			} finally {
				await session.dispose();
			}
		} finally {
			if (priorNotifications === undefined) delete process.env.GJC_NOTIFICATIONS;
			else process.env.GJC_NOTIFICATIONS = priorNotifications;
			if (priorSdkDisable === undefined) delete process.env.GJC_SDK_DISABLE;
			else process.env.GJC_SDK_DISABLE = priorSdkDisable;
			authStorage.close();
			await removeTempRoot(root);
		}
	});
});

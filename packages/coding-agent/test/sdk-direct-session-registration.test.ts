import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockAcquireError, withFileLock } from "../src/config/file-lock";
import { registerDirectSession } from "../src/main";
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
			await fs.writeFile(
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

	test("genuine index contention still surfaces FileLockAcquireError", async () => {
		const root = await makeTempRoot("gjc-5438-contention-");
		try {
			const sessionsDir = path.join(root, "sdk", "sessions");
			const logPath = path.join(sessionsDir, "index.jsonl");
			const lockPath = `${logPath}.lock`;
			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: process.pid, start_time: "unknown", timestamp: Date.now() }),
			);

			const attempt = withFileLock(logPath, async () => {}, { retries: 1, retryDelayMs: 1 });
			await expect(attempt).rejects.toBeInstanceOf(FileLockAcquireError);
			expect(await fs.stat(lockPath)).toBeDefined();
		} finally {
			await removeTempRoot(root);
		}
	});
});

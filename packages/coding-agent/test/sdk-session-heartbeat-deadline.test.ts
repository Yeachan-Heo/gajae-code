import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lockModule from "../src/config/file-lock";
import { SessionIndex } from "../src/sdk/broker/session-index";

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-heartbeat-deadline-"));
	const index = await new SessionIndex(dir).open();
	await index.append({
		type: "host_registered",
		sessionId: "deadline-host",
		locator: { cwd: dir, worktreeRoot: null, stateRoot: dir },
		endpointGeneration: 1,
		pid: process.pid,
	});
	return { dir, index, log: path.join(dir, "sdk", "sessions", "index.jsonl") };
}

describe("SDK heartbeat checkpoint deadline (#6459)", () => {
	it("returns no heartbeat before the startup fence when successive holders take 10s and 10.5s", async () => {
		// Given: two legitimate holders, each shorter than the 20-second fence.
		// Advance only the monotonic clock; every admitted callback and lock body
		// executes. The acquisition adapter respects the supplied retry budget.
		const { dir, index } = await fixture();
		let elapsed = 0;
		let acquisitions = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		const realWithFileLock = lockModule.withFileLock;
		const locking = vi.spyOn(lockModule, "withFileLock").mockImplementation(async (file, callback, options) => {
			const holderMs = [10_000, 10_500][acquisitions++] ?? 0;
			const waitBudgetMs = (options?.retries ?? 600) * (options?.retryDelayMs ?? 100);
			if (holderMs >= waitBudgetMs) {
				elapsed += waitBudgetMs;
				throw new lockModule.FileLockAcquireError(file, `${file}.lock`, options?.retries ?? 600, "live owner");
			}
			return await realWithFileLock(
				file,
				async () => {
					elapsed += holderMs;
					return await callback();
				},
				options,
			);
		});
		try {
			// When: the production checkpoint retries a stale first observation.
			const written = await index.checkpointLiveHeartbeats();
			// Then: startup can continue, with no stale heartbeat or watchdog exit.
			expect(written).toBe(0);
			expect(elapsed).toBeLessThan(20_000);
			expect(acquisitions).toBe(2);
			expect(index.listSessions().sessions[0]?.lastHeartbeatAt).toBeUndefined();
			expect(await fs.exists(path.join(dir, "sdk", "sessions", "index.jsonl.lock"))).toBe(false);
		} finally {
			locking.mockRestore();
			clock.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

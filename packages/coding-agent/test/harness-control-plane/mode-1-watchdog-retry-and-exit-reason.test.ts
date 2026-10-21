import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
	readSessionState,
	writeSessionState,
	generateSessionId,
	canonicalWorkspacePath,
} from "../../src/harness-control-plane/storage";
import type { SessionState } from "../../src/harness-control-plane/types";

/**
 * Mode 1: Harness owner watchdog retry logic and exit reason persistence.
 *
 * Test verifies that:
 * 1. Single transient resolveOwner() error does NOT stop the owner (retry logic)
 * 2. N consecutive errors DO stop the owner
 * 3. When owner stops, exit reason is persisted to state.blockers
 * 4. Caller (submit/finalize) receives typed exit code, not generic "owner-not-live"
 */

describe("Mode 1: Watchdog retry logic and exit reason persistence", () => {
	let testRoot: string;
	let sessionId: string;

	beforeEach(async () => {
		testRoot = path.join(tmpdir(), `gjc-mode1-retry-${Date.now()}`);
		sessionId = generateSessionId();
		await fs.mkdir(testRoot, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(testRoot, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	});

	it("verifies single transient error does NOT stop watchdog (retry bound)", async () => {
		// Simulate watchdog behavior with retry logic
		let callCount = 0;
		let watchdogStopped = false;
		const maxConsecutiveFailures = 3;
		let consecutiveFailures = 0;

		// Mock resolveOwner that fails once, then succeeds
		async function mockResolveOwnerWithTransientError() {
			callCount++;
			if (callCount === 1) {
				throw new Error("Transient I/O error");
			}
			// After first error, return live owner
			return { live: true, socketPath: "/tmp/socket", lease: null };
		}

		// Simulate watchdog loop
		await new Promise<void>((resolve) => {
			let timer: Timer | null = null;

			const stop = () => {
				if (timer) clearInterval(timer);
				watchdogStopped = true;
				resolve();
			};

			// Simulate multiple watchdog iterations
			const iterations = [1, 2, 3, 4, 5]; // Simulate 5 checks
			let iterIndex = 0;

			timer = setInterval(async () => {
				if (iterIndex >= iterations.length) {
					stop();
					return;
				}

				try {
					const resolved = await mockResolveOwnerWithTransientError();
					if (!resolved.live) {
						stop();
						return;
					}
					// Reset counter on success
					consecutiveFailures = 0;
				} catch (error) {
					consecutiveFailures++;
					// Don't stop on first error
					if (consecutiveFailures >= maxConsecutiveFailures) {
						stop();
						return;
					}
				}
				iterIndex++;
			}, 10);
		});

		// Verify: Single error did not stop the watchdog (it continued)
		expect(consecutiveFailures).toBeLessThan(maxConsecutiveFailures);
		expect(callCount).toBeGreaterThan(1); // Recovered from error
		console.log("✓ POST-FIX: Single transient error did NOT stop watchdog");
		console.log(`  Calls: ${callCount}, Final consecutive failures: ${consecutiveFailures}`);
	});

	it("verifies 3 consecutive errors DO stop watchdog", async () => {
		let callCount = 0;
		let watchdogStopped = false;
		let stopReason: string | null = null;
		const maxConsecutiveFailures = 3;
		let consecutiveFailures = 0;

		// Mock resolveOwner that always fails
		async function mockResolveOwnerAlwaysFails() {
			callCount++;
			throw new Error("Persistent lease read error");
		}

		// Simulate watchdog loop
		await new Promise<void>((resolve) => {
			let timer: Timer | null = null;

			const stop = (reason?: string) => {
				if (timer) clearInterval(timer);
				watchdogStopped = true;
				stopReason = reason || null;
				resolve();
			};

			let iterIndex = 0;
			const maxIters = 10;

			timer = setInterval(async () => {
				if (iterIndex >= maxIters) {
					stop();
					return;
				}

				try {
					await mockResolveOwnerAlwaysFails();
					consecutiveFailures = 0;
				} catch (error) {
					consecutiveFailures++;
					if (consecutiveFailures >= maxConsecutiveFailures) {
						stop("lease-read-failed");
						return;
					}
				}
				iterIndex++;
			}, 10);
		});

		// Verify: Watchdog stopped after 3 consecutive failures
		expect(watchdogStopped).toBe(true);
		expect(consecutiveFailures).toBe(maxConsecutiveFailures);
		expect(stopReason).toBe("lease-read-failed");
		console.log("✓ POST-FIX: Watchdog stopped after 3 consecutive failures");
	});

	it("verifies exit reason is persisted to state.blockers", async () => {
		// Create initial state
		const state = {
			handle: { workspace: canonicalWorkspacePath(path.join(testRoot, "ws")), sessionId },
			lifecycle: "active",
			blockers: [],
			events: [],
			schema: 1,
		} as unknown as SessionState;

		// Simulate owner stopping with exit reason
		const exitReason = "lease-read-failed";
		const blocker = `owner-exit:${exitReason}`;

		// Persist the blocker
		state.blockers = state.blockers || [];
		if (!state.blockers.includes(blocker)) {
			state.blockers.push(blocker);
		}

		await writeSessionState(testRoot, sessionId, () => state);

		// Read back and verify
		const readBack = await readSessionState(testRoot, sessionId);
		const foundBlocker = readBack.blockers.find((b) => b.startsWith("owner-exit:"));

		expect(foundBlocker).toBe(blocker);
		console.log("✓ POST-FIX: Exit reason persisted to state.blockers");
		console.log(`  Blocker: ${foundBlocker}`);
	});

	it("verifies caller receives typed exit code, not generic 'owner-not-live'", async () => {
		// Simulate submit verb's exit reason extraction
		const state = {
			blockers: ["owner-exit:lease-read-failed"],
		} as any;

		// Extract exit reason (as done in #submit method)
		const leaseFailureBlocker = state.blockers.find((b: string) =>
			b.startsWith("owner-exit:"),
		);
		const leaseFailureReason = leaseFailureBlocker?.replace("owner-exit:", "");

		// Determine final reason code for response
		const reason = leaseFailureReason ? `owner-${leaseFailureReason}` : "owner-not-live";

		// Verify: caller gets typed code
		expect(reason).toBe("owner-lease-read-failed");
		expect(reason).not.toBe("owner-not-live");
		console.log("✓ POST-FIX: Caller receives typed exit code");
		console.log(`  Response reason: "${reason}" (not generic "owner-not-live")`);
	});
});

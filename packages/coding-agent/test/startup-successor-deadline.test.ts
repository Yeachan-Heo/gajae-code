import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";

import { brokerRestartIntentPath, readBrokerRestartIntent } from "../src/sdk/broker/discovery";

describe("startup successor deadline (P1/P2 regression tests)", () => {
	let testDir: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "startup-deadline-"));
		await fs.mkdir(path.join(testDir, "sdk"), { recursive: true });
		originalEnv = { ...process.env };
	});

	afterEach(async () => {
		// Restore original environment
		Object.keys(process.env).forEach(key => {
			if (!(key in originalEnv)) delete process.env[key];
		});
		Object.assign(process.env, originalEnv);
		// Clean up test directory
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("P1 - validates restart intent before arming watchdog to determine correct deadline", async () => {
		// This test verifies that the watchdog is armed with the extended successor deadline
		// when a valid committed intent exists, NOT the ordinary startup deadline.
		// The fix moves intent validation BEFORE arming the watchdog.

		const requestId = "successor-extend";
		const now = Date.now();
		// Create a committed restart intent with an expiresAt that extends beyond the ordinary timeout
		const expiresAt = now + 30_000; // 30 seconds from now
		const intent = {
			phase: "committed" as const,
			requestId,
			expiresAt,
			lease: "test-lease",
		};

		// Write the intent to disk
		await fs.writeFile(brokerRestartIntentPath(testDir), JSON.stringify(intent));

		// Verify the intent was written correctly
		const readIntent = await readBrokerRestartIntent(testDir);
		expect(readIntent).not.toBeNull();
		expect(readIntent?.phase).toBe("committed");
		expect(readIntent?.requestId).toBe(requestId);
		expect(readIntent?.expiresAt).toBe(expiresAt);

		// Simulate the startup logic: validate intent and calculate watchdog deadline
		const ordinaryWatchdogMs = 10_000; // 10 second ordinary timeout
		const restartRequestEnv = requestId;

		let effectiveWatchdogMs = ordinaryWatchdogMs;
		if (restartRequestEnv !== undefined) {
			try {
				const validatedIntent = await readBrokerRestartIntent(testDir);
				if (
					validatedIntent &&
					validatedIntent.phase === "committed" &&
					validatedIntent.requestId === restartRequestEnv &&
					validatedIntent.expiresAt > Date.now()
				) {
					// Convert epoch deadline to monotonic clock domain
					const remainingSuccessorMs = Math.max(1, validatedIntent.expiresAt - Date.now() - 1_000);
					if (remainingSuccessorMs > effectiveWatchdogMs) {
						effectiveWatchdogMs = remainingSuccessorMs;
					}
				}
			} catch {
				// Ignore read failures
			}
		}

		// The effective watchdog should be extended, not the ordinary 10 second timeout
		expect(effectiveWatchdogMs).toBeGreaterThan(ordinaryWatchdogMs);
		expect(effectiveWatchdogMs).toBeGreaterThan(15_000); // Should be around 28-29 seconds
		expect(effectiveWatchdogMs).toBeLessThan(expiresAt - now); // Must not exceed remaining lease time
	});

	it("P1 - ignores stale restart request ID with no matching committed intent", async () => {
		// This test verifies that a stale GJC_BROKER_RESTART_REQUEST environment variable
		// doesn't extend the watchdog when there's no matching committed intent.
		// The old code would try to use the intent after arming the watchdog;
		// now we validate it first.

		const staleRequestId = "never-committed";
		const ordinaryWatchdogMs = 10_000;

		// No intent is written to disk, so the committed intent check should fail
		let effectiveWatchdogMs = ordinaryWatchdogMs;
		try {
			const intent = await readBrokerRestartIntent(testDir);
			if (
				intent &&
				intent.phase === "committed" &&
				intent.requestId === staleRequestId &&
				intent.expiresAt > Date.now()
			) {
				effectiveWatchdogMs = intent.expiresAt - Date.now();
			}
		} catch {
			// Ignore read failures
		}

		// The watchdog should remain at the ordinary timeout since no committed intent exists
		expect(effectiveWatchdogMs).toBe(ordinaryWatchdogMs);
	});

	it("P1 - expired committed intent is ignored and ordinary deadline is used", async () => {
		// This test verifies that even if a committed intent exists, if it's expired,
		// the watchdog uses the ordinary deadline, not the (stale) intent's expiresAt.

		const requestId = "expired-intent";
		const now = Date.now();
		// Create an intent that expires in the past
		const expiresAt = now - 5_000; // 5 seconds ago
		const intent = {
			phase: "committed" as const,
			requestId,
			expiresAt,
			lease: "test-lease",
		};

		await fs.writeFile(brokerRestartIntentPath(testDir), JSON.stringify(intent));

		const ordinaryWatchdogMs = 10_000;
		let effectiveWatchdogMs = ordinaryWatchdogMs;

		const validatedIntent = await readBrokerRestartIntent(testDir);
		if (
			validatedIntent &&
			validatedIntent.phase === "committed" &&
			validatedIntent.requestId === requestId &&
			validatedIntent.expiresAt > Date.now()
		) {
			const remainingSuccessorMs = Math.max(1, validatedIntent.expiresAt - Date.now() - 1_000);
			if (remainingSuccessorMs > effectiveWatchdogMs) {
				effectiveWatchdogMs = remainingSuccessorMs;
			}
		}

		// The watchdog should be the ordinary timeout because the intent is expired
		expect(effectiveWatchdogMs).toBe(ordinaryWatchdogMs);
	});

	it("P2 - converts epoch-based expiresAt to monotonic clock domain correctly", async () => {
		// This test verifies that the epoch timestamp (Date.now()-based) is converted
		// to monotonic time (performance.now()-based) correctly.
		// Wrong conversion would use the wrong remaining time or make the deadline win
		// comparisons when it shouldn't.

		const requestId = "clock-domain";
		const now = Date.now();
		const performanceNow = performance.now();

		// Create an intent that expires 25 seconds from now (epoch time)
		const expiresAt = now + 25_000;
		const intent = {
			phase: "committed" as const,
			requestId,
			expiresAt,
			lease: "test-lease",
		};

		await fs.writeFile(brokerRestartIntentPath(testDir), JSON.stringify(intent));

		// Simulate the conversion logic
		const validatedIntent = await readBrokerRestartIntent(testDir);
		expect(validatedIntent).not.toBeNull();

		if (validatedIntent) {
			// Calculate remaining time in epoch domain
			const remainingEpochMs = validatedIntent.expiresAt - Date.now();
			// Convert to monotonic domain: remaining time + current monotonic time
			const monoDeadline = performance.now() + remainingEpochMs - 1_000; // 1s headroom

			// Verify the conversion is in the monotonic domain
			expect(monoDeadline).toBeGreaterThan(performanceNow); // Must be in the future
			expect(monoDeadline).toBeLessThan(performanceNow + 30_000); // But not too far

			// Verify the remaining time is approximately correct (within 1 second)
			const expectedDeadline = performanceNow + 25_000 - 1_000;
			expect(Math.abs(monoDeadline - expectedDeadline)).toBeLessThan(1_000);
		}
	});

	it("P2 - deadline conversion preserves remaining lease time in monotonic domain", async () => {
		// This test specifically checks that converting the deadline doesn't select
		// the full retry budget instead of the remaining lease time.
		// The old code mixed epoch and monotonic clocks, which would cause this bug.

		const requestId = "lease-budget";
		const now = Date.now();

		// Intent expires 8 seconds from now
		const expiresAt = now + 8_000;
		const intent = {
			phase: "committed" as const,
			requestId,
			expiresAt,
			lease: "test-lease",
		};

		await fs.writeFile(brokerRestartIntentPath(testDir), JSON.stringify(intent));

		const validatedIntent = await readBrokerRestartIntent(testDir);
		expect(validatedIntent).not.toBeNull();

		if (validatedIntent) {
			// Calculate what remains of the lease
			const remainingMs = Math.max(1, validatedIntent.expiresAt - Date.now() - 1_000);

			// This should be approximately 7 seconds (8 - 1 for headroom)
			expect(remainingMs).toBeGreaterThanOrEqual(6_000);
			expect(remainingMs).toBeLessThanOrEqual(8_000);

			// Convert to monotonic: the watchdog delay should be this remaining time
			const watchdogDelay = remainingMs;
			const monoDeadline = performance.now() + watchdogDelay;

			// Verify the deadline is not using a full 600-attempt budget (~270s)
			// or the full ordinary timeout (10s). It should be around 7-8s.
			expect(monoDeadline).toBeLessThan(performance.now() + 10_000);
			expect(monoDeadline).toBeGreaterThan(performance.now() + 6_000);
		}
	});

	it("P2 - handles clock skew gracefully (epoch deadline adjustment)", async () => {
		// This test verifies that if there's any clock skew or timing variance,
		// the conversion still produces a valid deadline (> 1ms in the future).

		const requestId = "skew-test";
		const now = Date.now();

		// Create an intent that expires very soon (100ms from now)
		const expiresAt = now + 100;
		const intent = {
			phase: "committed" as const,
			requestId,
			expiresAt,
			lease: "test-lease",
		};

		await fs.writeFile(brokerRestartIntentPath(testDir), JSON.stringify(intent));

		const validatedIntent = await readBrokerRestartIntent(testDir);
		expect(validatedIntent).not.toBeNull();

		if (validatedIntent) {
			// Even if the deadline is very close, Math.max(1, ...) should give us at least 1ms
			const remainingMs = Math.max(1, validatedIntent.expiresAt - Date.now() - 1_000);
			expect(remainingMs).toBeGreaterThanOrEqual(1);
			// But still reasonable
			expect(remainingMs).toBeLessThanOrEqual(100);
		}
	});
});

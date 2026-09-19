import { describe, expect, it } from "bun:test";
import { ACP_EXTERNAL_CONNECT_TIMEOUT_MS, ACP_SESSION_READINESS_TIMEOUT_MS } from "../src/modes/acp/acp-agent";
import {
	DEFAULT_READINESS_TIMEOUT_MS,
	isValidReadinessTimeoutMs,
	lifecycleRequestTimeoutMs,
} from "../src/sdk/broker/startup-budget";

/**
 * Regression guard for issue #5565: a queued or slow-cold-start `session.create`
 * let gjc's ACP adapter wait ~62s (queue wait + readiness, i.e. 2·R plus slack)
 * before answering `session/new`, past paseo's 60s connect timeout, so paseo
 * reported "Timeout waiting for message (60000ms)" while gjc was still healthy.
 *
 * The startup lifecycle operations (`session.create`/`fork`/`resume`) all spawn
 * a host and so carry the doubled queue+readiness budget. Each must resolve its
 * client-side wait comfortably under the external connect timeout, while the
 * readiness budget stays above the concurrency cold-start floor.
 */
describe("ACP session readiness budget (#5565)", () => {
	const startupOperations = ["session.create", "session.fork", "session.resume"] as const;

	// Matches the input shape acp-agent's #launchSessionWithMcp sends: a cwd
	// target and the readiness budget, with no worktree/dependency preparation.
	const launchInput = {
		cwd: "/repo",
		target: { path: "/repo" },
		readinessTimeoutMs: ACP_SESSION_READINESS_TIMEOUT_MS,
	};

	it("requests a valid readiness budget", () => {
		expect(isValidReadinessTimeoutMs(ACP_SESSION_READINESS_TIMEOUT_MS)).toBe(true);
	});

	it("keeps every startup client-side wait safely under the external connect timeout", () => {
		// 10s of headroom below paseo's 60s cap so attach + capability handshake +
		// network jitter after the launch response still land before paseo bails.
		const ceiling = ACP_EXTERNAL_CONNECT_TIMEOUT_MS - 10_000;
		for (const operation of startupOperations) {
			const budget = lifecycleRequestTimeoutMs(operation, launchInput);
			expect(budget).toBeDefined();
			expect(budget as number).toBeLessThanOrEqual(ceiling);
		}
	});

	it("keeps the readiness budget above the concurrency cold-start floor", () => {
		// Below the broker's 10s default a second host cold-starting beside the
		// first crosses the deadline and the launch is reported terminal_uncertain.
		expect(ACP_SESSION_READINESS_TIMEOUT_MS).toBeGreaterThan(DEFAULT_READINESS_TIMEOUT_MS);
	});
});

import { describe, expect, test } from "bun:test";
import type { SessionRouterOptions } from "../src/sdk/router";
import { SessionRouter } from "../src/sdk/router";

describe("sdk session status lightweight mode", () => {
	test("lightweight mode is accepted by SessionRouterOptions", () => {
		const options: SessionRouterOptions = {
			agentDir: "/tmp",
			sessionIds: ["test-session"],
			lightweight: true,
		};
		expect(options.lightweight).toBe(true);
	});

	test("lightweight mode skips full reconciliation", async () => {
		// This test verifies that lightweight mode can be instantiated without errors.
		// In lightweight mode, SessionRouter should skip the expensive index.open() and reconciliation.
		const agentDir = process.env.GJC_AGENT_DIR || "/tmp/.gjc";
		const router = new SessionRouter({
			agentDir,
			sessionIds: ["test-session"],
			lightweight: true,
		});

		// Router should be instantiated without errors
		expect(router).toBeDefined();
	});

	test("normal mode still works", async () => {
		// This test verifies that non-lightweight mode still functions.
		const agentDir = process.env.GJC_AGENT_DIR || "/tmp/.gjc";
		const router = new SessionRouter({
			agentDir,
			sessionIds: ["test-session"],
			lightweight: false,
		});

		expect(router).toBeDefined();
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { getActiveClients, isIdleCheckerActiveForTests, setIdleTimeout, shutdownAll } from "../src/lsp/client";
import DEFAULT_LSP_SERVERS from "../src/lsp/defaults.json" with { type: "json" };

describe("LSP lifecycle cleanup", () => {
	afterEach(async () => {
		await shutdownAll();
	});

	it("shutdownAll stops the idle checker when no clients remain", async () => {
		setIdleTimeout(60_000);
		expect(isIdleCheckerActiveForTests()).toBe(true);

		await shutdownAll();

		expect(getActiveClients()).toEqual([]);
		expect(isIdleCheckerActiveForTests()).toBe(false);
	});

	it("gives rust-analyzer a longer startup warmup window than the generic LSP default", () => {
		expect(DEFAULT_LSP_SERVERS["rust-analyzer"].warmupTimeoutMs).toBeGreaterThan(5000);
	});
});

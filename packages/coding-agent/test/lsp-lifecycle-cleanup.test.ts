import { afterEach, describe, expect, it } from "bun:test";
import { getActiveClients, isIdleCheckerActiveForTests, setIdleTimeout, shutdownAll } from "../src/lsp/client";

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
});

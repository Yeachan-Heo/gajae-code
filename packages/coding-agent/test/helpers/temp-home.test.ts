import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withTempHome } from "./temp-home";

const originalHome = process.env.HOME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	vi.restoreAllMocks();
});

describe("withTempHome", () => {
	test("overrides HOME and os.homedir inside fn, restores and cleans up after", async () => {
		let seenHome = "";
		let seenRoot = "";
		await withTempHome(async home => {
			seenHome = home;
			seenRoot = path.dirname(home);
			expect(process.env.HOME).toBe(home);
			expect(os.homedir()).toBe(home);
			// The override is asserted in-effect: strictly inside the canonical temp root.
			expect(fs.realpathSync(home).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
			fs.mkdirSync(path.join(home, ".gjc", "skills"), { recursive: true });
		});
		expect(process.env.HOME).toBe(originalHome);
		expect(os.homedir()).toBe(originalHome ?? os.homedir());
		expect(seenHome).not.toBe(originalHome);
		// Cleanup removed the whole owning root.
		expect(fs.existsSync(seenRoot)).toBe(false);
	});

	test("cleans up and restores even when fn throws", async () => {
		let seenRoot = "";
		await expect(
			withTempHome(async home => {
				seenRoot = path.dirname(home);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(process.env.HOME).toBe(originalHome);
		expect(fs.existsSync(seenRoot)).toBe(false);
	});

	test("restores HOME when it was previously unset", async () => {
		delete process.env.HOME;
		await withTempHome(async () => {
			expect(process.env.HOME).toBeDefined();
		});
		expect(process.env.HOME).toBeUndefined();
	});

	test("leaves os.homedir untouched when mockHomedir is disabled", async () => {
		const realHomedir = os.homedir();
		await withTempHome(
			async home => {
				expect(process.env.HOME).toBe(home);
				expect(os.homedir()).toBe(realHomedir);
			},
			{ mockHomedir: false },
		);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import {
	cleanupStaleScreenshotFallbackDirs,
	hasCreatedScreenshotFallbackDir,
	markScreenshotFallbackDirCreatedForGc,
	resetScreenshotFallbackGcForTest,
	SCREENSHOT_FALLBACK_DIR_PREFIX,
} from "../../src/tools/computer-gc";

describe("computer screenshot GC", () => {
	let base: string;
	const NOW = 10_000_000_000; // fixed clock in ms
	const STALE_MS = 1000;

	beforeEach(async () => {
		base = path.join(os.tmpdir(), "test-computer-gc", Snowflake.next());
		await fs.mkdir(base, { recursive: true });
		resetScreenshotFallbackGcForTest();
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	const makeDir = async (name: string, ageMs: number): Promise<string> => {
		const dir = path.join(base, name);
		await fs.mkdir(dir, { recursive: true });
		const mtimeSeconds = (NOW - ageMs) / 1000;
		await fs.utimes(dir, mtimeSeconds, mtimeSeconds);
		return dir;
	};

	const exists = async (dir: string): Promise<boolean> =>
		await fs
			.stat(dir)
			.then(() => true)
			.catch(() => false);

	it("removes only stale matching directories, preserving recent and non-matching ones", async () => {
		const oldMatching = await makeDir(`${SCREENSHOT_FALLBACK_DIR_PREFIX}old`, 5000);
		const recentMatching = await makeDir(`${SCREENSHOT_FALLBACK_DIR_PREFIX}recent`, 100);
		const oldNonMatching = await makeDir("some-other-tooldir-old", 5000);

		const result = await cleanupStaleScreenshotFallbackDirs({ now: () => NOW, staleMs: STALE_MS, tmpDir: base });

		expect(result.removed).toBe(1);
		expect(await exists(oldMatching)).toBe(false);
		expect(await exists(recentMatching)).toBe(true);
		expect(await exists(oldNonMatching)).toBe(true);
	});

	it("does not throw and removes nothing when the base dir is missing", async () => {
		const missing = path.join(base, "does-not-exist");
		const result = await cleanupStaleScreenshotFallbackDirs({ now: () => NOW, staleMs: STALE_MS, tmpDir: missing });
		expect(result).toEqual({ scanned: 0, removed: 0 });
	});

	it("tracks the lazy-arm marker", () => {
		expect(hasCreatedScreenshotFallbackDir()).toBe(false);
		markScreenshotFallbackDirCreatedForGc();
		expect(hasCreatedScreenshotFallbackDir()).toBe(true);
		resetScreenshotFallbackGcForTest();
		expect(hasCreatedScreenshotFallbackDir()).toBe(false);
	});
});

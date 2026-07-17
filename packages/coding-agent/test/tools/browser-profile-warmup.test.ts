import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CHROME_LOCK_ARTIFACTS,
	collectWarmupArtifacts,
	WARMUP_ARTIFACTS,
} from "../../src/tools/browser/profile-warmup";

let root: string;
let source: string;
let dest: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "warmup-test-"));
	source = path.join(root, "Profile 1");
	dest = path.join(root, "isolated");
	fs.mkdirSync(source, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("collectWarmupArtifacts", () => {
	it("copies allowlisted artifacts into the isolated dir", () => {
		fs.writeFileSync(path.join(source, "Cookies"), "cookie-bytes");
		fs.mkdirSync(path.join(source, "Local Storage"), { recursive: true });
		fs.writeFileSync(path.join(source, "Local Storage", "leveldb"), "ls-bytes");

		const manifest = collectWarmupArtifacts(source, dest);

		expect(manifest.copied).toContain("Cookies");
		expect(manifest.copied).toContain("Local Storage");
		expect(fs.readFileSync(path.join(dest, "Cookies"), "utf8")).toBe("cookie-bytes");
		expect(fs.readFileSync(path.join(dest, "Local Storage", "leveldb"), "utf8")).toBe("ls-bytes");
	});

	it("never copies Chromium lock artifacts but records them", () => {
		for (const lock of CHROME_LOCK_ARTIFACTS) {
			fs.writeFileSync(path.join(source, lock), "lock");
		}
		fs.writeFileSync(path.join(source, "Cookies"), "c");

		const manifest = collectWarmupArtifacts(source, dest);

		for (const lock of CHROME_LOCK_ARTIFACTS) {
			expect(manifest.excludedLocks).toContain(lock);
			expect(fs.existsSync(path.join(dest, lock))).toBe(false);
		}
	});

	it("excludes lock artifacts nested inside copied directories", () => {
		const networkDir = path.join(source, "Network");
		fs.mkdirSync(networkDir, { recursive: true });
		fs.writeFileSync(path.join(networkDir, "Cookies"), "cookie-bytes");
		fs.writeFileSync(path.join(networkDir, "SingletonLock"), "lock");

		const manifest = collectWarmupArtifacts(source, dest);

		expect(manifest.excludedLocks).toContain("SingletonLock");
		expect(fs.existsSync(path.join(dest, "Network", "SingletonLock"))).toBe(false);
		expect(fs.readFileSync(path.join(dest, "Network", "Cookies"), "utf8")).toBe("cookie-bytes");
	});

	it("never mutates the source profile", () => {
		fs.writeFileSync(path.join(source, "Cookies"), "original");
		const before = fs.readdirSync(source).sort();

		collectWarmupArtifacts(source, dest);

		const after = fs.readdirSync(source).sort();
		expect(after).toEqual(before);
		expect(fs.readFileSync(path.join(source, "Cookies"), "utf8")).toBe("original");
	});

	it("rejects a destination inside the source profile", () => {
		expect(() => collectWarmupArtifacts(source, path.join(source, "isolated"))).toThrow(
			"destination must be outside",
		);
		expect(fs.existsSync(path.join(source, "isolated"))).toBe(false);
	});

	it("skips missing artifacts without failing", () => {
		const manifest = collectWarmupArtifacts(source, dest);
		expect(manifest.copied).toEqual([]);
		expect(manifest.skippedMissing).toEqual([...WARMUP_ARTIFACTS]);
	});

	it("throws when the source profile is absent", () => {
		expect(() => collectWarmupArtifacts(path.join(root, "nope"), dest)).toThrow("does not exist");
	});
});

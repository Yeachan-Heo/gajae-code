import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { chromeUserDataRoots, discoverDefaultChromeProfile } from "../../src/tools/browser/profile-discovery";
import { resolveProfileReuse } from "../../src/tools/browser/profile-reuse";
import type { WarmupManifest } from "../../src/tools/browser/profile-warmup";

const env = (opts: { platform: NodeJS.Platform; home: string; existing: string[] }) => ({
	platform: opts.platform,
	home: opts.home,
	exists: (p: string) => opts.existing.includes(p),
});

describe("profile-discovery", () => {
	it("returns the darwin default profile when it exists", () => {
		const root = "/Users/x/Library/Application Support/Google/Chrome";
		const profileDir = path.join(root, "Default");
		const found = discoverDefaultChromeProfile(env({ platform: "darwin", home: "/Users/x", existing: [profileDir] }));
		expect(found?.userDataDir).toBe(root);
		expect(found?.profileDirectory).toBe("Default");
	});

	it("returns null when no profile directory exists", () => {
		const found = discoverDefaultChromeProfile(env({ platform: "linux", home: "/home/x", existing: [] }));
		expect(found).toBeNull();
	});

	it("lists platform-appropriate roots", () => {
		expect(chromeUserDataRoots(env({ platform: "linux", home: "/home/x", existing: [] }))).toEqual([
			"/home/x/.config/google-chrome",
			"/home/x/.config/chromium",
		]);
	});
});

describe("resolveProfileReuse", () => {
	it("auto default: copies from the discovered profile into an isolated dir", () => {
		const root = "/Users/x/Library/Application Support/Google/Chrome";
		const profileDir = path.join(root, "Default");
		let copiedFrom = "";
		let copiedTo = "";
		const fakeCopy = (src: string, dest: string): WarmupManifest => {
			copiedFrom = src;
			copiedTo = dest;
			return { sourceProfileDir: src, destDir: dest, copied: ["Cookies"], skippedMissing: [], excludedLocks: [] };
		};
		const res = resolveProfileReuse({
			discoveryEnv: env({ platform: "darwin", home: "/Users/x", existing: [profileDir] }),
			destDir: "/tmp/iso",
			copy: fakeCopy,
		});
		expect(res.mode).toBe("real");
		expect(res.warning).toContain("isolated copy");
		expect(copiedFrom).toBe(profileDir);
		expect(copiedTo).toBe("/tmp/iso");
		expect(res.warmupDir).toBe("/tmp/iso");
	});

	it("falls back to synthetic when no profile is discovered (no copy attempted)", () => {
		let copyCalled = false;
		const res = resolveProfileReuse({
			discoveryEnv: env({ platform: "linux", home: "/home/x", existing: [] }),
			copy: () => {
				copyCalled = true;
				throw new Error("should not copy");
			},
		});
		expect(res.mode).toBe("synthetic");
		expect(res.warmupDir).toBeNull();
		expect(copyCalled).toBe(false);
	});

	it("opt-in without explicit request stays synthetic even when a profile exists", () => {
		const profileDir = "/home/x/.config/google-chrome/Default";
		const res = resolveProfileReuse({
			posture: "opt-in",
			discoveryEnv: env({ platform: "linux", home: "/home/x", existing: [profileDir] }),
			copy: () => {
				throw new Error("should not copy");
			},
		});
		expect(res.mode).toBe("synthetic");
	});
});

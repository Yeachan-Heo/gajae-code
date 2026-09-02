import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canDecryptProfileCookies } from "../../src/tools/browser/launch";
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
			"/home/x/.config/google-chrome-beta",
			"/home/x/.config/google-chrome-unstable",
			"/home/x/.config/google-chrome-canary",
			"/home/x/.config/chromium",
			"/home/x/.var/app/com.google.Chrome/config/google-chrome",
			"/home/x/.var/app/org.chromium.Chromium/config/chromium",
			"/home/x/snap/chromium/common/chromium",
			"/home/x/snap/chromium/current/.config/chromium",
		]);
		expect(
			chromeUserDataRoots({
				platform: "linux",
				home: "/home/x",
				exists: () => false,
				chromeUserDataDir: "/srv/chrome-default",
				chromeConfigHome: "/srv/chrome-config",
				xdgConfigHome: "/srv/xdg-ignored",
			}),
		).toEqual([
			"/srv/chrome-default",
			"/srv/chrome-config/google-chrome",
			"/srv/chrome-config/google-chrome-beta",
			"/srv/chrome-config/google-chrome-unstable",
			"/srv/chrome-config/google-chrome-canary",
			"/srv/chrome-config/chromium",
			"/home/x/.var/app/com.google.Chrome/config/google-chrome",
			"/home/x/.var/app/org.chromium.Chromium/config/chromium",
			"/home/x/snap/chromium/common/chromium",
			"/home/x/snap/chromium/current/.config/chromium",
		]);
		expect(chromeUserDataRoots(env({ platform: "darwin", home: "/Users/x", existing: [] }))).toEqual([
			"/Users/x/Library/Application Support/Google/Chrome",
			"/Users/x/Library/Application Support/Google/Chrome Beta",
			"/Users/x/Library/Application Support/Google/Chrome Dev",
			"/Users/x/Library/Application Support/Google/Chrome Canary",
			"/Users/x/Library/Application Support/Chromium",
		]);
		expect(
			chromeUserDataRoots({
				platform: "win32",
				home: "C:\\Users\\x",
				localAppData: "C:\\Users\\x\\AppData\\Local",
				exists: () => false,
			}),
		).toEqual([
			"C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data",
			"C:\\Users\\x\\AppData\\Local\\Google\\Chrome Beta\\User Data",
			"C:\\Users\\x\\AppData\\Local\\Google\\Chrome Dev\\User Data",
			"C:\\Users\\x\\AppData\\Local\\Google\\Chrome SxS\\User Data",
			"C:\\Users\\x\\AppData\\Local\\Chromium\\User Data",
		]);
	});

	it("joins profile paths with the requested platform semantics", () => {
		const root = "C:\\Users\\x\\AppData\\Local\\Google\\Chrome Beta\\User Data";
		const profileDir = `${root}\\Profile 2`;
		const found = discoverDefaultChromeProfile(
			{
				platform: "win32",
				home: "C:\\Users\\x",
				localAppData: "C:\\Users\\x\\AppData\\Local",
				exists: candidate => candidate === profileDir,
			},
			"Profile 2",
		);
		expect(found).toEqual({ userDataDir: root, profileDirectory: "Profile 2", profileDir });
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

	it("falls back to synthetic and removes an owned temp copy when warm-up fails", () => {
		const profileDir = "/home/x/.config/google-chrome/Default";
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-reuse-fallback-"));
		const res = resolveProfileReuse({
			discoveryEnv: env({ platform: "linux", home: "/home/x", existing: [profileDir] }),
			makeTempDir: () => tempDir,
			copy: (_source, dest) => {
				fs.writeFileSync(path.join(dest, "partial"), "partial");
				throw new Error("profile changed during copy");
			},
		});

		expect(res.mode).toBe("synthetic");
		expect(res.reason).toBe("synthetic-copy-failed");
		expect(res.warning).toContain("using synthetic browser state instead");
		expect(res.warmupDir).toBeNull();
		expect(fs.existsSync(tempDir)).toBe(false);
	});

	it("falls back to synthetic when the isolated temp directory cannot be created", () => {
		const profileDir = "/home/x/.config/google-chrome/Default";
		const res = resolveProfileReuse({
			discoveryEnv: env({ platform: "linux", home: "/home/x", existing: [profileDir] }),
			makeTempDir: () => {
				throw new Error("temp unavailable");
			},
		});

		expect(res.mode).toBe("synthetic");
		expect(res.reason).toBe("synthetic-copy-failed");
		expect(res.warning).toContain("temp unavailable");
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

describe("canDecryptProfileCookies", () => {
	it("darwin: Chrome profile vs bundled Chromium (no executable) is incompatible", () => {
		expect(canDecryptProfileCookies(undefined, "/Users/x/Library/Application Support/Google/Chrome", "darwin")).toBe(
			false,
		);
	});

	it("darwin: Chrome profile vs Chromium executable is incompatible", () => {
		expect(
			canDecryptProfileCookies(
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
				"/Users/x/Library/Application Support/Google/Chrome",
				"darwin",
			),
		).toBe(false);
	});

	it("darwin: Chrome profile vs Chrome executable is compatible", () => {
		expect(
			canDecryptProfileCookies(
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Users/x/Library/Application Support/Google/Chrome",
				"darwin",
			),
		).toBe(true);
	});

	it("darwin: Chromium profile vs Chrome executable is incompatible", () => {
		expect(
			canDecryptProfileCookies(
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Users/x/Library/Application Support/Chromium",
				"darwin",
			),
		).toBe(false);
	});

	it("darwin: no discovered profile is compatible (no copy needed)", () => {
		expect(canDecryptProfileCookies(undefined, undefined, "darwin")).toBe(true);
	});

	it("linux: any combination is compatible (Keychain brand not applicable)", () => {
		expect(canDecryptProfileCookies(undefined, "/home/x/.config/google-chrome", "linux")).toBe(true);
		expect(canDecryptProfileCookies("/usr/bin/chromium", "/home/x/.config/google-chrome", "linux")).toBe(true);
	});
});

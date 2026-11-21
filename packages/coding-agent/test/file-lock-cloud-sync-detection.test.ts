import { describe, expect, test } from "bun:test";
import { detectCloudSyncPath, FileLockAcquireError } from "../src/config/file-lock";

const mac = { platform: "darwin" as const, home: "/Users/alice", env: {} };
const linux = { platform: "linux" as const, home: "/home/alice", env: {} };
const win = {
	platform: "win32" as const,
	home: "C:\\Users\\alice",
	env: { OneDrive: "C:\\Users\\alice\\OneDrive - Contoso" },
};

describe("detectCloudSyncPath", () => {
	test("detects iCloud Drive and CloudStorage providers on macOS", () => {
		expect(detectCloudSyncPath("/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/p/.gjc/x.lock", mac)).toBe(
			"iCloud Drive",
		);
		expect(detectCloudSyncPath("/Users/alice/Library/CloudStorage/OneDrive-Contoso/p/x.lock", mac)).toBe("OneDrive");
		expect(detectCloudSyncPath("/Users/alice/Library/CloudStorage/Dropbox/p/x.lock", mac)).toBe("Dropbox");
		expect(detectCloudSyncPath("/Users/alice/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/x.lock", mac)).toBe(
			"Google Drive",
		);
		expect(detectCloudSyncPath("/Users/alice/Library/CloudStorage/Box-Box/x.lock", mac)).toBe("cloud storage");
	});

	test("matches macOS paths case-insensitively", () => {
		expect(detectCloudSyncPath("/users/alice/library/mobile documents/x.lock", mac)).toBe("iCloud Drive");
	});

	test("detects OneDrive from env roots on Windows case-insensitively", () => {
		expect(detectCloudSyncPath("c:\\users\\alice\\onedrive - contoso\\repo\\.gjc\\x.lock", win)).toBe("OneDrive");
		expect(detectCloudSyncPath("C:\\Users\\alice\\Dropbox\\repo\\x.lock", win)).toBe("Dropbox");
	});

	test("does not match sibling prefixes or ordinary paths", () => {
		expect(detectCloudSyncPath("/home/alice/Dropbox-old/x.lock", linux)).toBeUndefined();
		expect(detectCloudSyncPath("C:\\Users\\alice\\OneDrive - Contoso2\\x.lock", win)).toBeUndefined();
		expect(detectCloudSyncPath("/home/alice/.gjc/agent/x.lock", linux)).toBeUndefined();
		expect(detectCloudSyncPath("/Users/alice/Library/Mobile Documents/x.lock", linux)).toBeUndefined();
	});

	test("detects Dropbox and Google Drive roots on Linux", () => {
		expect(detectCloudSyncPath("/home/alice/Dropbox/repo/x.lock", linux)).toBe("Dropbox");
		expect(detectCloudSyncPath("/home/alice/Google Drive/repo/x.lock", linux)).toBe("Google Drive");
	});
});

describe("FileLockAcquireError cloud-sync hint", () => {
	const make = (code: "access_denied" | "sharing_violation" | undefined, holderIsLive: boolean) =>
		new FileLockAcquireError(
			"/p/f",
			"/p/f.lock",
			2,
			"holder",
			"acquire_timeout",
			undefined,
			undefined,
			code,
			holderIsLive,
		).message;

	test("access_denied without a live owner carries the sync-folder hint", () => {
		expect(make("access_denied", false)).toContain("cloud-synced folder");
	});

	test("live owners and other failures do not", () => {
		expect(make("access_denied", true)).not.toContain("cloud-synced folder");
		expect(make("sharing_violation", false)).not.toContain("cloud-synced folder");
		expect(make(undefined, false)).not.toContain("cloud-synced folder");
	});
});

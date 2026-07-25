import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	type DirectorySyncHandle,
	isUnsupportedWindowsDirectorySyncError,
	syncDirectoryBestEffort,
	syncDirectoryBestEffortSync,
	syncDirectoryFullyBestEffort,
	syncDirectoryFullyBestEffortSync,
} from "../../src/utils/directory-sync";

function errnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("isUnsupportedWindowsDirectorySyncError", () => {
	it("accepts only the known unsupported Windows directory-sync codes", () => {
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EPERM" }, "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EINVAL" }, "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "ENOTSUP" }, "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EOPNOTSUPP" }, "win32")).toBe(true);
	});

	it("fails closed for unexpected directory-sync failures", () => {
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EACCES" }, "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EBADF" }, "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EIO" }, "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError(new Error("fsync"), "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError(undefined, "win32")).toBe(false);
	});

	it("never classifies on non-Windows platforms", () => {
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EPERM" }, "darwin")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError({ code: "EINVAL" }, "linux")).toBe(false);
	});
});

describe("syncDirectoryBestEffort", () => {
	function fakeHandle(input: {
		calls: string[];
		syncError?: NodeJS.ErrnoException;
		closeError?: NodeJS.ErrnoException;
	}): DirectorySyncHandle {
		return {
			sync: async () => {
				input.calls.push("sync");
				if (input.syncError) throw input.syncError;
			},
			close: async () => {
				input.calls.push("close");
				if (input.closeError) throw input.closeError;
			},
		};
	}

	it("opens, syncs, and closes in order on the happy path", async () => {
		const calls: string[] = [];
		await syncDirectoryBestEffort("/state/sdk", {
			platform: "linux",
			open: async directory => {
				calls.push(`open:${directory}`);
				return fakeHandle({ calls });
			},
		});
		expect(calls).toEqual(["open:/state/sdk", "sync", "close"]);
	});

	it("propagates directory open failures and never reaches sync or close", async () => {
		const calls: string[] = [];
		await expect(
			syncDirectoryBestEffort("/state/sdk", {
				platform: "win32",
				open: async () => {
					calls.push("open");
					throw errnoError("EPERM");
				},
			}),
		).rejects.toMatchObject({ code: "EPERM" });
		expect(calls).toEqual(["open"]);
	});

	it("tolerates only classified Windows sync failures and still closes the handle", async () => {
		for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]) {
			const calls: string[] = [];
			await syncDirectoryBestEffort("/state/sdk", {
				platform: "win32",
				open: async () => fakeHandle({ calls, syncError: errnoError(code) }),
			});
			expect(calls).toEqual(["sync", "close"]);
		}
	});

	it("propagates unclassified Windows sync failures and still closes the handle", async () => {
		for (const code of ["EACCES", "EBADF", "EIO"]) {
			const calls: string[] = [];
			await expect(
				syncDirectoryBestEffort("/state/sdk", {
					platform: "win32",
					open: async () => fakeHandle({ calls, syncError: errnoError(code) }),
				}),
			).rejects.toMatchObject({ code });
			expect(calls).toEqual(["sync", "close"]);
		}
	});

	it("propagates every sync failure on non-Windows platforms", async () => {
		for (const platform of ["linux", "darwin"] as const) {
			const calls: string[] = [];
			await expect(
				syncDirectoryBestEffort("/state/sdk", {
					platform,
					open: async () => fakeHandle({ calls, syncError: errnoError("EPERM") }),
				}),
			).rejects.toMatchObject({ code: "EPERM" });
			expect(calls).toEqual(["sync", "close"]);
		}
	});

	it("propagates close failures after a successful sync", async () => {
		const calls: string[] = [];
		await expect(
			syncDirectoryBestEffort("/state/sdk", {
				platform: "win32",
				open: async () => fakeHandle({ calls, closeError: errnoError("EBADF") }),
			}),
		).rejects.toMatchObject({ code: "EBADF" });
		expect(calls).toEqual(["sync", "close"]);
	});

	it("propagates close failures even when the sync failure was tolerated", async () => {
		const calls: string[] = [];
		await expect(
			syncDirectoryBestEffort("/state/sdk", {
				platform: "win32",
				open: async () => fakeHandle({ calls, syncError: errnoError("EPERM"), closeError: errnoError("EBADF") }),
			}),
		).rejects.toMatchObject({ code: "EBADF" });
		expect(calls).toEqual(["sync", "close"]);
	});

	it("resolves against a real directory on every platform", async () => {
		// On Windows the real handle.sync() raises the unsupported EPERM this
		// utility exists to tolerate; on Linux/macOS the sync genuinely succeeds.
		const directory = mkdtempSync(path.join(tmpdir(), "gjc-directory-sync-"));
		try {
			await expect(syncDirectoryBestEffort(directory)).resolves.toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
describe("synchronous directory sync policies", () => {
	it("tolerates only classified Windows sync failures for the durability contract", () => {
		const calls: string[] = [];
		syncDirectoryBestEffortSync("/state/sdk", {
			platform: "win32",
			open: directory => {
				calls.push(`open:${directory}`);
				return 1;
			},
			sync: () => {
				calls.push("sync");
				throw errnoError("EPERM");
			},
			close: () => calls.push("close"),
		});
		expect(calls).toEqual(["open:/state/sdk", "sync", "close"]);
		for (const code of ["EACCES", "EBADF", "EIO"]) {
			expect(() =>
				syncDirectoryBestEffortSync("/state/sdk", {
					platform: "win32",
					open: () => 1,
					sync: () => {
						throw errnoError(code);
					},
					close: () => undefined,
				}),
			).toThrow(code);
		}
	});

	it("fully best-effort policies ignore open, sync, and close failures", async () => {
		await expect(
			syncDirectoryFullyBestEffort("/state/sdk", {
				open: async () => {
					throw errnoError("EACCES");
				},
			}),
		).resolves.toBeUndefined();
		await expect(
			syncDirectoryFullyBestEffort("/state/sdk", {
				open: async () => ({
					sync: async () => {
						throw errnoError("EIO");
					},
					close: async () => {
						throw errnoError("EBADF");
					},
				}),
			}),
		).resolves.toBeUndefined();
		expect(() =>
			syncDirectoryFullyBestEffortSync("/state/sdk", {
				open: () => 1,
				sync: () => {
					throw errnoError("EIO");
				},
				close: () => {
					throw errnoError("EBADF");
				},
			}),
		).not.toThrow();
	});
});

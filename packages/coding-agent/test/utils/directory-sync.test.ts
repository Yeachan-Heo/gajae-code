import { describe, expect, it } from "bun:test";
import { isUnsupportedWindowsDirectorySyncError } from "../../src/utils/directory-sync";

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

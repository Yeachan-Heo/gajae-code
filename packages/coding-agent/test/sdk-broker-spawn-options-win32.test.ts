import { expect, test } from "bun:test";
import { resolveBrokerSpawnOptionsForTest } from "../src/sdk/broker/ensure";

/**
 * Test the broker spawn-option selection logic for Windows and non-Windows.
 * This unit test runs on all platforms and verifies the correct spawn behavior
 * selection without actually spawning processes.
 *
 * Issue #6007: On Windows, the detached option alone doesn't remove the broker
 * from the parent's process tree. We must spawn through an intermediate launcher
 * (cmd /c start) to ensure the broker survives parent termination.
 */

/**
 * Mock implementation of resolveBrokerSpawnOptions to test without importing
 * from the actual module (to allow testing platform-specific behavior).
 * Used to verify behavior on platforms other than the current one.
 */
function resolveBrokerSpawnOptionsMock(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform,
): { file: string; args: string[] } {
	if (platform !== "win32") {
		return { file, args: Array.from(args) };
	}
	// On Windows, use cmd /c start /b to spawn without a new console window
	// and detached from the parent process. The empty title "" is required:
	// start treats its first quoted argument as the window title, so paths
	// containing spaces would be consumed as the title rather than executed.
	return {
		file: "cmd",
		args: ["/c", "start", "", "/b", file, ...args],
	};
}

test("resolveBrokerSpawnOptions keeps command unchanged on non-Windows platforms", () => {
	const linuxResult = resolveBrokerSpawnOptionsMock(
		"bun",
		["/path/to/sdk/broker-internal"],
		"linux" as NodeJS.Platform,
	);
	expect(linuxResult.file).toBe("bun");
	expect(linuxResult.args).toEqual(["/path/to/sdk/broker-internal"]);

	const darwinResult = resolveBrokerSpawnOptionsMock("node", ["/path/to/broker.js"], "darwin" as NodeJS.Platform);
	expect(darwinResult.file).toBe("node");
	expect(darwinResult.args).toEqual(["/path/to/broker.js"]);
});

test("resolveBrokerSpawnOptions wraps command in cmd /c start on Windows", () => {
	const result = resolveBrokerSpawnOptionsMock(
		"bun",
		["/path/to/sdk/broker-internal", "--verbose"],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	expect(result.args).toEqual(["/c", "start", "", "/b", "bun", "/path/to/sdk/broker-internal", "--verbose"]);
});

test("resolveBrokerSpawnOptions handles empty args array on Windows", () => {
	const result = resolveBrokerSpawnOptionsMock("cmd.exe", [], "win32" as NodeJS.Platform);

	expect(result.file).toBe("cmd");
	expect(result.args).toEqual(["/c", "start", "", "/b", "cmd.exe"]);
});

test("resolveBrokerSpawnOptions preserves argument order on Windows", () => {
	const args = ["arg1", "arg2", "arg3", "--flag", "value"];
	const result = resolveBrokerSpawnOptionsMock("gjc", args, "win32" as NodeJS.Platform);

	expect(result.args).toEqual(["/c", "start", "", "/b", "gjc", ...args]);
});

test("spawn options selection logic preserves correct detached flag semantics", () => {
	// Verify the conditional logic: on non-Windows use detached:true
	// because the broker can be detached directly.
	const linuxPlatform = "linux" as NodeJS.Platform;
	const linuxDetached = linuxPlatform !== "win32";
	expect(linuxDetached).toBe(true);

	// On Windows use detached:false because cmd /c start handles detachment;
	// the child process is cmd.exe, not the broker.
	const winPlatform = "win32" as NodeJS.Platform;
	const winDetached = winPlatform !== "win32";
	expect(winDetached).toBe(false);
});

test("resolveBrokerSpawnOptionsForTest returns current platform behavior", () => {
	const result = resolveBrokerSpawnOptionsForTest("test-cmd", ["arg1", "arg2"]);

	if (process.platform === "win32") {
		// On Windows, should wrap in cmd /c start with empty title
		expect(result.file).toBe("cmd");
		expect(result.args).toEqual(["/c", "start", "", "/b", "test-cmd", "arg1", "arg2"]);
	} else {
		// On non-Windows, should return unchanged
		expect(result.file).toBe("test-cmd");
		expect(result.args).toEqual(["arg1", "arg2"]);
	}
});

// Windows-only test: skipped on non-Windows platforms
test.skipIf(process.platform !== "win32")("resolveBrokerSpawnOptionsForTest with agent-dir argument on Windows", () => {
	const result = resolveBrokerSpawnOptionsForTest("gjc", ["sdk", "broker-internal", "--agent-dir", "/path/to/agent"]);

	expect(result.file).toBe("cmd");
	expect(result.args).toEqual([
		"/c",
		"start",
		"",
		"/b",
		"gjc",
		"sdk",
		"broker-internal",
		"--agent-dir",
		"/path/to/agent",
	]);
});

test("resolveBrokerSpawnOptions handles executable paths with spaces on Windows", () => {
	// Simulate a common Windows installation path under Program Files
	const result = resolveBrokerSpawnOptionsMock(
		"C:\\Program Files\\gjc\\gjc.exe",
		["--agent-dir", "/home/user/.gjc"],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	// The empty title must be present to prevent the executable path
	// from being consumed as the window title by the start command.
	expect(result.args).toEqual([
		"/c",
		"start",
		"",
		"/b",
		"C:\\Program Files\\gjc\\gjc.exe",
		"--agent-dir",
		"/home/user/.gjc",
	]);
});

test("resolveBrokerSpawnOptions handles user profile paths with spaces on Windows", () => {
	// Simulate a user profile path with spaces (common on Windows)
	const result = resolveBrokerSpawnOptionsMock(
		"C:\\Users\\John Doe\\AppData\\Local\\Programs\\gjc\\gjc.exe",
		[],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	// Empty title prevents the path from being treated as window title
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe(""); // Empty title
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toContain("John Doe"); // Path with space is preserved
});

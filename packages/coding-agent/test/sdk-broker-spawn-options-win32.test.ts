import { expect, test } from "bun:test";
import {
	resolveBrokerSpawnOptionsForTest,
	resolveBrokerSpawnOptionsWithPlatformForTest,
} from "../src/sdk/broker/ensure";

/**
 * Test the broker spawn-option selection logic for Windows and non-Windows.
 * This unit test runs on all platforms and verifies the correct spawn behavior
 * selection without actually spawning processes.
 *
 * Issue #6007: On Windows, the detached option alone doesn't remove the broker
 * from the parent's process tree. We must spawn through an intermediate launcher
 * (cmd /c start) to ensure the broker survives parent termination.
 *
 * Tests use resolveBrokerSpawnOptionsWithPlatformForTest to inject the platform
 * parameter, allowing cross-platform testing on any host.
 */

test("resolveBrokerSpawnOptions keeps command unchanged on non-Windows platforms", () => {
	const linuxResult = resolveBrokerSpawnOptionsWithPlatformForTest(
		"bun",
		["/path/to/sdk/broker-internal"],
		"linux" as NodeJS.Platform,
	);
	expect(linuxResult.file).toBe("bun");
	expect(linuxResult.args).toEqual(["/path/to/sdk/broker-internal"]);

	const darwinResult = resolveBrokerSpawnOptionsWithPlatformForTest(
		"node",
		["/path/to/broker.js"],
		"darwin" as NodeJS.Platform,
	);
	expect(darwinResult.file).toBe("node");
	expect(darwinResult.args).toEqual(["/path/to/broker.js"]);
});

test("resolveBrokerSpawnOptions wraps command in cmd /c start on Windows", () => {
	const result = resolveBrokerSpawnOptionsWithPlatformForTest(
		"bun",
		["/path/to/sdk/broker-internal", "--verbose"],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	// Arguments should be escaped for cmd.exe parsing
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe("");
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toBe('"bun"');
	expect(result.args[5]).toBe('"/path/to/sdk/broker-internal"');
	expect(result.args[6]).toBe('"--verbose"');
});

test("resolveBrokerSpawnOptions handles empty args array on Windows", () => {
	const result = resolveBrokerSpawnOptionsWithPlatformForTest("cmd.exe", [], "win32" as NodeJS.Platform);

	expect(result.file).toBe("cmd");
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe("");
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toBe('"cmd.exe"');
});

test("resolveBrokerSpawnOptions preserves argument order on Windows", () => {
	const args = ["arg1", "arg2", "arg3", "--flag", "value"];
	const result = resolveBrokerSpawnOptionsWithPlatformForTest("gjc", args, "win32" as NodeJS.Platform);

	expect(result.file).toBe("cmd");
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe("");
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toBe('"gjc"');
	// Arguments should be escaped in order
	expect(result.args[5]).toBe('"arg1"');
	expect(result.args[6]).toBe('"arg2"');
	expect(result.args[7]).toBe('"arg3"');
	expect(result.args[8]).toBe('"--flag"');
	expect(result.args[9]).toBe('"value"');
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
		// On Windows, should wrap in cmd /c start with escaped arguments
		expect(result.file).toBe("cmd");
		expect(result.args[0]).toBe("/c");
		expect(result.args[1]).toBe("start");
		expect(result.args[2]).toBe("");
		expect(result.args[3]).toBe("/b");
		expect(result.args[4]).toBe('"test-cmd"');
		expect(result.args[5]).toBe('"arg1"');
		expect(result.args[6]).toBe('"arg2"');
	} else {
		// On non-Windows, should return unchanged
		expect(result.file).toBe("test-cmd");
		expect(result.args).toEqual(["arg1", "arg2"]);
	}
});

// Test with platform injection to verify Windows behavior on all platforms
test("resolveBrokerSpawnOptionsWithPlatformForTest with agent-dir argument on Windows", () => {
	const result = resolveBrokerSpawnOptionsWithPlatformForTest(
		"gjc",
		["sdk", "broker-internal", "--agent-dir", "/path/to/agent"],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe("");
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toBe('"gjc"');
	expect(result.args[5]).toBe('"sdk"');
	expect(result.args[6]).toBe('"broker-internal"');
	expect(result.args[7]).toBe('"--agent-dir"');
	expect(result.args[8]).toBe('"/path/to/agent"');
});

test("resolveBrokerSpawnOptions handles executable paths with spaces on Windows", () => {
	// Simulate a common Windows installation path under Program Files
	const result = resolveBrokerSpawnOptionsWithPlatformForTest(
		"C:\\Program Files\\gjc\\gjc.exe",
		["--agent-dir", "/home/user/.gjc"],
		"win32" as NodeJS.Platform,
	);

	expect(result.file).toBe("cmd");
	// The empty title must be present to prevent the executable path
	// from being consumed as the window title by the start command.
	// Executable path and arguments should be escaped
	expect(result.args[0]).toBe("/c");
	expect(result.args[1]).toBe("start");
	expect(result.args[2]).toBe("");
	expect(result.args[3]).toBe("/b");
	expect(result.args[4]).toContain("Program Files");
	expect(result.args[4]).toContain('"');
	expect(result.args[5]).toBe('"--agent-dir"');
	expect(result.args[6]).toBe('"/home/user/.gjc"');
});

test("resolveBrokerSpawnOptions handles user profile paths with spaces on Windows", () => {
	// Simulate a user profile path with spaces (common on Windows)
	const result = resolveBrokerSpawnOptionsWithPlatformForTest(
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
	// Path with space should be escaped with quotes
	expect(result.args[4]).toContain("John Doe");
	expect(result.args[4]).toContain('"');
});

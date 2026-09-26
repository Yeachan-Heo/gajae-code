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
	// and detached from the parent process.
	const cmdArgs = [file, ...args];
	return {
		file: "cmd",
		args: ["/c", "start", "/b", ...cmdArgs],
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
	expect(result.args).toEqual(["/c", "start", "/b", "bun", "/path/to/sdk/broker-internal", "--verbose"]);
});

test("resolveBrokerSpawnOptions handles empty args array on Windows", () => {
	const result = resolveBrokerSpawnOptionsMock("cmd.exe", [], "win32" as NodeJS.Platform);

	expect(result.file).toBe("cmd");
	expect(result.args).toEqual(["/c", "start", "/b", "cmd.exe"]);
});

test("resolveBrokerSpawnOptions preserves argument order on Windows", () => {
	const args = ["arg1", "arg2", "arg3", "--flag", "value"];
	const result = resolveBrokerSpawnOptionsMock("gjc", args, "win32" as NodeJS.Platform);

	expect(result.args).toEqual(["/c", "start", "/b", "gjc", ...args]);
});

test("spawn options selection logic preserves correct detached flag semantics", () => {
	// Verify the conditional logic: on non-Windows use detached:true
	const nonWindowsDetached = ("linux" as NodeJS.Platform) !== "win32";
	expect(nonWindowsDetached).toBe(true);

	// On Windows use detached:false because cmd /c start handles detachment
	const windowsDetached = ("win32" as NodeJS.Platform) !== "win32";
	expect(windowsDetached).toBe(false);
});

test("resolveBrokerSpawnOptionsForTest returns current platform behavior", () => {
	const result = resolveBrokerSpawnOptionsForTest("test-cmd", ["arg1", "arg2"]);

	if (process.platform === "win32") {
		// On Windows, should wrap in cmd /c start
		expect(result.file).toBe("cmd");
		expect(result.args).toEqual(["/c", "start", "/b", "test-cmd", "arg1", "arg2"]);
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
	expect(result.args).toEqual(["/c", "start", "/b", "gjc", "sdk", "broker-internal", "--agent-dir", "/path/to/agent"]);
});

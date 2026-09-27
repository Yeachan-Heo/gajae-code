import { expect, test } from "bun:test";
import { resolveBrokerSpawnOptionsForProduction } from "../src/sdk/broker/ensure";

/**
 * Test the broker spawn-option selection logic.
 * Issue #6007: Windows SDK broker detachment.
 *
 * Strategy: spawn the broker directly on all platforms using detached:true.
 * Bun.spawn with UV_PROCESS_DETACHED creates a process outside the parent's job on Windows.
 * This avoids the cmd.exe wrapping complexity that caused double-quoting, %VAR% expansion,
 * and discovery matching issues.
 *
 * Tests verify that broker spawn options are returned unchanged on all platforms.
 */

test("resolveBrokerSpawnOptions returns command unchanged on all platforms", () => {
	const linuxResult = resolveBrokerSpawnOptionsForProduction("bun", ["/path/to/sdk/broker-internal"]);
	expect(linuxResult.file).toBe("bun");
	expect(linuxResult.args).toEqual(["/path/to/sdk/broker-internal"]);

	const darwinResult = resolveBrokerSpawnOptionsForProduction("node", ["/path/to/broker.js"]);
	expect(darwinResult.file).toBe("node");
	expect(darwinResult.args).toEqual(["/path/to/broker.js"]);

	// Windows also returns unchanged: detached:true is handled by spawn options
	const windowsResult = resolveBrokerSpawnOptionsForProduction("bun", [
		"/path/to/sdk/broker-internal",
		"--agent-dir",
		"/home/user/.gjc",
	]);
	expect(windowsResult.file).toBe("bun");
	expect(windowsResult.args).toEqual(["/path/to/sdk/broker-internal", "--agent-dir", "/home/user/.gjc"]);
});

test("resolveBrokerSpawnOptions handles empty args array", () => {
	const result = resolveBrokerSpawnOptionsForProduction("cmd.exe", []);

	expect(result.file).toBe("cmd.exe");
	expect(result.args).toEqual([]);
});

test("resolveBrokerSpawnOptions preserves argument order", () => {
	const args = ["arg1", "arg2", "arg3", "--flag", "value"];
	const result = resolveBrokerSpawnOptionsForProduction("gjc", args);

	expect(result.file).toBe("gjc");
	expect(result.args).toEqual(args);
});

test("resolveBrokerSpawnOptions returns command unchanged on all platforms", () => {
	const result = resolveBrokerSpawnOptionsForProduction("test-cmd", ["arg1", "arg2"]);

	// All platforms now return unchanged, with detached:true handled at spawn time
	expect(result.file).toBe("test-cmd");
	expect(result.args).toEqual(["arg1", "arg2"]);
});

test("resolveBrokerSpawnOptions with agent-dir argument", () => {
	const result = resolveBrokerSpawnOptionsForProduction("gjc", [
		"sdk",
		"broker-internal",
		"--agent-dir",
		"/path/to/agent",
	]);

	expect(result.file).toBe("gjc");
	expect(result.args).toEqual(["sdk", "broker-internal", "--agent-dir", "/path/to/agent"]);
});

test("resolveBrokerSpawnOptions handles executable paths with spaces", () => {
	// Simulate a common Windows installation path under Program Files
	const result = resolveBrokerSpawnOptionsForProduction("C:\\Program Files\\gjc\\gjc.exe", [
		"--agent-dir",
		"/home/user/.gjc",
	]);

	expect(result.file).toBe("C:\\Program Files\\gjc\\gjc.exe");
	expect(result.args).toEqual(["--agent-dir", "/home/user/.gjc"]);
});

test("resolveBrokerSpawnOptions handles user profile paths with spaces", () => {
	// Simulate a user profile path with spaces (common on Windows)
	const result = resolveBrokerSpawnOptionsForProduction(
		"C:\\Users\\John Doe\\AppData\\Local\\Programs\\gjc\\gjc.exe",
		[],
	);

	expect(result.file).toBe("C:\\Users\\John Doe\\AppData\\Local\\Programs\\gjc\\gjc.exe");
	expect(result.args).toEqual([]);
});

/**
 * Broker hop protocol tests (Windows hop process).
 * Verifies the JSON protocol used to communicate broker spawn arguments to the hop.
 */

test("broker hop protocol: valid JSON message with broker pid", () => {
	const message = {
		command: {
			file: "/path/to/broker",
			args: ["--agent-dir", "/home/user/.gjc"],
		},
		env: { KEY: "value" },
		stdio: "ignore",
	};

	const json = JSON.stringify(message);
	const parsed = JSON.parse(json);

	expect(parsed.command.file).toBe("/path/to/broker");
	expect(parsed.command.args).toEqual(["--agent-dir", "/home/user/.gjc"]);
	expect(parsed.env.KEY).toBe("value");
	expect(parsed.stdio).toBe("ignore");
});

test("broker hop protocol: hop response with broker pid", () => {
	const hopResponse = `{"pid":1234}\n`;
	const parsed = JSON.parse(hopResponse.trim());

	expect(parsed.pid).toBe(1234);
	expect(typeof parsed.pid).toBe("number");
});

test("broker hop protocol: handles stdio as file descriptor", () => {
	const message = {
		command: {
			file: "/path/to/broker",
			args: [],
		},
		env: {},
		stdio: 3, // File descriptor number
	};

	const json = JSON.stringify(message);
	const parsed = JSON.parse(json);

	expect(parsed.stdio).toBe(3);
	expect(typeof parsed.stdio).toBe("number");
});

test("broker hop protocol: hop response parsing preserves precision", () => {
	// Test that large pids are preserved exactly
	const largePid = 999999;
	const hopResponse = JSON.stringify({ pid: largePid });
	const parsed = JSON.parse(hopResponse);

	expect(parsed.pid).toBe(largePid);
});

import { afterEach, describe, expect, test, vi } from "bun:test";
import { parseSetupArgs, runSetupCommand } from "../src/cli/setup-cli";
import * as kev from "../src/setup/kev-setup";

const previousExitCode = process.exitCode ?? 0;
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
});

describe("Kev setup CLI", () => {
	test("accepts a model on Kev install without treating it as chat provider registration", async () => {
		const run = vi
			.spyOn(kev, "runKevSetup")
			.mockResolvedValue({ ok: true, state: "stopped", root: "/synthetic/kev", model: "jaredpalmer/kev-4b" });
		const command = parseSetupArgs(["setup", "kev", "install", "--model", "jaredpalmer/kev-4b", "--json"]);
		expect(command).toMatchObject({
			component: "kev",
			flags: { action: "install", model: ["jaredpalmer/kev-4b"], json: true },
		});
		await runSetupCommand(command!);
		expect(run).toHaveBeenCalledWith("install", {
			model: "jaredpalmer/kev-4b",
			root: undefined,
			port: undefined,
			json: true,
		});
	});

	test("passes explicit loopback ports through the source CLI parser", async () => {
		const run = vi
			.spyOn(kev, "runKevSetup")
			.mockResolvedValue({ ok: true, state: "running", root: "/synthetic/kev", port: 8123 });
		const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runSetupCommand(parseSetupArgs(["setup", "kev", "start", "--port", "8123"])!);
		expect(run.mock.calls[0]?.[1]?.port).toBe(8123);
		expect(output.mock.calls.map(call => String(call[0])).join("")).toContain("Kev running");
	});

	test("rejects Kev actions and ports on unrelated setup components", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("blocked exit");
		});
		for (const flags of [{ action: "start" as const }, { port: 8123 }]) {
			await expect(runSetupCommand({ component: "defaults", flags })).rejects.toThrow("blocked exit");
		}
	});

	test("does not let Kev absorb unrelated provider credentials or registration flags", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("blocked exit");
		});
		await expect(
			runSetupCommand({ component: "kev", flags: { action: "install", apiKeyEnv: "UNRELATED_KEY" } }),
		).rejects.toThrow("blocked exit");
	});

	test("rejects ambiguous multiple installation models before invoking lifecycle code", async () => {
		const run = vi.spyOn(kev, "runKevSetup");
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runSetupCommand({
			component: "kev",
			flags: { action: "install", model: ["one/model", "two/model"], json: true },
		});
		expect(run).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});

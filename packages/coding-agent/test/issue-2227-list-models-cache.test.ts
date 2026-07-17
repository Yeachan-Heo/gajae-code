import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import type { Args } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { runRootCommand } from "../src/main";
import { AuthStorage } from "../src/session/auth-storage";

function rootArgs(searchPattern?: string): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		listModels: searchPattern ?? true,
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("--list-models cache refresh (issue #2227)", () => {
	test("uses online-if-uncached exactly once through the public root command", async () => {
		using tempDir = TempDir.createSync("@gjc-issue-2227-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const registerProviderSpy = vi.spyOn(ModelRegistry.prototype, "registerProvider");
		const refreshSpy = vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
		const successfulExit = new Error("successful list-models exit");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
			throw successfulExit;
		});

		try {
			await expect(
				runRootCommand(rootArgs("claude-sonnet-4-5"), [], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
					initTheme: async () => {},
				}),
			).rejects.toBe(successfulExit);

			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(refreshSpy).toHaveBeenCalledWith("online-if-uncached");
			expect(registerProviderSpy).toHaveBeenCalledWith("grok-build", expect.any(Object), "bundled:grok-build");
			expect(exitSpy).toHaveBeenCalledTimes(1);
			expect(exitSpy).toHaveBeenCalledWith(0);
			expect(stdout.join("")).toContain("Provider models");
			expect(stdout.join("")).toContain("claude-sonnet-4-5");
			expect(stderr.join("")).toBe("");
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			exitSpy.mockRestore();
			refreshSpy.mockRestore();
			registerProviderSpy.mockRestore();
			authStorage.close();
		}
	});
});

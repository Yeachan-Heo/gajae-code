import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piNatives from "@gajae-code/natives";
import { disposeAllShellSessions, setShellFactoryForTests } from "../../src/exec/bash-executor";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

afterEach(async () => {
	setShellFactoryForTests(undefined);
	await disposeAllShellSessions();
	vi.restoreAllMocks();
});

/**
 * Issue #5374: `GJC_SESSION_ID` must mean "this session's own id" on the
 * bash tool-env path, and master ownership must travel under its own distinct
 * variable (`GJC_MASTER_OWNER_SESSION_ID`).
 *
 * The direct `gjc sdk spawn` dispatch env previously read
 * `GJC_SESSION_ID: resolvedEnv?.GJC_MASTER_OWNER_SESSION_ID ?? own id`, which
 * overloaded one name with two meanings (master identity vs. own identity).
 */
function createSession(
	sessionId: string,
	ownerSessionId?: string,
	settingsOverrides?: { shellPrefix?: string; disableShellPrefix?: boolean; minimizerEnabled?: boolean },
): ToolSession {
	return {
		cwd: process.cwd(),
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getMasterBashCapability: () => "master-capability-fixture",
		...(ownerSessionId === undefined
			? { getMasterOwnerSessionId: () => undefined }
			: { getMasterOwnerSessionId: () => ownerSessionId }),
		settings: {
			has: () => false,
			get: () => undefined,
			getBashInterceptorRules: () => [],
			...stubBashExecutorSettings,
			getShellConfig: () => {
				const config = stubBashExecutorSettings.getShellConfig();
				if (
					!settingsOverrides ||
					(!settingsOverrides.disableShellPrefix && settingsOverrides.shellPrefix === undefined)
				) {
					return config;
				}
				return { ...config, prefix: settingsOverrides.shellPrefix };
			},
			getGroup: () => ({
				...stubBashExecutorSettings.getGroup("shellMinimizer"),
				...(settingsOverrides?.minimizerEnabled ? { enabled: true, maxCaptureBytes: 4 * 1024 * 1024 } : {}),
			}),
		},
	} as unknown as ToolSession;
}

function echoSessionEnv(): string {
	return 'printf "own=%s owner=%s" "$GJC_SESSION_ID" "$GJC_MASTER_OWNER_SESSION_ID"';
}

function textOf(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
	return content.find(block => block.type === "text")?.text ?? "";
}

const coordinatorOnlyEnvNames = [
	"GJC_COORDINATOR_SESSION_STATE_FILE",
	"GJC_COORDINATOR_SESSION_ID",
	"GJC_COORDINATOR_SESSION_BRANCH",
	"GJC_COORDINATOR_SESSION_LAUNCH_ID",
	"GJC_COORDINATOR_SESSION_READINESS_FILE",
	"GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED",
	"GJC_COORDINATOR_SIDECAR_KEY_ID",
];

describe("issue #5374: session identity on the bash tool-env path", () => {
	it("a master-owned child exposes its own id in GJC_SESSION_ID", async () => {
		const result = await new BashTool(createSession("child-session", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("own=child-session");
	});

	it("master ownership travels under GJC_MASTER_OWNER_SESSION_ID", async () => {
		const result = await new BashTool(createSession("child-session", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("owner=master-owner");
	});

	it("a master session exposes its own id", async () => {
		const result = await new BashTool(createSession("master-owner", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("own=master-owner");
	});
});

describe("issue #5802: coordinator env isolation at the bash boundary", () => {
	it("scrubs inherited coordinator env while preserving explicit overrides and derived session identity", async () => {
		const namesToRestore = [...coordinatorOnlyEnvNames, "GJC_SESSION_ID"];
		const previousEnv = new Map(namesToRestore.map(name => [name, process.env[name]]));
		for (const name of coordinatorOnlyEnvNames) process.env[name] = `ambient-${name}`;
		process.env.GJC_SESSION_ID = "parent-session";

		try {
			const command = [
				`for name in ${coordinatorOnlyEnvNames.join(" ")}; do`,
				`  value=$(printenv "$name" 2>/dev/null || printf '<unset>')`,
				`  printf '%s=%s\\n' "$name" "$value"`,
				"done",
				`printf 'GJC_SESSION_ID=%s\\n' "$GJC_SESSION_ID"`,
				`printf 'BASH_TOOL_EXPLICIT=%s\\n' "$BASH_TOOL_EXPLICIT"`,
			].join("\n");
			const result = await new BashTool(createSession("child-session")).execute("call", {
				command,
				env: {
					GJC_COORDINATOR_SESSION_ID: "explicit-coordinator-id",
					BASH_TOOL_EXPLICIT: "explicit-tool-value",
				},
			});
			const output = textOf(result);
			for (const name of coordinatorOnlyEnvNames) {
				expect(output).toContain(
					`${name}=${name === "GJC_COORDINATOR_SESSION_ID" ? "explicit-coordinator-id" : "<unset>"}`,
				);
			}
			expect(output).toContain("GJC_SESSION_ID=child-session");
			expect(output).toContain("BASH_TOOL_EXPLICIT=explicit-tool-value");
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("preserves an explicit coordinator branch override", async () => {
		const name = "GJC_COORDINATOR_SESSION_BRANCH";
		const previous = process.env[name];
		process.env[name] = "ambient-coordinator-branch";
		try {
			const result = await new BashTool(createSession("child-session")).execute("call", {
				command: `printf 'branch=%s own=%s\\n' "$${name}" "$GJC_SESSION_ID"`,
				env: { [name]: "explicit-coordinator-branch" },
			});
			expect(textOf(result)).toContain("branch=explicit-coordinator-branch own=child-session");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});

	it("keeps false && prefixes around the user's unchanged command", async () => {
		let nativeCommand: string | undefined;
		setShellFactoryForTests(options => new piNatives.Shell(options));
		const originalRun = piNatives.Shell.prototype.run;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: piNatives.Shell, options, onChunk) {
			nativeCommand = options.command;
			return originalRun.call(this, options, onChunk);
		});

		await expect(
			new BashTool(createSession("prefix-session", undefined, { shellPrefix: "false &&" })).execute("call", {
				command: "printf prefix-edge-ran",
			}),
		).rejects.toThrow("Command exited with code 1");
		expect(nativeCommand).toBe("false && printf prefix-edge-ran");
	});

	const cargoBinDir = path.join(process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "bin");
	const cargoPath = [cargoBinDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
	let cargoAvailable = false;
	try {
		cargoAvailable =
			Bun.spawnSync(["cargo", "--version"], {
				env: { ...process.env, PATH: cargoPath },
				stderr: "ignore",
				stdout: "ignore",
			}).exitCode === 0;
	} catch {
		// A missing executable and an unusable rustup shim are both unmet prerequisites.
	}

	const cargoBuildTest = it.skipIf(!cargoAvailable);
	const cargoBuildTestName = "executes and minimizes a simple Cargo build through native execution";
	const cargoUnavailableReason =
		"skipped: requires a working Cargo toolchain; cargo --version must succeed using the test Cargo-bin PATH";
	const cargoTestTitle = cargoAvailable ? cargoBuildTestName : `${cargoBuildTestName} (${cargoUnavailableReason})`;
	const runCargoBuild = async () => {
		const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cargo-minimizer-"));
		let nativeCommand: string | undefined;
		let nativeUnsetEnv: string[] | undefined;
		let nativeMinimizer: unknown;
		let nativeMinimized: { filter: string; text: string; originalText: string } | undefined;
		setShellFactoryForTests(options => {
			nativeMinimizer = options?.minimizer;
			return new piNatives.Shell(options);
		});
		const originalRun = piNatives.Shell.prototype.run;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: piNatives.Shell, options, onChunk) {
			nativeCommand = options.command;
			nativeUnsetEnv = options.unsetEnv;
			return originalRun.call(this, options, onChunk).then(result => {
				nativeMinimized = result.minimized ?? undefined;
				return result;
			});
		});

		try {
			await fs.mkdir(path.join(fixtureDir, "src"), { recursive: true });
			await fs.writeFile(
				path.join(fixtureDir, "Cargo.toml"),
				'[package]\nname = "bash-minimizer-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
			);
			await fs.writeFile(path.join(fixtureDir, "src", "lib.rs"), "pub fn fixture() {}\n");

			const command = "cargo build --offline --manifest-path Cargo.toml --target-dir target";
			const result = await new BashTool(
				createSession("minimizer-session", undefined, {
					disableShellPrefix: true,
					minimizerEnabled: true,
				}),
			).execute("call", {
				command,
				cwd: fixtureDir,
				env: { PATH: cargoPath, CARGO_TERM_COLOR: "never" },
			});
			const output = textOf(result);

			await fs.access(path.join(fixtureDir, "target", "debug", "deps"));
			expect(nativeCommand).toBe(command);
			expect(nativeUnsetEnv).toEqual(coordinatorOnlyEnvNames);
			expect(nativeMinimizer).toEqual({
				enabled: true,
				settingsPath: undefined,
				only: undefined,
				except: undefined,
				maxCaptureBytes: 4 * 1024 * 1024,
			});
			expect(nativeMinimized?.originalText).toContain("Compiling bash-minimizer-fixture");
			expect(nativeMinimized?.originalText).toContain("Finished");
			expect(nativeMinimized?.text).not.toContain("Compiling");
			expect(nativeMinimized?.text).not.toContain("Finished");
			expect(nativeMinimized?.text).not.toBe(nativeMinimized?.originalText);
			expect(output).not.toContain("Compiling");
			expect(output).not.toContain("Finished");
		} finally {
			await fs.rm(fixtureDir, { recursive: true, force: true });
		}
	};
	cargoBuildTest(cargoTestTitle, runCargoBuild, 30_000);
});

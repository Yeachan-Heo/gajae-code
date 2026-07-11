import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	buildMallocEnvReexecCommand,
	MALLOC_ENV_REEXEC_GUARD_VAR,
	mallocEnvNeedsReexec,
	reexecWithoutMallocEnv,
} from "../src/cli/malloc-env-guard";

describe("mallocEnvNeedsReexec", () => {
	it("triggers on darwin when either malloc var is present", () => {
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "1" }, "darwin")).toBe(true);
		expect(mallocEnvNeedsReexec({ MallocStackLoggingNoCompact: "0" }, "darwin")).toBe(true);
	});

	it("treats any value — including disabled '0' — as contamination", () => {
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "0" }, "darwin")).toBe(true);
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "" }, "darwin")).toBe(true);
	});

	it("is a no-op on clean environments", () => {
		expect(mallocEnvNeedsReexec({ PATH: "/usr/bin" }, "darwin")).toBe(false);
	});

	it("never loops: the re-exec'd child skips the guard", () => {
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "1", [MALLOC_ENV_REEXEC_GUARD_VAR]: "1" }, "darwin")).toBe(
			false,
		);
	});

	it("is darwin-only", () => {
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "1" }, "linux")).toBe(false);
		expect(mallocEnvNeedsReexec({ MallocStackLogging: "1" }, "win32")).toBe(false);
	});
});

describe("buildMallocEnvReexecCommand", () => {
	it("re-runs bun with the entry script in source mode", () => {
		expect(buildMallocEnvReexecCommand("/opt/bun", ["/opt/bun", "/repo/bin/gjc.js", "--continue", "hi"])).toEqual([
			"/opt/bun",
			"/repo/bin/gjc.js",
			"--continue",
			"hi",
		]);
	});

	it("drops the virtual /$bunfs entry for compiled binaries", () => {
		expect(buildMallocEnvReexecCommand("/usr/local/bin/gjc", ["bun", "/$bunfs/root/gjc", "stats", "-j"])).toEqual([
			"/usr/local/bin/gjc",
			"stats",
			"-j",
		]);
	});
});

describe("reexecWithoutMallocEnv", () => {
	it("spawns the same invocation with malloc vars stripped and the loop guard set", async () => {
		let seenCmd: string[] | undefined;
		let seenEnv: Record<string, string> | undefined;
		const exitCode = await reexecWithoutMallocEnv({
			execPath: "/opt/bun",
			argv: ["/opt/bun", "/repo/bin/gjc.js", "-p", "hello"],
			env: {
				MallocStackLogging: "1",
				MallocStackLoggingNoCompact: "0",
				PATH: "/usr/bin",
				HOME: "/Users/dev",
			},
			spawn: async (cmd, env) => {
				seenCmd = cmd;
				seenEnv = env;
				return 42;
			},
		});
		expect(exitCode).toBe(42);
		expect(seenCmd).toEqual(["/opt/bun", "/repo/bin/gjc.js", "-p", "hello"]);
		expect(seenEnv).toEqual({
			PATH: "/usr/bin",
			HOME: "/Users/dev",
			[MALLOC_ENV_REEXEC_GUARD_VAR]: "1",
		});
	});
});

// Bun snapshots the spawn-default env at startup, so a contaminated process
// cannot clean its own children by mutating process.env — only the re-exec
// closes the leak. This is the end-to-end proof.
describe.if(process.platform === "darwin")("malloc env launch boundary (end-to-end)", () => {
	it("re-exec'd gjc process spawns default-env children without malloc vars", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "malloc-env-guard-fixture.ts");
		const proc = Bun.spawn({
			cmd: [process.execPath, fixture],
			env: { ...process.env, MallocStackLogging: "1", [MALLOC_ENV_REEXEC_GUARD_VAR]: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(report.reexeced).toBe(true);
		expect(report.mallocVisibleToDefaultSpawn).toBeNull();
	}, 20_000);
});

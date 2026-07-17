import { describe, expect, it } from "bun:test";
import {
	buildMallocReexecArgv,
	formatMallocEnvNotice,
	hasMacOSMallocEnv,
	MACOS_MALLOC_ENV_VARS,
	MALLOC_ENV_REEXEC_GUARD,
	shouldReexecForMacOSMallocEnv,
} from "./malloc-env-guard";

describe("hasMacOSMallocEnv", () => {
	it("detects MallocStackLogging", () => {
		expect(hasMacOSMallocEnv({ MallocStackLogging: "0" })).toBe(true);
	});

	it("detects MallocStackLoggingNoCompact", () => {
		expect(hasMacOSMallocEnv({ MallocStackLoggingNoCompact: "1" })).toBe(true);
	});

	it("is false when neither var is present", () => {
		expect(hasMacOSMallocEnv({ PATH: "/usr/bin", HOME: "/home/x" })).toBe(false);
	});

	it("is false for an empty environment", () => {
		expect(hasMacOSMallocEnv({})).toBe(false);
	});
});

describe("shouldReexecForMacOSMallocEnv", () => {
	it("is true on darwin with a malloc var and no loop guard", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "darwin")).toBe(true);
	});

	it("is false off darwin even when a malloc var is present", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "linux")).toBe(false);
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "win32")).toBe(false);
	});

	it("is false when the loop guard is already set (already re-exec'd)", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0", [MALLOC_ENV_REEXEC_GUARD]: "1" }, "darwin")).toBe(
			false,
		);
	});

	it("is false on darwin when no malloc var is present", () => {
		expect(shouldReexecForMacOSMallocEnv({ PATH: "/usr/bin" }, "darwin")).toBe(false);
	});
});

describe("buildMallocReexecArgv", () => {
	it("drops the embedded virtual entry for a POSIX compiled binary", () => {
		expect(buildMallocReexecArgv(["/exe", "/$bunfs/root/cli", "run", "--flag"], "/exe")).toEqual([
			"/exe",
			"run",
			"--flag",
		]);
	});

	it("drops the embedded virtual entry for a Windows compiled binary", () => {
		expect(buildMallocReexecArgv(["C:/exe.exe", "B:\\~BUN\\root\\cli", "run"], "C:/exe.exe")).toEqual([
			"C:/exe.exe",
			"run",
		]);
	});

	it("drops the percent-encoded embedded virtual entry", () => {
		expect(buildMallocReexecArgv(["/exe", "B:\\%7EBUN\\root\\cli", "run"], "/exe")).toEqual(["/exe", "run"]);
	});

	it("keeps the on-disk script for a source/dev-link run", () => {
		expect(
			buildMallocReexecArgv(["/usr/bin/bun", "/repo/packages/coding-agent/src/cli.ts", "run", "-x"], "/usr/bin/bun"),
		).toEqual(["/usr/bin/bun", "/repo/packages/coding-agent/src/cli.ts", "run", "-x"]);
	});

	it("handles a source run with no user args", () => {
		expect(buildMallocReexecArgv(["/usr/bin/bun", "/repo/cli.ts"], "/usr/bin/bun")).toEqual([
			"/usr/bin/bun",
			"/repo/cli.ts",
		]);
	});
});

describe("formatMallocEnvNotice", () => {
	it("names both env vars and the permanent launchctl fix", () => {
		const notice = formatMallocEnvNotice();
		for (const name of MACOS_MALLOC_ENV_VARS) {
			expect(notice).toContain(name);
		}
		expect(notice).toContain("launchctl unsetenv MallocStackLogging");
		expect(notice).toContain("launchctl unsetenv MallocStackLoggingNoCompact");
		expect(notice.endsWith("\n")).toBe(true);
	});
});

describe("module constants", () => {
	it("exposes exactly the two macOS malloc env vars", () => {
		expect([...MACOS_MALLOC_ENV_VARS]).toEqual(["MallocStackLogging", "MallocStackLoggingNoCompact"]);
	});

	it("uses a namespaced loop-guard variable", () => {
		expect(MALLOC_ENV_REEXEC_GUARD).toBe("GJC_MALLOC_ENV_REEXEC");
	});
});

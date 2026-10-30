import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isMemoryGuardNativeSmokeFastPath, runMemoryGuardNativeSmokeFastPath } from "../src/cli-main";

describe("memory-guard native smoke fast path", () => {
	it("matches only the exact internal argv", () => {
		expect(isMemoryGuardNativeSmokeFastPath(["internal", "memory-guard-native-smoke", "--json"])).toBe(true);
		expect(isMemoryGuardNativeSmokeFastPath(["internal", "memory-guard-native-smoke"])).toBe(false);
		expect(isMemoryGuardNativeSmokeFastPath(["internal", "memory-guard-native-smoke", "--json", "extra"])).toBe(
			false,
		);
		expect(isMemoryGuardNativeSmokeFastPath(["internal", "memory-guard-native-smoke", "--pretty"])).toBe(false);
		expect(isMemoryGuardNativeSmokeFastPath(["launch", "internal", "memory-guard-native-smoke", "--json"])).toBe(
			false,
		);
	});

	it("emits the tagged native receipt without normal command dispatch", () => {
		let stdout = "";
		runMemoryGuardNativeSmokeFastPath({
			loadNative: () => ({
				probeWindowsJobMemory: () => ({ kind: "unsupported_platform", platform: "darwin" }),
			}),
			writeStdout: text => {
				stdout += text;
			},
		});
		expect(JSON.parse(stdout)).toEqual({
			api: "memory_guard_windows_job_probe_v1",
			source: "pi_natives",
			result: { kind: "unsupported_platform", platform: "darwin" },
		});
	});

	it("keeps the fast path ahead of runtime initialization and the Windows CI smoke after release build", async () => {
		// The entry keeps the ordinary command surface out of its static graph and imports it
		// lazily; the smoke dispatch itself lives in that lazily imported module, so both ends
		// of the link are pinned here.
		const cliSource = await Bun.file(path.join(import.meta.dir, "../src/cli.ts")).text();
		const ordinarySource = await Bun.file(path.join(import.meta.dir, "../src/cli-ordinary.ts")).text();
		const lazyOrdinary = cliSource.indexOf('await import("./cli-ordinary")');
		const nativeDispatch = ordinarySource.indexOf('argv[1] === "memory-guard-native-smoke"');
		const normalDispatch = ordinarySource.indexOf('import("./cli-main")');
		expect(lazyOrdinary).toBeGreaterThan(-1);
		expect(nativeDispatch).toBeGreaterThan(-1);
		expect(normalDispatch).toBeGreaterThan(-1);
		expect(nativeDispatch).toBeLessThan(normalDispatch);
		expect(cliSource).not.toContain("await installRuntimeGlobals();");
		// Runtime globals are only reachable through the lazy `setup` descriptor: no awaited
		// installation may precede the smoke dispatch in the ordinary module either.
		expect(ordinarySource.slice(0, nativeDispatch).indexOf("await installRuntimeGlobals(")).toBe(-1);

		const ciSource = await Bun.file(path.join(import.meta.dir, "../../..", ".github/workflows/ci.yml")).text();
		expect(ciSource).toContain("bun test packages/natives/test/memory-guard-native.test.ts");
		expect(ciSource).toContain("internal memory-guard-native-smoke --json");
		expect(ciSource.indexOf("internal memory-guard-native-smoke --json")).toBeGreaterThan(
			ciSource.indexOf("- name: Build release binary"),
		);
	});
});

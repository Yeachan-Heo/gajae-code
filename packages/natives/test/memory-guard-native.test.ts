import { describe, expect, it, vi } from "bun:test";
import { loadNative, validateLoadedBindings } from "../native/loader-state.js";

type ProbeResult = Record<string, unknown> & { kind: string; platform?: unknown };

function expectTaggedProbeResult(result: unknown): void {
	expect(result).toBeTruthy();
	expect(typeof result).toBe("object");
	const tagged = result as ProbeResult;
	expect(typeof tagged.kind).toBe("string");
	expect(typeof tagged.platform).toBe("string");
	switch (tagged.kind) {
		case "unsupported_platform":
			break;
		case "not_in_job":
			expect(tagged.isInJob).toBe(false);
			break;
		case "api_error":
			expect(typeof tagged.call).toBe("string");
			expect(typeof tagged.code).toBe("string");
			break;
		case "job_snapshot":
			expect(tagged.isInJob).toBe(true);
			for (const key of [
				"jobMemoryUsedBytes",
				"peakJobMemoryUsedBytes",
				"processPrivateUsageBytes",
				"processWorkingSetBytes",
				"peakProcessWorkingSetBytes",
			] as const) {
				expect(typeof tagged[key]).toBe("string");
			}
			for (const key of ["jobMemoryLimitBytes", "processMemoryLimitBytes"] as const) {
				expect(tagged[key] === undefined || tagged[key] === null || typeof tagged[key] === "string").toBe(true);
			}
			break;
		default:
			throw new Error(`Unexpected probe kind: ${tagged.kind}`);
	}
}

describe("checked recovery-close capability", () => {
	it("refuses same-version unchecked closure without executing a capability probe", () => {
		const capability = vi.fn(() => {
			throw new Error("Capability validation must not execute native operations");
		});
		const bindings = {
			__piNativesVCurrent: capability,
			__piNativesPublishOutcomeV1: capability,
			__gjcInstallTokioRuntime: capability,
			renameNoReplacePath: capability,
			probeWindowsJobMemory: capability,
			currentExecutablePath: capability,
			readOwnerOnlyFile: capability,
		};
		const context = { versionSentinelExport: "__piNativesVCurrent", packageVersion: "current" };
		expect(() => validateLoadedBindings(context, bindings, "cached-addon.node")).toThrow(
			"__piNativesCheckedRecoveryCloseV1",
		);
		validateLoadedBindings(context, { ...bindings, __piNativesCheckedRecoveryCloseV1: capability }, "current.node");
		expect(capability).not.toHaveBeenCalled();
	});
});

describe("probeWindowsJobMemory", () => {
	it("loads through the native loader and returns a tagged result", () => {
		const probe = loadNative().probeWindowsJobMemory;
		expect(typeof probe).toBe("function");
		expectTaggedProbeResult((probe as () => unknown)());
	});

	it("rejects stale same-version bindings without the memory probe capability", () => {
		const bindings = {
			__piNativesVCurrent: () => undefined,
			__gjcInstallTokioRuntime: () => undefined,
			__piNativesPublishOutcomeV1: () => undefined,
			__piNativesCheckedRecoveryCloseV1: () => undefined,
			renameNoReplacePath: () => undefined,
		};
		expect(() =>
			validateLoadedBindings(
				{ versionSentinelExport: "__piNativesVCurrent", packageVersion: "current" },
				bindings,
				"cached-addon.node",
			),
		).toThrow("probeWindowsJobMemory");
	});

	it("rejects stale same-version bindings without executable identity capability", () => {
		const bindings = {
			__piNativesVCurrent: () => undefined,
			__gjcInstallTokioRuntime: () => undefined,
			__piNativesPublishOutcomeV1: () => undefined,
			__piNativesCheckedRecoveryCloseV1: () => undefined,
			renameNoReplacePath: () => undefined,
			probeWindowsJobMemory: () => undefined,
		};
		expect(() =>
			validateLoadedBindings(
				{ versionSentinelExport: "__piNativesVCurrent", packageVersion: "current" },
				bindings,
				"cached-addon.node",
			),
		).toThrow("currentExecutablePath");
	});

	it("rejects stale same-version bindings without the owner-only reader", () => {
		const bindings = {
			__piNativesVCurrent: () => undefined,
			__gjcInstallTokioRuntime: () => undefined,
			__piNativesPublishOutcomeV1: () => undefined,
			__piNativesCheckedRecoveryCloseV1: () => undefined,
			renameNoReplacePath: () => undefined,
			probeWindowsJobMemory: () => undefined,
			currentExecutablePath: () => undefined,
		};
		const validate = (candidate: Record<string, unknown>) =>
			validateLoadedBindings(
				{ versionSentinelExport: "__piNativesVCurrent", packageVersion: "current" },
				candidate,
				"cached-addon.node",
			);
		expect(() => validate(bindings)).toThrow("readOwnerOnlyFile");
		expect(() => validate({ ...bindings, readOwnerOnlyFile: () => undefined })).not.toThrow();
	});
});

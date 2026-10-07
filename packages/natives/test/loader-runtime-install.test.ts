import { describe, expect, it } from "bun:test";
import { loadNative, validateLoadedBindings } from "../native/loader-state.js";

describe("native runtime installation", () => {
	it("installs the runtime once immediately after addon loading and before validation", () => {
		const events: string[] = [];
		const bindings = loadNative({
			context: {
				isCompiledBinary: false,
				platformTag: "darwin-arm64",
				packageVersion: "test",
				candidates: ["candidate.node"],
			},
			extractEmbeddedAddons: () => [],
			stageNodeModulesAddon: () => [],
			requireCandidate: candidate => {
				events.push(`dlopen:${candidate}`);
				return {
					__gjcInstallTokioRuntime: () => events.push("runtime"),
				};
			},
			validateCandidate: () => events.push("validate"),
		});

		expect(events).toEqual(["dlopen:candidate.node", "runtime", "validate"]);
		expect(typeof bindings.__gjcInstallTokioRuntime).toBe("function");
	});

	it("rejects otherwise-current bindings without the runtime installer", () => {
		const bindings = {
			__piNativesVCurrent: () => undefined,
			__piNativesPublishOutcomeV1: () => undefined,
			renameNoReplacePath: () => undefined,
			probeWindowsJobMemory: () => undefined,
			currentExecutablePath: () => undefined,
		};

		expect(() =>
			validateLoadedBindings(
				{ versionSentinelExport: "__piNativesVCurrent", packageVersion: "current" },
				bindings,
				"cached-addon.node",
			),
		).toThrow("__gjcInstallTokioRuntime");
	});
});

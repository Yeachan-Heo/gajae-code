import { describe, expect, it } from "bun:test";
import { assertRequiredSymbols, missingRequiredFunctions } from "../scripts/embed-guard";
import { missingRequiredAddonExports } from "../scripts/embed-native";

describe("memory-guard native build wiring", () => {
	it("rejects generated bindings that omit the Windows memory probe", () => {
		expect(() =>
			assertRequiredSymbols("export function nativeBuildInfo(): unknown;", [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
			]),
		).toThrow("probeWindowsJobMemory");
	});

	it("rejects native addons that omit the Windows memory probe", () => {
		expect(
			missingRequiredFunctions({ nativeBuildInfo: () => ({}) }, ["nativeBuildInfo", "probeWindowsJobMemory"]),
		).toEqual(["probeWindowsJobMemory"]);
		expect(
			missingRequiredFunctions({ nativeBuildInfo: () => ({}), probeWindowsJobMemory: () => ({}) }, [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
			]),
		).toEqual([]);
	});

	it("requires executable identity in embedded and generated native bindings", () => {
		expect(missingRequiredAddonExports({ nativeBuildInfo: () => ({}), probeWindowsJobMemory: () => ({}) })).toEqual([
			"currentExecutablePath",
		]);
		expect(() =>
			assertRequiredSymbols("export function probeWindowsJobMemory(): unknown;", ["currentExecutablePath"]),
		).toThrow("currentExecutablePath");
	});
});

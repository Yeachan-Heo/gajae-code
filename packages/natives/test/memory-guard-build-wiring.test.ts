import { describe, expect, it } from "bun:test";
import { validateGeneratedBindingSource } from "../scripts/build-native";
import { assertRequiredSymbols, missingRequiredFunctions } from "../scripts/embed-guard";
import { missingRequiredAddonExports } from "../scripts/embed-native";

function unexpectedNativeCall(): never {
	throw new Error("The binding guard must not invoke native operations");
}

function completeAddonFixture(): Record<string, unknown> {
	class NativeStagedDirectory {}
	class NativeOwnedStagedDirectory {}
	class NativeOwnedStagedFile {}
	class NativeStagedFile {}
	Object.assign(NativeStagedDirectory.prototype, {
		createOwnedChild: unexpectedNativeCall,
		bindFile: unexpectedNativeCall,
		syncSync: unexpectedNativeCall,
		release: unexpectedNativeCall,
	});
	Object.assign(NativeOwnedStagedDirectory.prototype, {
		creationResult: unexpectedNativeCall,
		bindFile: unexpectedNativeCall,
		syncSync: unexpectedNativeCall,
		retireEmptySync: unexpectedNativeCall,
		release: unexpectedNativeCall,
	});
	Object.assign(NativeOwnedStagedFile.prototype, {
		moveNoReplaceSync: unexpectedNativeCall,
		sealSync: unexpectedNativeCall,
		discardSync: unexpectedNativeCall,
		release: unexpectedNativeCall,
	});
	Object.assign(NativeStagedFile.prototype, {
		sealSync: unexpectedNativeCall,
		discardSync: unexpectedNativeCall,
		retirePublishedAliasSync: unexpectedNativeCall,
		release: unexpectedNativeCall,
	});
	return {
		nativeBuildInfo: unexpectedNativeCall,
		probeWindowsJobMemory: unexpectedNativeCall,
		currentExecutablePath: unexpectedNativeCall,
		readOwnerOnlyFile: unexpectedNativeCall,
		retainStagedDirectory: unexpectedNativeCall,
		NativeStagedDirectory,
		NativeOwnedStagedDirectory,
		NativeOwnedStagedFile,
		NativeStagedFile,
	};
}

const generatedBindingSymbols = [
	"DiffChange",
	"DiffRun",
	"DiffSide",
	"DiffStream",
	"DiffStreamProgress",
	"DiffStreamResult",
	"PatchHunk",
	"RecoveryFsRoot",
	"RecoveryFsIdentity",
	"RecoveryFsResult",
	"NativePublishDiagnostic",
	"NativePublishSyncFailure",
	"editFindMatch",
	"editSeekSequence",
	"diffLines",
	"diffWords",
	"openRecoveryFsRoot",
	"rasterizeSvg",
	"TtyWriter",
	"reassertRawTty",
	"repairOwnerOnlyPathSecurityExpected",
	"structuredPatchHunks",
	"verifyOwnerOnlyPathSecurityExpected",
	"probeWindowsJobMemory",
	"__gjcInstallTokioRuntime",
	"PowerAssertion",
	"currentExecutablePath",
	"readOwnerOnlyFile",
	"windowsOrdinalCaseFold",
	"retainStagedDirectory",
	"NativeStagedDirectory",
	"NativeOwnedStagedDirectory",
	"NativeOwnedStagedFile",
	"NativeStagedFile",
] as const;

const stagingMethods: ReadonlyArray<readonly [string, string]> = [
	["NativeStagedDirectory", "createOwnedChild"],
	["NativeOwnedStagedFile", "moveNoReplaceSync"],
	["NativeOwnedStagedFile", "sealSync"],
	["NativeOwnedStagedFile", "discardSync"],
	["NativeOwnedStagedFile", "release"],
	["NativeOwnedStagedDirectory", "creationResult"],
	["NativeOwnedStagedDirectory", "bindFile"],
	["NativeOwnedStagedDirectory", "syncSync"],
	["NativeOwnedStagedDirectory", "retireEmptySync"],
	["NativeOwnedStagedDirectory", "release"],
	["NativeStagedDirectory", "bindFile"],
	["NativeStagedDirectory", "syncSync"],
	["NativeStagedDirectory", "release"],
	["NativeStagedFile", "sealSync"],
	["NativeStagedFile", "discardSync"],
	["NativeStagedFile", "retirePublishedAliasSync"],
	["NativeStagedFile", "release"],
];

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
		const bindings = completeAddonFixture();
		delete bindings.currentExecutablePath;
		expect(missingRequiredAddonExports(bindings)).toEqual(["currentExecutablePath"]);
		expect(() =>
			assertRequiredSymbols("export function probeWindowsJobMemory(): unknown;", ["currentExecutablePath"]),
		).toThrow("currentExecutablePath");
	});

	it("requires the owner-only reader in embedded native addons", () => {
		const bindings = completeAddonFixture();
		delete bindings.readOwnerOnlyFile;
		expect(missingRequiredAddonExports(bindings)).toEqual(["readOwnerOnlyFile"]);
	});

	it("accepts complete staging capabilities without invoking them", () => {
		expect(missingRequiredAddonExports(completeAddonFixture())).toEqual([]);
		expect(validateGeneratedBindingSource(generatedBindingSymbols.join("\n"))).toBeUndefined();
	});

	for (const symbol of [
		"probeWindowsJobMemory",
		"currentExecutablePath",
		"readOwnerOnlyFile",
		"retainStagedDirectory",
		"NativeStagedDirectory",
		"NativeOwnedStagedDirectory",
		"NativeOwnedStagedFile",
		"NativeStagedFile",
	]) {
		it(`rejects generated bindings missing ${symbol}`, () => {
			const source = generatedBindingSymbols.filter(candidate => candidate !== symbol).join("\n");
			expect(() => validateGeneratedBindingSource(source)).toThrow(
				`napi build did not generate the required binding: ${symbol}`,
			);
		});
	}

	for (const symbol of [
		"nativeBuildInfo",
		"probeWindowsJobMemory",
		"retainStagedDirectory",
		"NativeStagedDirectory",
		"NativeOwnedStagedDirectory",
		"NativeOwnedStagedFile",
		"NativeStagedFile",
	]) {
		for (const invalid of ["missing", "noncallable"] as const) {
			it(`reports ${invalid} ${symbol} once without cascading method failures`, () => {
				const bindings = completeAddonFixture();
				if (invalid === "missing") delete bindings[symbol];
				else bindings[symbol] = {};
				expect(missingRequiredAddonExports(bindings)).toEqual([symbol]);
			});
		}
	}

	for (const [className, method] of stagingMethods) {
		for (const invalid of ["missing", "noncallable"] as const) {
			it(`reports ${invalid} ${className}.prototype.${method}`, () => {
				const bindings = completeAddonFixture();
				const nativeClass = bindings[className] as { prototype: Record<string, unknown> };
				if (invalid === "missing") delete nativeClass.prototype[method];
				else nativeClass.prototype[method] = true;
				expect(missingRequiredAddonExports(bindings)).toEqual([`${className}.prototype.${method}`]);
			});
		}
	}
});

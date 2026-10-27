import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAddonFilenames,
	loadNative,
	maybeStageNodeModulesAddon,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@gajae-code\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\gajae-code\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@gajae-code/natives/native";

function contentPath(versionedDir: string, filename: string, bytes: string): string {
	const hash = createHash("sha256").update(bytes).digest("hex");
	return path.join(versionedDir, `.content-${hash}-${filename}`);
}

async function makeInstalledContext(root: string, filenames: string[], bytes: string | Record<string, string>) {
	const nativeDir = path.join(root, "node_modules", "@gajae-code", "natives", "native");
	const versionedDir = path.join(root, "cache", "0.14.2");
	await fs.mkdir(nativeDir, { recursive: true });
	for (const filename of filenames) {
		const addonBytes = typeof bytes === "string" ? bytes : (bytes[filename] ?? "");
		await fs.writeFile(path.join(nativeDir, filename), addonBytes);
	}
	return {
		isCompiledBinary: false,
		platformTag: "win32-x64",
		packageVersion: "0.14.2",
		stageFromNodeModules: true,
		versionedDir,
		nativeDir,
		optionalPackageNativeDirs: [],
		addonFilenames: filenames,
		candidates: resolveLoaderCandidates({
			addonFilenames: filenames,
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir,
			execDir: path.join(root, "bin"),
			versionedDir,
			userDataDir: path.join(root, "userdata"),
		}),
	};
}

function loadSelected(context: { context: NonNullable<Parameters<typeof loadNative>[0]>["context"] }) {
	const attempted: string[] = [];
	const bindings = loadNative({
		...context,
		requireCandidate: candidate => {
			attempted.push(candidate);
			return { selected: candidate };
		},
		validateCandidate: () => undefined,
	});
	return { attempted, bindings };
}

describe("windows native addon loading", () => {
	it("stages only installed Windows packages", () => {
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("keeps package fallback order without synthesizing the retired fixed cache path", () => {
		const versionedDir = "C:\\Users\\Admin\\AppData\\Local\\gjc\\0.14.2";
		const filenames = getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "modern" });
		const candidates = resolveLoaderCandidates({
			addonFilenames: filenames,
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir: "C:\\Users\\Admin\\AppData\\Local\\gjc",
		});
		const direct = filenames.map(filename => path.join(winNodeModulesNativeDir, filename));
		expect(candidates).not.toContain(path.join(versionedDir, filenames[0]));
		expect(candidates).toEqual(expect.arrayContaining(direct));
		expect(candidates.indexOf(direct[0])).toBeLessThan(candidates.indexOf(direct[1]));
		expect(candidates.indexOf(direct[1])).toBeLessThan(candidates.indexOf(direct[2]));
	});

	it("reuses unchanged content and never attempts the direct node_modules candidate", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-reuse-"));
		const filename = "pi_natives.win32-x64-baseline.node";
		try {
			const firstContext = await makeInstalledContext(root, [filename], "same-addon");
			const first = loadSelected({ context: firstContext });
			const staged = first.attempted[0];
			expect(staged).toBe(contentPath(firstContext.versionedDir, filename, "same-addon"));
			expect(staged).not.toBe(path.join(firstContext.nativeDir, filename));
			expect(first.attempted).not.toContain(path.join(firstContext.nativeDir, filename));

			const secondContext = await makeInstalledContext(root, [filename], "same-addon");
			const second = loadSelected({ context: secondContext });
			expect(second.attempted).toEqual([staged]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("holds the staged candidate lease through validation and native loading", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-lease-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const context = await makeInstalledContext(root, [filename], "leased-addon");
			const events: string[] = [];
			const bindings = loadNative({
				context,
				acquireStagedCandidateLease: () => {
					events.push("acquire");
					return () => events.push("release");
				},
				requireCandidate: candidate => {
					events.push("require");
					expect(candidate).toBe(contentPath(context.versionedDir, filename, "leased-addon"));
					return { selected: candidate };
				},
				validateCandidate: () => events.push("validate-bindings"),
			});
			expect(bindings.selected).toBe(contentPath(context.versionedDir, filename, "leased-addon"));
			expect(events).toEqual(["acquire", "require", "validate-bindings", "release"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed when the staged candidate lease cannot be acquired", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-lease-fail-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const context = await makeInstalledContext(root, [filename], "leased-addon");
			let required = false;
			expect(() =>
				loadNative({
					context,
					acquireStagedCandidateLease: () => {
						throw new Error("lease unavailable");
					},
					requireCandidate: () => {
						required = true;
						return {};
					},
					validateCandidate: () => undefined,
				}),
			).toThrow("lease unavailable");
			expect(required).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("creates a new content path for same-version package drift without pruning the old winner", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-drift-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const firstContext = await makeInstalledContext(root, [filename], "old-addon");
			const first = loadSelected({ context: firstContext });
			await fs.writeFile(path.join(firstContext.nativeDir, filename), "new-addon");
			const secondContext = await makeInstalledContext(root, [filename], "new-addon");
			const second = loadSelected({ context: secondContext });
			expect(second.attempted[0]).toBe(contentPath(secondContext.versionedDir, filename, "new-addon"));
			expect(second.attempted[0]).not.toBe(first.attempted[0]);
			expect(await fs.readFile(first.attempted[0], "utf8")).toBe("old-addon");
			expect(await fs.readFile(second.attempted[0], "utf8")).toBe("new-addon");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves modern, baseline, and default staging order", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-order-"));
		const filenames = getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "modern" });
		try {
			const context = await makeInstalledContext(root, filenames, {
				[filenames[0]]: "modern-addon",
				[filenames[1]]: "baseline-addon",
				[filenames[2]]: "default-addon",
			});
			const attempted: string[] = [];
			const bindings = loadNative({
				context,
				requireCandidate: candidate => {
					attempted.push(candidate);
					if (attempted.length < 3) throw new Error("try next variant");
					return { selected: candidate };
				},
				validateCandidate: () => undefined,
			});
			expect(bindings.selected).toBe(contentPath(context.versionedDir, filenames[2], "default-addon"));
			expect(attempted).toEqual([
				contentPath(context.versionedDir, filenames[0], "modern-addon"),
				contentPath(context.versionedDir, filenames[1], "baseline-addon"),
				contentPath(context.versionedDir, filenames[2], "default-addon"),
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reuses a byte-identical concurrent winner", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-race-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const first = await makeInstalledContext(root, [filename], "winner-addon");
			const firstErrors: string[] = [];
			const firstWinner = maybeStageNodeModulesAddon(first, firstErrors);
			const second = await makeInstalledContext(root, [filename], "winner-addon");
			const secondErrors: string[] = [];
			const secondWinner = maybeStageNodeModulesAddon(second, secondErrors);
			expect(firstErrors).toEqual([]);
			expect(secondErrors).toEqual([]);
			expect(secondWinner).toEqual(firstWinner);
			expect(await fs.readFile(secondWinner[0], "utf8")).toBe("winner-addon");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a partial or mismatched content winner", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-winner-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const context = await makeInstalledContext(root, [filename], "complete-addon");
			const target = contentPath(context.versionedDir, filename, "complete-addon");
			await fs.mkdir(context.versionedDir, { recursive: true });
			await fs.writeFile(target, "partial-addon");
			const errors: string[] = [];
			expect(maybeStageNodeModulesAddon(context, errors)).toEqual([]);
			expect(errors.join("\n")).toContain("different bytes");
			expect(context.candidates).not.toContain(path.join(context.nativeDir, filename));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("loads libunwind.dll from the installed addon directory after staging", async () => {
		if (process.platform !== "win32") return;
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-unwind-"));
		const filename = "pi_natives.win32-arm64.node";
		try {
			const context = await makeInstalledContext(root, [filename], "arm64-addon");
			const installedDll = path.join(context.nativeDir, "libunwind.dll");
			const execDir = path.join(root, "bin");
			await fs.mkdir(execDir, { recursive: true });
			await fs.writeFile(installedDll, "installed-runtime");
			const loaded: string[] = [];
			const bindings = loadNative({
				context,
				loadNativeLibrary: runtime => {
					loaded.push(runtime);
					return 1n;
				},
				requireCandidate: candidate => ({ selected: candidate }),
				validateCandidate: () => undefined,
			});
			expect(await fs.readdir(execDir)).toEqual([]);
			expect(path.dirname(loaded[0] ?? "")).not.toBe(path.dirname(process.execPath));
			expect(loaded).toEqual([installedDll]);
			expect(bindings.selected).toBe(contentPath(context.versionedDir, filename, "arm64-addon"));
			expect(await fs.readdir(context.versionedDir)).not.toContain("libunwind.dll");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not fall through to execDir when installed addon staging fails", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-fallback-"));
		const filename = "pi_natives.win32-x64.node";
		try {
			const context = await makeInstalledContext(root, [filename], "complete-addon");
			const target = contentPath(context.versionedDir, filename, "complete-addon");
			await fs.mkdir(context.versionedDir, { recursive: true });
			await fs.writeFile(target, "mismatched-winner");
			const attempted: string[] = [];
			expect(() =>
				loadNative({
					context,
					requireCandidate: candidate => {
						attempted.push(candidate);
						return {};
					},
					validateCandidate: () => undefined,
				}),
			).toThrow("staged addon publish");
			expect(attempted).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("pi-natives version sentinel", () => {
	it("Rust js_name matches the package version", async () => {
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/pi-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__piNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch).not.toBeNull();
		expect(sentinelMatch?.[1]).toBe(`__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`);
	});
});

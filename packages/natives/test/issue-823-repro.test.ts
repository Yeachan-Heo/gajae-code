/**
 * Regression for https://github.com/can1357/gajae-code/issues/823.
 *
 * On WSL (and any host where the user moves the standalone binary away from the
 * build-time native artifacts), the compiled `gjc` binary fails to load
 * `pi_natives.linux-x64-*.node`. Root cause: the old loader's
 * `isCompiledBinary` detection relied on signals that are unreliable in a Bun
 * standalone binary:
 *   - `process.env.PI_COMPILED` — never set, because `bun build --compile
 *     --define PI_COMPILED=true` substitutes the bare identifier, not
 *     property accesses on `process.env`.
 *   - CommonJS `__filename` bunfs markers — Bun's compiled binaries kept the
 *     original build-host absolute path there, while `import.meta.url` is the
 *     value rewritten to the bunfs URL.
 *
 * When both signals were false, the loader skipped the embedded-addon
 * extraction path and only tried `nativeDir` (the dev machine's checkout) and
 * `execDir`. On WSL with `~/.local/bin/gjc` and no sibling `.node` file, this
 * failed with the error reported in the issue.
 *
 * The fix is to make the loader's compiled-binary detection authoritative on
 * the embedded-addon module presence (the embedded-addon stub exports `null`
 * outside of `--compile`, and is regenerated to a populated object during the
 * standalone build), and to expose the candidate-path computation as a pure
 * helper so it can be tested host-agnostically.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	detectCompiledBinary,
	getAddonFilenames,
	getOptionalPackageNames,
	loadFromCandidates,
	resolveLoaderCandidates,
	resolveOptionalPackageNativeDirs,
} from "../native/loader-state.js";

function validateCurrentSentinel(bindings: Record<string, unknown>) {
	if (typeof bindings.__piNativesVCurrent !== "function") throw new Error("missing current version sentinel");
}

describe("issue 823: standalone-binary native loader path resolution", () => {
	it("detects compiled-binary mode from embedded-addon presence when env and url markers are absent", () => {
		// Mirrors what a Bun standalone binary actually sees on linux-x64 / WSL:
		// - `process.env.PI_COMPILED` is undefined (the build flag does not substitute property accesses).
		// - `import.meta.url` points at `$bunfs` for bundled modules; the old CJS
		//   loader used `__filename`, which is NOT rewritten.
		// The embedded-addon module is the authoritative compiled-mode signal: it is `null` in
		// development (the stub) and a populated object in the standalone build (after
		// `embed:native` runs), and is bundled into the binary by `bun build --compile`.
		expect(
			detectCompiledBinary({
				embeddedAddon: {
					platformTag: "linux-x64",
					version: "14.5.2",
					files: [
						{
							variant: "modern",
							filename: "pi_natives.linux-x64-modern.node",
							filePath: "/$bunfs/root/packages/natives/native/pi_natives.linux-x64-modern.node",
						},
					],
				},
				env: {},
				importMetaUrl: "/home/u/build-host/packages/natives/native/index.js",
			}),
		).toBe(true);

		// Without an embedded-addon and without env/url markers, we are NOT compiled.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "/home/u/dev/packages/natives/native/index.js",
			}),
		).toBe(false);

		// Env override (e.g. user-set PI_COMPILED=1) still wins.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: { PI_COMPILED: "1" },
				importMetaUrl: "/anywhere",
			}),
		).toBe(true);

		// `import.meta.url` bunfs marker still wins when present.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "file:///$bunfs/root/cli",
			}),
		).toBe(true);
	});

	it("places embedded-extracted candidates ahead of build-host candidates for linux-x64 standalone", () => {
		const versionedDir = "/home/u/.gjc/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const nativeDir = "/build-host/packages/natives/native";
		const execDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" }),
			isCompiledBinary: true,
			nativeDir,
			execDir,
			versionedDir,
			userDataDir,
		});

		const versionedModern = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const userDataModern = path.join(userDataDir, "pi_natives.linux-x64-modern.node");
		const buildHostModern = path.join(nativeDir, "pi_natives.linux-x64-modern.node");

		// Versioned cache and user-data dir candidates must exist for compiled binaries —
		// these are where the embedded-addon extraction lands (~/.gjc/natives/<v>) and where
		// `gjc update` writes the standalone binary on linux (~/.local/bin).
		expect(candidates).toContain(versionedModern);
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(userDataModern);

		// Order matters: embedded-extracted destinations must be probed before the
		// (potentially-missing) build-host nativeDir path from the bundled module location.
		expect(candidates.indexOf(versionedModern)).toBeLessThan(candidates.indexOf(buildHostModern));
	});

	it("does not probe user-data candidates when running outside a standalone binary", () => {
		const versionedDir = "/home/u/.gjc/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			nativeDir: "/repo/packages/natives/native",
			execDir: "/usr/bin",
			versionedDir,
			userDataDir,
		});
		expect(candidates).not.toContain(path.join(versionedDir, "pi_natives.linux-x64-baseline.node"));
		expect(candidates).not.toContain(path.join(userDataDir, "pi_natives.linux-x64-baseline.node"));
	});

	it("prefers host optional package candidates before legacy bundled candidates", () => {
		const optionalNativeDir = "/repo/node_modules/@gajae-code/natives-linux-x64/native";
		const nativeDir = "/repo/node_modules/@gajae-code/natives/native";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" }),
			isCompiledBinary: false,
			stageFromNodeModules: false,
			optionalPackageNativeDirs: [optionalNativeDir],
			nativeDir,
			execDir: "/usr/bin",
			versionedDir: "/home/u/.gjc/natives/14.5.2",
			userDataDir: "/home/u/.local/bin",
		});

		const optionalModern = path.join(optionalNativeDir, "pi_natives.linux-x64-modern.node");
		const optionalBaseline = path.join(optionalNativeDir, "pi_natives.linux-x64-baseline.node");
		const legacyModern = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
		expect(candidates).toContain(optionalModern);
		expect(candidates).toContain(legacyModern);
		expect(candidates.indexOf(optionalModern)).toBeLessThan(candidates.indexOf(legacyModern));
		expect(candidates.indexOf(optionalBaseline)).toBeLessThan(candidates.indexOf(legacyModern));
	});

	it("resolves only the current host optional package directory when installed", () => {
		const packageNames = getOptionalPackageNames("darwin-arm64");
		expect(packageNames).toEqual(["@gajae-code/natives-darwin-arm64"]);

		const dirs = resolveOptionalPackageNativeDirs({
			packageNames,
			requireResolve: id => {
				if (id === "@gajae-code/natives-darwin-arm64/package.json") {
					return "/repo/node_modules/@gajae-code/natives-darwin-arm64/package.json";
				}
				throw new Error(`missing ${id}`);
			},
		});

		expect(dirs).toEqual(["/repo/node_modules/@gajae-code/natives-darwin-arm64/native"]);
		expect(getOptionalPackageNames("freebsd-x64")).toEqual([]);
	});
	it("prefers the current workspace addon over a stale optional package addon", () => {
		const localDir = "/repo/packages/natives/native";
		const optionalDir = "/repo/node_modules/@gajae-code/natives-linux-x64/native";
		const filename = "pi_natives.linux-x64-modern.node";
		const local = path.join(localDir, filename);
		const optional = path.join(optionalDir, filename);
		const candidates = resolveLoaderCandidates({
			addonFilenames: [filename],
			isCompiledBinary: false,
			isWorkspaceLoad: true,
			optionalPackageNativeDirs: [optionalDir],
			nativeDir: localDir,
			execDir: "/usr/bin",
			versionedDir: "/home/u/.gjc/natives/14.5.2",
			userDataDir: "/home/u/.local/bin",
		});
		const loaded = loadFromCandidates({
			candidates,
			requireCandidate: candidate =>
				candidate === local ? { __piNativesVCurrent: () => undefined } : { __piNativesVStale: () => undefined },
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(candidates.indexOf(local)).toBeLessThan(candidates.indexOf(optional));
		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(loaded.errors).toEqual([]);
	});

	it("keeps workspace precedence when local and optional addons have the same sentinel", () => {
		const local = "/repo/packages/natives/native/pi_natives.linux-x64.node";
		const optional = "/repo/node_modules/@gajae-code/natives-linux-x64/native/pi_natives.linux-x64.node";
		const attempted: string[] = [];
		const loaded = loadFromCandidates({
			candidates: [local, optional],
			requireCandidate: candidate => {
				attempted.push(candidate);
				return { __piNativesVCurrent: () => undefined };
			},
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(attempted).toEqual([local]);
	});

	it("continues from a stale optional addon to a current local addon", () => {
		const optional = "/repo/node_modules/@gajae-code/natives-linux-x64/native/pi_natives.linux-x64.node";
		const local = "/repo/packages/natives/native/pi_natives.linux-x64.node";
		const loaded = loadFromCandidates({
			candidates: [optional, local],
			requireCandidate: candidate =>
				candidate === local ? { __piNativesVCurrent: () => undefined } : { __piNativesVStale: () => undefined },
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(loaded.errors).toEqual([`${optional}: missing current version sentinel`]);
	});

	it("falls back to a matching optional addon when no local addon is available", () => {
		const local = "/repo/packages/natives/native/pi_natives.linux-x64.node";
		const optional = "/repo/node_modules/@gajae-code/natives-linux-x64/native/pi_natives.linux-x64.node";
		const loaded = loadFromCandidates({
			candidates: [local, optional],
			requireCandidate: candidate => {
				if (candidate === optional) return { __piNativesVCurrent: () => undefined };
				throw new Error("not found");
			},
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(loaded.errors).toEqual([`${local}: not found`]);
	});

	it("loads a matching optional addon", () => {
		const optional = "/repo/node_modules/@gajae-code/natives-linux-x64/native/pi_natives.linux-x64.node";
		const loaded = loadFromCandidates({
			candidates: [optional],
			requireCandidate: () => ({ __piNativesVCurrent: () => undefined }),
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(loaded.errors).toEqual([]);
	});

	it("aggregates diagnostics when every candidate has an incompatible sentinel", () => {
		const staleOptional = "/repo/node_modules/@gajae-code/natives-linux-x64/native/pi_natives.linux-x64.node";
		const staleLegacy = "/usr/bin/pi_natives.linux-x64.node";
		const loaded = loadFromCandidates({
			candidates: [staleOptional, staleLegacy],
			requireCandidate: () => ({ __piNativesVStale: () => undefined }),
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toBeNull();
		expect(loaded.errors).toEqual([
			`${staleOptional}: missing current version sentinel`,
			`${staleLegacy}: missing current version sentinel`,
		]);
	});

	it("continues from an incompatible modern addon to a current baseline addon", () => {
		const modern = "/repo/packages/natives/native/pi_natives.linux-x64-modern.node";
		const baseline = "/repo/packages/natives/native/pi_natives.linux-x64-baseline.node";
		const loaded = loadFromCandidates({
			candidates: [modern, baseline],
			requireCandidate: candidate =>
				candidate === baseline ? { __piNativesVCurrent: () => undefined } : { __piNativesVStale: () => undefined },
			validateCandidate: validateCurrentSentinel,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toEqual({ __piNativesVCurrent: expect.any(Function) });
		expect(loaded.errors).toEqual([`${modern}: missing current version sentinel`]);
	});

	it("preserves Windows staging ahead of package candidates", () => {
		const filename = "pi_natives.win32-x64-baseline.node";
		const versionedDir = "C:\\Users\\u\\AppData\\Local\\gjc\\14.5.2";
		const optionalDir = "C:\\repo\\node_modules\\@gajae-code\\natives-win32-x64\\native";
		const candidates = resolveLoaderCandidates({
			addonFilenames: [filename],
			isCompiledBinary: false,
			stageFromNodeModules: true,
			optionalPackageNativeDirs: [optionalDir],
			nativeDir: "C:\\repo\\node_modules\\@gajae-code\\natives\\native",
			execDir: "C:\\gjc",
			versionedDir,
			userDataDir: "C:\\Users\\u\\AppData\\Local\\gjc",
		});

		expect(candidates[0]).toBe(path.join(versionedDir, filename));
		expect(candidates.indexOf(path.join(optionalDir, filename))).toBeGreaterThan(0);
	});
});

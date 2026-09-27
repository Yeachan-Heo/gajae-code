import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Read-only diagnostic addon loader (DESIGN §B3).
 *
 * The loader may only read one fixed package-owned artifact. It must never run
 * the ordinary loader graph (`native/index.js` → `loadNative()` →
 * `initNativeCrashDiagnostics`), never extract an embedded payload, never
 * mkdir/chmod/rename, and never scan alternative candidates from the cwd, the
 * environment or an agent directory.
 */

const NATIVE_DIR = path.join(import.meta.dir, "..", "native");
const LOADER = path.join(NATIVE_DIR, "diagnostic-loader.js");
const ARTIFACT = path.join(NATIVE_DIR, "pi_natives.darwin-arm64.node");
const SUPPORTED_RUNTIME = process.platform === "darwin" && process.arch === "arm64";

/**
 * Whether any component of a path carries an extended ACL, observed independently of
 * the loader (through `ls -lde`) so expectations are never derived from the code
 * under test.
 *
 * The loader refuses every component with an ACL, because an ACE can grant another
 * account write access that `st_mode` never shows. On a host whose home directory
 * carries an ACL -- the macOS default is `group:everyone deny delete` -- no path
 * below it is admissible, so positive expectations must follow this observation
 * instead of assuming one environment. An ACL-free root is the open fixture gate.
 */
function pathChainHasAcl(target: string): boolean {
	let current = target;
	for (;;) {
		if (aclEntriesOf(current).length > 0) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** ACE lines for one path, observed independently of the code under test. */
function aclEntriesOf(target: string): string[] {
	const listed = Bun.spawnSync({ cmd: ["/bin/ls", "-lde", target], stdout: "pipe", stderr: "pipe" });
	return new TextDecoder()
		.decode(listed.stdout ?? new Uint8Array())
		.split("\n")
		.filter(line => /^\s*\d+:\s/.test(line))
		.map(line => line.replace(/^\s*\d+:\s*/, "").trim());
}

/**
 * The approved contract: the artifact's own directory (the namespace anchor) and the
 * artifact file keep strict ACL absence, while a trusted ancestor strictly above the
 * anchor may carry exactly one non-inheriting everyone DENY DELETE entry.
 */
function chainSatisfiesAclContract(artifact: string): boolean {
	if (aclEntriesOf(artifact).length > 0) return false;
	let current = path.dirname(artifact);
	let isAnchor = true;
	for (;;) {
		const entries = aclEntriesOf(current);
		if (isAnchor) {
			if (entries.length > 0) return false;
		} else if (entries.length > 0) {
			if (entries.length !== 1) return false;
			if (entries[0] !== "group:everyone deny delete") return false;
		}
		const parent = path.dirname(current);
		if (parent === current) return true;
		current = parent;
		isAnchor = false;
	}
}

/** The outcome the loader must produce for an otherwise valid artifact at `target`. */
function expectedLoadOutcome(target: string): { ok: true } | { ok: false; reason: string } {
	return chainSatisfiesAclContract(target) ? { ok: true } : { ok: false, reason: "unsupported" };
}

/** SHA-256 of a file, used to mirror the package-owned trusted digest in fixtures. */
async function fixtureSha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
	return hasher.digest("hex");
}

/** Strip comments so prose can never satisfy or break a code-level assertion. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** A fixture package root that mirrors the real private subpath layout. */
async function fixturePackage(workspace: string): Promise<string> {
	const nativeDir = path.join(workspace, "native");
	await fs.mkdir(nativeDir, { recursive: true });
	await Bun.write(path.join(nativeDir, "diagnostic-loader.js"), await Bun.file(LOADER).text());
	const manifest = (await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string };
	await Bun.write(path.join(workspace, "package.json"), JSON.stringify({ version: manifest.version }));
	// The loader carries its package-owned trusted digest record in its module graph.
	await Bun.write(
		path.join(nativeDir, "diagnostic-artifact.json"),
		JSON.stringify({
			schema: "gjc.diagnostic-artifact",
			version: manifest.version,
			artifacts: { "pi_natives.darwin-arm64.node": await fixtureSha256(ARTIFACT) },
		}),
	);
	return nativeDir;
}

type LoadResult =
	| { ok: true; value: { openDiagnosticSnapshot: (agentDir: string, budgetMs: number) => unknown } }
	| { ok: false; reason: string };

async function loadInSubprocess(
	options: { artifact?: string; env?: Record<string, string>; cwd?: string } = {},
): Promise<{ result: LoadResult; sideEffects: string[]; stderr: string }> {
	const harness = `
const mutations = [];
const nodeFs = require("node:fs");
for (const name of ["mkdirSync", "writeFileSync", "renameSync", "chmodSync", "rmSync", "unlinkSync", "copyFileSync"]) {
	const original = nodeFs[name];
	if (typeof original !== "function") continue;
	nodeFs[name] = (...args) => {
		mutations.push("fs." + name);
		throw Object.assign(new Error("trap: mutation blocked"), { code: "EPERM" });
	};
}
Bun.spawn = () => { mutations.push("Bun.spawn"); throw new Error("trap: spawn blocked"); };
Bun.spawnSync = () => { mutations.push("Bun.spawnSync"); throw new Error("trap: spawn blocked"); };
const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(LOADER)});
const loaded = loadDiagnosticNativeReadOnly();
const result = loaded.ok
	? { ok: true, exportType: typeof loaded.value.openDiagnosticSnapshot }
	: { ok: false, reason: loaded.reason };
console.log(JSON.stringify({ result, mutations }));
`;
	const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-loader-"));
	try {
		const harnessPath = path.join(workspace, "harness.ts");
		await Bun.write(harnessPath, harness);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harnessPath],
			cwd: options.cwd ?? workspace,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: workspace,
				TMPDIR: workspace,
				...(options.env ?? {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array());
		const stderr = new TextDecoder().decode(child.stderr ?? new Uint8Array());
		const parsed = JSON.parse(stdout.trim()) as {
			result: { ok: boolean; reason?: string; exportType?: string };
			mutations: string[];
		};
		return {
			result: parsed.result.ok
				? ({ ok: true, value: { openDiagnosticSnapshot: (() => undefined) as never } } as LoadResult)
				: ({ ok: false, reason: parsed.result.reason ?? "<missing>" } as LoadResult),
			sideEffects: parsed.mutations,
			stderr,
		};
	} finally {
		await fs.rm(workspace, { recursive: true, force: true });
	}
}

describe("read-only diagnostic native loader (B3)", () => {
	it("exposes only the snapshot entry point and no ordinary loader surface", async () => {
		const code = stripComments(await Bun.file(LOADER).text());
		for (const forbidden of ["./index.js", "loader-state", "embedded-addon", "initNativeCrashDiagnostics"]) {
			expect(code).not.toContain(forbidden);
		}
		for (const forbiddenApi of ["mkdir", "chmod", "rename", "writeFile", "rmSync", "unlink"]) {
			expect(code).not.toContain(forbiddenApi);
		}
		expect(code).toContain("pi_natives.darwin-arm64.node");
	});

	it("declares the private subpath types", async () => {
		const types = await Bun.file(`${LOADER.replace(/\.js$/, "")}.d.ts`).text();
		expect(types).toContain("loadDiagnosticNativeReadOnly");
		expect(types).toContain("openDiagnosticSnapshot");
		const manifest = (await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as {
			exports: Record<string, unknown>;
			files: string[];
		};
		expect(manifest.exports["./diagnostic-loader"]).toBeDefined();
		expect(manifest.files).toContain("native/diagnostic-loader.js");
		expect(manifest.files).toContain("native/diagnostic-loader.d.ts");
	});

	it.skipIf(!SUPPORTED_RUNTIME)("loads the fixed package artifact without any mutation or child process", async () => {
		const artifactExists = await Bun.file(ARTIFACT).exists();
		expect(artifactExists).toBe(true);
		const { result, sideEffects, stderr } = await loadInSubprocess();
		expect(sideEffects).toEqual([]);
		expect(stderr).toBe("");
		expect(result.ok).toBe(expectedLoadOutcome(ARTIFACT).ok);
	});

	it.skipIf(!SUPPORTED_RUNTIME)("ignores cwd and environment candidate overrides", async () => {
		const { result, sideEffects } = await loadInSubprocess({
			env: {
				GJC_CODING_AGENT_DIR: "/nonexistent-agent",
				GJC_NATIVE_ADDON_PATH: "/nonexistent-addon.node",
				PI_NATIVE_ADDON_PATH: "/nonexistent-addon.node",
			},
		});
		expect(sideEffects).toEqual([]);
		expect(result.ok).toBe(expectedLoadOutcome(ARTIFACT).ok);
	});

	it("refuses every runtime tuple except darwin/arm64 before touching the filesystem", async () => {
		const code = stripComments(await Bun.file(LOADER).text());
		expect(code).toContain('"darwin"');
		expect(code).toContain('"arm64"');
		expect(code).toContain('reason: "unsupported"');
		// Inspect the load path itself: the tuple decision must precede artifact
		// resolution and every filesystem read inside it.
		const loadPath = code.slice(code.indexOf("export function loadDiagnosticNativeReadOnly"));
		const platformGuard = loadPath.indexOf("supportedRuntime(actualRuntime)");
		expect(platformGuard).toBeGreaterThan(0);
		expect(platformGuard).toBeLessThan(loadPath.indexOf("selectArtifactLayout(require)"));
		expect(platformGuard).toBeLessThan(loadPath.indexOf("verifyDiagnosticArtifact(layout)"));
	});

	it.skipIf(!SUPPORTED_RUNTIME)("reports unsupported for a corrupt artifact without repairing it", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-corrupt-"));
		try {
			const corruptNative = await fixturePackage(workspace);
			await Bun.write(path.join(corruptNative, "pi_natives.darwin-arm64.node"), "not a mach-o addon");
			const harness = path.join(workspace, "corrupt.ts");
			await Bun.write(
				harness,
				`const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(
					path.join(corruptNative, "diagnostic-loader.js"),
				)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`,
			);
			const child = Bun.spawnSync({
				cmd: [process.execPath, harness],
				cwd: workspace,
				env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
				stdout: "pipe",
				stderr: "pipe",
			});
			const parsed = JSON.parse(new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim()) as {
				ok: boolean;
				reason?: string;
			};
			expect(parsed).toEqual({ ok: false, reason: "unsupported" });
			// The corrupt artifact is left exactly as written: no repair, no rename.
			expect(await Bun.file(path.join(corruptNative, "pi_natives.darwin-arm64.node")).text()).toBe(
				"not a mach-o addon",
			);
			const entries = await fs.readdir(corruptNative);
			expect(entries.sort()).toEqual([
				"diagnostic-artifact.json",
				"diagnostic-loader.js",
				"pi_natives.darwin-arm64.node",
			]);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it.skipIf(!SUPPORTED_RUNTIME)("reports unsupported for a missing artifact", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-missing-"));
		try {
			const emptyNative = await fixturePackage(workspace);
			const harness = path.join(workspace, "missing.ts");
			await Bun.write(
				harness,
				`const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(
					path.join(emptyNative, "diagnostic-loader.js"),
				)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`,
			);
			const child = Bun.spawnSync({
				cmd: [process.execPath, harness],
				cwd: workspace,
				env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
				stdout: "pipe",
				stderr: "pipe",
			});
			const parsed = JSON.parse(new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim()) as {
				ok: boolean;
				reason?: string;
			};
			expect(parsed).toEqual({ ok: false, reason: "unsupported" });
			expect((await fs.readdir(emptyNative)).sort()).toEqual(["diagnostic-artifact.json", "diagnostic-loader.js"]);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});

/**
 * Compiled-distribution behavior (DESIGN §B3): a compiled binary may use ONLY an
 * already verified cached artifact at the existing fixed trusted location. It
 * must never extract an embedded payload, create the cache, repair it or accept a
 * mismatched build. A source-mode subprocess is not proof of any of this, so
 * these cases build a real `bun build --compile` binary.
 */
describe("trusted artifact verification (R1) and package layout resolution (R5)", () => {
	const PACKAGE_ROOT_DIR = path.join(NATIVE_DIR, "..");
	const TRUSTED_MANIFEST = path.join(NATIVE_DIR, "diagnostic-artifact.json");
	const ADDON_BASENAME = "pi_natives.darwin-arm64.node";

	async function sha256(file: string): Promise<string> {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
		return hasher.digest("hex");
	}

	async function packageVersion(): Promise<string> {
		return ((await Bun.file(path.join(PACKAGE_ROOT_DIR, "package.json")).json()) as { version: string }).version;
	}

	/**
	 * A fixture natives package: the loader, its manifest and a package-owned
	 * trusted-digest file. The artifact itself is placed by each case, either
	 * beside the loader, inside an optional platform package, or not at all.
	 */
	async function fixtureNatives(
		workspace: string,
		options: { digest?: string; version?: string; omitManifest?: boolean } = {},
	): Promise<{ root: string; native: string; loader: string }> {
		const root = path.join(workspace, "pkg");
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		const version = options.version ?? (await packageVersion());
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				// `omitManifest` models a package that ships a record with no trusted
				// entry for this artifact; the loader must then refuse to load anything.
				artifacts: options.omitManifest ? {} : { [ADDON_BASENAME]: options.digest ?? (await sha256(ARTIFACT)) },
			}),
		);
		return { root, native, loader: path.join(native, "diagnostic-loader.js") };
	}

	async function loadInFixture(loader: string, cwd: string): Promise<{ ok: boolean; reason?: string }> {
		const harness = path.join(path.dirname(loader), "..", "load.ts");
		await Bun.write(
			harness,
			`const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(loader)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`,
		);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		return JSON.parse(stdout) as { ok: boolean; reason?: string };
	}

	it.skipIf(!SUPPORTED_RUNTIME)("ships a package-owned trusted digest for the built artifact", async () => {
		const manifest = (await Bun.file(TRUSTED_MANIFEST).json()) as {
			version: string;
			artifacts: Record<string, string>;
		};
		expect(manifest.version).toBe(await packageVersion());
		expect(manifest.artifacts[ADDON_BASENAME]).toBe(await sha256(ARTIFACT));
		const packed = (await Bun.file(path.join(PACKAGE_ROOT_DIR, "package.json")).json()) as { files: string[] };
		expect(packed.files).toContain("native/diagnostic-artifact.json");
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses an artifact whose bytes are not the trusted ones, even when it self-reports the right version",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-digest-"));
			try {
				const fixture = await fixtureNatives(workspace, { digest: "0".repeat(64) });
				await fs.copyFile(ARTIFACT, path.join(fixture.native, ADDON_BASENAME));
				// The addon is the genuine freshly built one and reports the exact package
				// version through nativeBuildInfo(); only the trusted digest disagrees.
				expect(await loadInFixture(fixture.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses a symlinked artifact and a symlinked ancestor",
		async () => {
			for (const shape of ["artifact", "ancestor"] as const) {
				const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `gjc-diag-link-${shape}-`));
				try {
					const fixture = await fixtureNatives(workspace);
					const real = path.join(workspace, "real-addon.node");
					await fs.copyFile(ARTIFACT, real);
					if (shape === "artifact") {
						await fs.symlink(real, path.join(fixture.native, ADDON_BASENAME));
					} else {
						// node_modules resolution path traverses a symlinked directory.
						const realDir = path.join(workspace, "real-native");
						await fs.mkdir(realDir, { recursive: true });
						await fs.copyFile(ARTIFACT, path.join(realDir, ADDON_BASENAME));
						const platformRoot = path.join(fixture.root, "node_modules", "@gajae-code", "natives-darwin-arm64");
						await fs.mkdir(platformRoot, { recursive: true });
						await Bun.write(
							path.join(platformRoot, "package.json"),
							JSON.stringify({
								name: "@gajae-code/natives-darwin-arm64",
								version: await packageVersion(),
								exports: { "./package.json": "./package.json" },
							}),
						);
						await fs.symlink(realDir, path.join(platformRoot, "native"));
					}
					expect(await loadInFixture(fixture.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
				} finally {
					await fs.rm(workspace, { recursive: true, force: true });
				}
			}
		},
		180_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses a group-writable artifact",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-mode-"));
			try {
				const fixture = await fixtureNatives(workspace);
				const artifact = path.join(fixture.native, ADDON_BASENAME);
				await fs.copyFile(ARTIFACT, artifact);
				await fs.chmod(artifact, 0o666);
				expect(await loadInFixture(fixture.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses to load without a package-owned trusted digest entry",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-nomanifest-"));
			try {
				const fixture = await fixtureNatives(workspace, { omitManifest: true });
				await fs.copyFile(ARTIFACT, path.join(fixture.native, ADDON_BASENAME));
				expect(await loadInFixture(fixture.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });

				// A record for another package version is equally untrusted.
				const stale = await fixtureNatives(path.join(workspace, "stale"), { version: "0.0.0-stale" });
				await fs.copyFile(ARTIFACT, path.join(stale.native, ADDON_BASENAME));
				expect(await loadInFixture(stale.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"loads the real published layout: the optional platform package supplies the artifact (R5)",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-pack-"));
			try {
				const fixture = await fixtureNatives(workspace);
				// No addon beside the loader: exactly the `npm pack` layout of
				// @gajae-code/natives, whose `files` list ships no .node at all.
				expect(await Bun.file(path.join(fixture.native, ADDON_BASENAME)).exists()).toBe(false);
				const platformRoot = path.join(fixture.root, "node_modules", "@gajae-code", "natives-darwin-arm64");
				const platformNative = path.join(platformRoot, "native");
				await fs.mkdir(platformNative, { recursive: true });
				await Bun.write(
					path.join(platformRoot, "package.json"),
					JSON.stringify({
						name: "@gajae-code/natives-darwin-arm64",
						version: await packageVersion(),
						os: ["darwin"],
						cpu: ["arm64"],
						exports: { "./package.json": "./package.json" },
					}),
				);
				const platformArtifact = path.join(platformNative, ADDON_BASENAME);
				await fs.copyFile(ARTIFACT, platformArtifact);
				expect(await loadInFixture(fixture.loader, workspace)).toEqual(expectedLoadOutcome(platformArtifact));

				// Missing optional artifact is unsupported, never a search.
				await fs.rm(path.join(platformNative, ADDON_BASENAME));
				expect(await loadInFixture(fixture.loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		180_000,
	);
});

describe("artifact activation is pinned to the verified bytes (R1 reopened)", () => {
	const PKG_DIR = path.join(NATIVE_DIR, "..");
	const ADDON = "pi_natives.darwin-arm64.node";

	async function pkgVersion(): Promise<string> {
		return ((await Bun.file(path.join(PKG_DIR, "package.json")).json()) as { version: string }).version;
	}

	/** A fixture natives package whose trusted record matches the real artifact. */
	async function fixture(workspace: string): Promise<{ native: string; loader: string; artifact: string }> {
		const root = path.join(workspace, "pkg");
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		const version = await pkgVersion();
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { [ADDON]: await fixtureSha256(ARTIFACT) },
			}),
		);
		const artifact = path.join(native, ADDON);
		await fs.copyFile(ARTIFACT, artifact);
		return { native, loader: path.join(native, "diagnostic-loader.js"), artifact };
	}

	async function runProbe(script: string, cwd: string): Promise<Record<string, unknown>> {
		const harness = path.join(cwd, `probe-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(harness, script);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		const stderr = new TextDecoder().decode(child.stderr ?? new Uint8Array());
		if (stdout === "") throw new Error(`probe produced no output: ${stderr.slice(0, 400)}`);
		return JSON.parse(stdout) as Record<string, unknown>;
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"activates the exact verified bytes even after the pathname is replaced",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-swap-"));
			try {
				const { loader, artifact } = await fixture(workspace);
				// Two-phase boundary: verification hands back a pinned handle, activation
				// consumes that handle. Between the two the pathname is replaced with bytes
				// that would never pass verification.
				const script = `const fs = require("node:fs");
const { verifyDiagnosticArtifact, activateVerifiedArtifact } = await import(${JSON.stringify(loader)});
const verified = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
if (!verified.ok) { console.log(JSON.stringify({ stage: "verify", reason: verified.reason })); process.exit(0); }
const decoy = ${JSON.stringify(artifact)} + ".decoy";
fs.writeFileSync(decoy, "swapped-not-an-addon");
fs.renameSync(decoy, ${JSON.stringify(artifact)});
const activated = activateVerifiedArtifact(verified);
console.log(JSON.stringify({
	stage: "activate",
	ok: activated.ok,
	reason: activated.reason ?? null,
	exportType: activated.ok ? typeof activated.value.openDiagnosticSnapshot : null,
	pathBytesNow: fs.readFileSync(${JSON.stringify(artifact)}, "utf8"),
}));`;
				const result = await runProbe(script, workspace);
				const admissible = expectedLoadOutcome(artifact).ok;
				expect(result).toEqual(
					admissible
						? {
								stage: "activate",
								ok: true,
								reason: null,
								exportType: "function",
								pathBytesNow: "swapped-not-an-addon",
							}
						: { stage: "verify", reason: "unsupported" },
				);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"pins activation to the descriptor's vnode, not to the pathname",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-vnode-"));
			try {
				const original = path.join(workspace, "original.bin");
				await Bun.write(original, "original-bytes");
				const script = `const fs = require("node:fs");
const fd = fs.openSync(${JSON.stringify(original)}, fs.constants.O_RDONLY);
const decoy = ${JSON.stringify(original)} + ".decoy";
fs.writeFileSync(decoy, "replacement-bytes");
fs.renameSync(decoy, ${JSON.stringify(original)});
const afterRename = {
	viaDescriptorPath: fs.readFileSync("/dev/fd/" + fd, "utf8"),
	viaPathname: fs.readFileSync(${JSON.stringify(original)}, "utf8"),
};
// Known limitation, asserted rather than implied: an in-place rewrite of the SAME
// inode is visible through the descriptor too. Only the owner or root can do that
// here, because the loader refuses group/other-writable files and ancestors.
const inPlaceFd = fs.openSync(${JSON.stringify(original)}, fs.constants.O_RDONLY);
fs.writeFileSync(${JSON.stringify(original)}, "rewritten-in-place");
console.log(JSON.stringify({
	afterRename,
	inPlaceViaDescriptorPath: fs.readFileSync("/dev/fd/" + inPlaceFd, "utf8"),
}));`;
				expect(await runProbe(script, workspace)).toEqual({
					afterRename: { viaDescriptorPath: "original-bytes", viaPathname: "replacement-bytes" },
					inPlaceViaDescriptorPath: "rewritten-in-place",
				});
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses an artifact whose ancestor is writable by group or other, before any activation",
		async () => {
			for (const mode of [0o777, 0o757, 0o775] as const) {
				const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-ambient-"));
				try {
					const { loader, native } = await fixture(workspace);
					await fs.chmod(native, mode);
					const script = `const { verifyDiagnosticArtifact, loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(
						loader,
					)});
const verified = verifyDiagnosticArtifact(${JSON.stringify(path.join(native, ADDON))});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify({
	verified: verified.ok ? { ok: true } : { ok: false, reason: verified.reason },
	loaded: loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason },
}));`;
					const probed = await runProbe(script, workspace);
					const observed: Record<string, unknown> = { mode, ...probed };
					expect(observed).toEqual({
						mode,
						verified: { ok: false, reason: "unsupported" },
						loaded: { ok: false, reason: "unsupported" },
					});
				} finally {
					await fs.chmod(path.join(workspace, "pkg", "native"), 0o755).catch(() => undefined);
					await fs.rm(workspace, { recursive: true, force: true });
				}
			}
		},
		240_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"never activates bytes that failed verification",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-noactivate-"));
			try {
				const { loader, artifact } = await fixture(workspace);
				// Genuine addon bytes, but the trusted record is replaced with another digest:
				// verification must fail and activation must never be reachable.
				const record = path.join(path.dirname(artifact), "diagnostic-artifact.json");
				const parsed = (await Bun.file(record).json()) as { version: string; artifacts: Record<string, string> };
				await Bun.write(record, JSON.stringify({ ...parsed, artifacts: { [ADDON]: "1".repeat(64) } }));
				const script = `const { verifyDiagnosticArtifact, activateVerifiedArtifact, loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(
					loader,
				)});
const verified = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
const activated = verified.ok ? activateVerifiedArtifact(verified) : { ok: false, reason: "not-reached" };
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify({
	verifyOk: verified.ok,
	verifyReason: verified.reason ?? null,
	activateReason: activated.reason ?? null,
	loadedReason: loaded.ok ? null : loaded.reason,
}));`;
				expect(await runProbe(script, workspace)).toEqual({
					verifyOk: false,
					verifyReason: "unsupported",
					activateReason: "not-reached",
					loadedReason: "unsupported",
				});
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it("selects exactly one layout instead of walking a candidate list", async () => {
		const code = stripComments(await Bun.file(LOADER).text());
		expect(code).toContain("selectArtifactLayout");
		// No pathname require of the addon: activation goes through the pinned descriptor.
		expect(code).not.toContain("require(candidate)");
		expect(code).toContain("process.dlopen");
		expect(code).toContain("/dev/fd/");
	});
});

describe("pre-activation namespace authority (C1)", () => {
	const ADDON = "pi_natives.darwin-arm64.node";

	async function pkgVersion(): Promise<string> {
		return ((await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string }).version;
	}

	async function fixture(workspace: string): Promise<{ native: string; loader: string; artifact: string }> {
		const root = path.join(workspace, "pkg");
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		const version = await pkgVersion();
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { [ADDON]: await fixtureSha256(ARTIFACT) },
			}),
		);
		const artifact = path.join(native, ADDON);
		await fs.copyFile(ARTIFACT, artifact);
		return { native, loader: path.join(native, "diagnostic-loader.js"), artifact };
	}

	async function probe(script: string, cwd: string): Promise<Record<string, unknown>> {
		const harness = path.join(cwd, `probe-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(harness, script);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		const stderr = new TextDecoder().decode(child.stderr ?? new Uint8Array());
		if (stdout === "") throw new Error(`probe produced no output: ${stderr.slice(0, 500)}`);
		return JSON.parse(stdout) as Record<string, unknown>;
	}

	it("admits a namespace component only for the current user or root, with no ambient write", async () => {
		const { namespaceComponentAdmitted } = (await import(LOADER)) as {
			namespaceComponentAdmitted: (
				component: { uid: number; gid: number; mode: number; isSymbolicLink: boolean; isDirectory: boolean },
				euid: number,
			) => boolean;
		};
		const base = { uid: 501, gid: 20, mode: 0o040700, isSymbolicLink: false, isDirectory: true };
		expect(namespaceComponentAdmitted(base, 501)).toBe(true);
		expect(namespaceComponentAdmitted({ ...base, uid: 0 }, 501)).toBe(true);
		// A component owned by another account can hand write authority to that account
		// regardless of the permission bits we can see.
		expect(namespaceComponentAdmitted({ ...base, uid: 502 }, 501)).toBe(false);
		expect(namespaceComponentAdmitted({ ...base, mode: 0o040770 }, 501)).toBe(false);
		expect(namespaceComponentAdmitted({ ...base, mode: 0o040707 }, 501)).toBe(false);
		expect(namespaceComponentAdmitted({ ...base, isSymbolicLink: true }, 501)).toBe(false);
		expect(namespaceComponentAdmitted({ ...base, isDirectory: false }, 501)).toBe(false);
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses to activate bytes that were modified in place after verification",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-inplace-"));
			try {
				const { loader, artifact } = await fixture(workspace);
				// The same inode is written again between verification and activation with
				// byte-identical content: the digest still matches and the addon would
				// still load, so only a metadata re-check can see that somebody wrote to
				// the file after it was verified. Activation must fail closed.
				const script = `const fs = require("node:fs");
const { verifyDiagnosticArtifact, activateVerifiedArtifact } = await import(${JSON.stringify(loader)});
const original = fs.readFileSync(${JSON.stringify(artifact)});
const identicalRewrite = () => {
	const fd = fs.openSync(${JSON.stringify(artifact)}, "r+");
	fs.writeSync(fd, original, 0, Math.min(4096, original.length), 0);
	fs.closeSync(fd);
};
const verified = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
if (!verified.ok) { console.log(JSON.stringify({ stage: "verify", reason: verified.reason })); process.exit(0); }
identicalRewrite();
const activated = activateVerifiedArtifact(verified);
const digestUnchanged =
	require("node:crypto").createHash("sha256").update(fs.readFileSync(${JSON.stringify(artifact)})).digest("hex") ===
	require("node:crypto").createHash("sha256").update(original).digest("hex");
console.log(JSON.stringify({
	stage: "activate",
	ok: activated.ok,
	reason: activated.reason ?? null,
	digestUnchanged,
}));`;
				const admissible = expectedLoadOutcome(artifact).ok;
				expect(await probe(script, workspace)).toEqual(
					admissible
						? { stage: "activate", ok: false, reason: "unsupported", digestUnchanged: true }
						: { stage: "verify", reason: "unsupported" },
				);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"still activates an untouched verified artifact (C1 control)",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-untouched-"));
			try {
				const { loader, artifact } = await fixture(workspace);
				const script = `const { verifyDiagnosticArtifact, activateVerifiedArtifact } = await import(${JSON.stringify(
					loader,
				)});
const verified = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
const activated = verified.ok ? activateVerifiedArtifact(verified) : { ok: false, reason: verified.reason };
console.log(JSON.stringify({ ok: activated.ok, exportType: activated.ok ? typeof activated.value.openDiagnosticSnapshot : null }));`;
				expect(await probe(script, workspace)).toEqual(
					expectedLoadOutcome(artifact).ok
						? { ok: true, exportType: "function" }
						: { ok: false, exportType: null },
				);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it("documents the unproven ACL authority boundary in the loader itself", async () => {
		const source = await Bun.file(LOADER).text();
		// The loader must not claim a guarantee it cannot prove from JavaScript.
		expect(source).toContain("ACL");
		expect(source).not.toContain("no other account can substitute");
	});
});

describe("verified handle lifetime (C3)", () => {
	const ADDON = "pi_natives.darwin-arm64.node";

	async function fixture(workspace: string): Promise<{ loader: string; artifact: string; other: string }> {
		const root = path.join(workspace, "pkg");
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		const version = ((await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string })
			.version;
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { [ADDON]: await fixtureSha256(ARTIFACT) },
			}),
		);
		const artifact = path.join(native, ADDON);
		await fs.copyFile(ARTIFACT, artifact);
		const other = path.join(workspace, "other.bin");
		await Bun.write(other, "not-an-addon");
		return { loader: path.join(native, "diagnostic-loader.js"), artifact, other };
	}

	async function probe(script: string, cwd: string): Promise<Record<string, unknown>> {
		const harness = path.join(cwd, `probe-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(harness, script);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		const stderr = new TextDecoder().decode(child.stderr ?? new Uint8Array());
		if (stdout === "") throw new Error(`probe produced no output: ${stderr.slice(0, 500)}`);
		return JSON.parse(stdout) as Record<string, unknown>;
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"exposes no raw descriptor and consumes the handle exactly once",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-handle-"));
			try {
				const { loader, artifact, other } = await fixture(workspace);
				const script = `const fs = require("node:fs");
const { verifyDiagnosticArtifact, activateVerifiedArtifact, closeVerifiedArtifact } = await import(${JSON.stringify(
					loader,
				)});
const out = {};

// 1. no raw fd on the opaque handle
const first = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
out.handleKeys = Object.keys(first).sort();
out.handleHasFd = "fd" in first || typeof first.fd === "number";
out.serialized = JSON.stringify(first);

// 2. close consumes it: a second close and a later activate are refused
out.firstClose = closeVerifiedArtifact(first) ?? null;
out.secondClose = closeVerifiedArtifact(first) ?? null;
// take the freed descriptor number with an unrelated file before reusing the handle
const stolen = fs.openSync(${JSON.stringify(other)}, "r");
out.activateAfterClose = activateVerifiedArtifact(first).reason ?? "ok";
out.stolenStillOpen = fs.fstatSync(stolen).size;
fs.closeSync(stolen);

// 3. activation consumes it too
const second = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
const activated = activateVerifiedArtifact(second);
out.activatedOk = activated.ok;
out.activateTwice = activateVerifiedArtifact(second).reason ?? "ok";
out.closeAfterActivate = closeVerifiedArtifact(second) ?? null;

// 4. a fabricated handle is not authority
out.fabricated = activateVerifiedArtifact({ ok: true, fd: 3, file: ${JSON.stringify(artifact)} }).reason ?? "ok";
out.fabricatedClose = closeVerifiedArtifact({ ok: true, fd: 3, file: ${JSON.stringify(artifact)} }) ?? null;

// 5. a mutated handle is not authority
const third = verifyDiagnosticArtifact(${JSON.stringify(artifact)});
third.token = "forged";
out.mutated = activateVerifiedArtifact(third).reason ?? "ok";
closeVerifiedArtifact(third);
console.log(JSON.stringify(out));`;
				const admissible = expectedLoadOutcome(artifact).ok;
				// Handle lifetime is asserted either way: when the artifact's namespace is not
				// admissible, verification never hands out a token, so every consumer call is
				// refused -- which is exactly the authority property under test.
				expect(await probe(script, workspace)).toEqual({
					handleKeys: admissible ? ["ok", "token"] : ["ok", "reason"],
					handleHasFd: false,
					serialized: expect.stringContaining(admissible ? '"ok":true' : '"ok":false'),
					firstClose: null,
					secondClose: null,
					activateAfterClose: "unsupported",
					stolenStillOpen: "not-an-addon".length,
					activatedOk: admissible,
					activateTwice: "unsupported",
					closeAfterActivate: null,
					fabricated: "unsupported",
					fabricatedClose: null,
					mutated: "unsupported",
				});
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		240_000,
	);

	it("keeps the descriptor out of the declared handle type", async () => {
		const types = await Bun.file(`${LOADER.replace(/\.js$/, "")}.d.ts`).text();
		expect(types).toContain("VerifiedDiagnosticArtifact");
		expect(types).not.toContain("fd: number");
	});
});

describe("ACL authority admission (C1 closure)", () => {
	const ADDON = "pi_natives.darwin-arm64.node";

	/** Independent ACL observation for the test's own expectations. */
	function pathHasAcl(target: string): boolean {
		const listed = Bun.spawnSync({ cmd: ["/bin/ls", "-lde", target], stdout: "pipe", stderr: "pipe" });
		const text = new TextDecoder().decode(listed.stdout ?? new Uint8Array());
		return /^\s*\d+:\s/m.test(text);
	}

	/** Every component from the artifact up to the root. */
	function chainOf(artifact: string): string[] {
		const components: string[] = [];
		let current = artifact;
		for (;;) {
			components.push(current);
			const parent = path.dirname(current);
			if (parent === current) return components;
			current = parent;
		}
	}

	function chainHasAcl(artifact: string): boolean {
		return chainOf(artifact).some(component => pathHasAcl(component));
	}

	async function fixture(workspace: string): Promise<{ loader: string; artifact: string; native: string }> {
		const root = path.join(workspace, "pkg");
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		const version = ((await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string })
			.version;
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { [ADDON]: await fixtureSha256(ARTIFACT) },
			}),
		);
		const artifact = path.join(native, ADDON);
		await fs.copyFile(ARTIFACT, artifact);
		return { loader: path.join(native, "diagnostic-loader.js"), artifact, native };
	}

	async function load(loader: string, cwd: string): Promise<{ ok: boolean; reason?: string }> {
		const harness = path.join(cwd, `load-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(
			harness,
			`const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(loader)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`,
		);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		if (stdout === "") {
			throw new Error(
				`loader produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 400)}`,
			);
		}
		return JSON.parse(stdout) as { ok: boolean; reason?: string };
	}

	it.skipIf(process.platform !== "darwin")(
		"reaches the read-only ACL API through the system library, with no addon and no helper",
		async () => {
			const { inspectAclOnDescriptor } = (await import(LOADER)) as {
				inspectAclOnDescriptor: (fd: number) => "absent" | "present" | "unproven";
			};
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-api-"));
			try {
				const clean = path.join(workspace, "clean.bin");
				const guarded = path.join(workspace, "guarded.bin");
				await Bun.write(clean, "clean");
				await Bun.write(guarded, "guarded");
				await fs.chmod(clean, 0o600);
				await fs.chmod(guarded, 0o600);
				const applied = Bun.spawnSync({ cmd: ["/bin/chmod", "+a", "everyone allow write", guarded] });
				expect(applied.exitCode).toBe(0);
				expect(pathHasAcl(guarded)).toBe(true);
				expect(pathHasAcl(clean)).toBe(false);

				const nodeFs = await import("node:fs");
				const cleanFd = nodeFs.openSync(clean, nodeFs.constants.O_RDONLY);
				const guardedFd = nodeFs.openSync(guarded, nodeFs.constants.O_RDONLY);
				try {
					expect(inspectAclOnDescriptor(cleanFd)).toBe("absent");
					expect(inspectAclOnDescriptor(guardedFd)).toBe("present");
				} finally {
					nodeFs.closeSync(cleanFd);
					nodeFs.closeSync(guardedFd);
				}
				// A closed descriptor can never be classified as "no ACL".
				const closed = nodeFs.openSync(clean, nodeFs.constants.O_RDONLY);
				nodeFs.closeSync(closed);
				expect(inspectAclOnDescriptor(closed)).toBe("unproven");
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(process.platform === "darwin")(
		"never binds an ACL primitive off Darwin and reports unproven there",
		async () => {
			const { inspectAclOnDescriptor } = (await import(LOADER)) as {
				inspectAclOnDescriptor: (descriptor: number) => "absent" | "present" | "unproven";
			};
			const nodeFs = await import("node:fs");
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-nondarwin-"));
			try {
				const file = path.join(workspace, "plain.bin");
				await Bun.write(file, "plain");
				const fd = nodeFs.openSync(file, nodeFs.constants.O_RDONLY);
				try {
					// There is no macOS ACL API here, so the loader must report unproven and
					// never claim absence.
					expect(inspectAclOnDescriptor(fd)).toBe("unproven");
				} finally {
					nodeFs.closeSync(fd);
				}
				const code = stripComments(await Bun.file(LOADER).text());
				expect(code).toContain('process.platform !== "darwin"');
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"classifies each call on its own errno, not on the previous call's",
		async () => {
			const { inspectAclOnDescriptor } = (await import(LOADER)) as {
				inspectAclOnDescriptor: (descriptor: number) => "absent" | "present" | "unproven";
			};
			const nodeFs = await import("node:fs");
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-errno-"));
			try {
				const clean = path.join(workspace, "clean.bin");
				await Bun.write(clean, "clean");
				await fs.chmod(clean, 0o600);

				// A failing call first. A descriptor number that was merely closed can be
				// recycled by an unrelated open, so use one that is never valid here.
				const invalid = 9999;
				expect(inspectAclOnDescriptor(invalid)).toBe("unproven");

				// The next call must be classified on its own result, so the earlier failure
				// cannot turn into a stale "absent" and a genuine no-ACL file is still absent.
				const live = nodeFs.openSync(clean, nodeFs.constants.O_RDONLY);
				try {
					expect(inspectAclOnDescriptor(live)).toBe("absent");
					// And the reverse order keeps the failure a failure.
					expect(inspectAclOnDescriptor(invalid)).toBe("unproven");
					expect(inspectAclOnDescriptor(live)).toBe("absent");
				} finally {
					nodeFs.closeSync(live);
				}
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it("classifies every ACL probe outcome the same way on every platform", async () => {
		const { classifyAclProbe } = (await import(LOADER)) as {
			classifyAclProbe: (probe: {
				handle: number;
				errno: number | null;
				firstEntry: number | null;
			}) => "absent" | "present" | "unproven";
		};
		// A null handle means absence only with the platform's "no such ACL" errno.
		expect(classifyAclProbe({ handle: 0, errno: 2, firstEntry: null })).toBe("absent");
		for (const errno of [0, 1, 5, 9, 12, 13, 22, 45, null]) {
			expect(classifyAclProbe({ handle: 0, errno, firstEntry: null })).toBe("unproven");
		}
		// A handle whose first entry exists carries an ACE.
		expect(classifyAclProbe({ handle: 4096, errno: null, firstEntry: 0 })).toBe("present");
		// -1 is end-of-iteration OR a failure, including an invalid ACL, so on its own it
		// proves nothing: fail closed instead of reading it as "empty".
		expect(classifyAclProbe({ handle: 4096, errno: 22, firstEntry: -1 })).toBe("unproven");
		expect(classifyAclProbe({ handle: 4096, errno: 2, firstEntry: -1 })).toBe("unproven");
		expect(classifyAclProbe({ handle: 4096, errno: null, firstEntry: -1 })).toBe("unproven");
		expect(classifyAclProbe({ handle: 4096, errno: null, firstEntry: -2 })).toBe("unproven");
		expect(classifyAclProbe({ handle: 4096, errno: null, firstEntry: null })).toBe("unproven");
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses an artifact whose ACL grants write to another account",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-grant-"));
			try {
				const { loader, artifact } = await fixture(workspace);
				// Contract-aware baseline: a trusted ancestor above the anchor may carry the
				// approved single everyone DENY DELETE ACE, so "any ACL in the chain" is not
				// the rule any more.
				const baseline = expectedLoadOutcome(artifact);
				expect(await load(loader, workspace)).toEqual(baseline);

				// Task-owned leaf only: an ACE that grants write to everyone.
				const applied = Bun.spawnSync({ cmd: ["/bin/chmod", "+a", "everyone allow write", artifact] });
				expect(applied.exitCode).toBe(0);
				expect(pathHasAcl(artifact)).toBe(true);
				expect(await load(loader, workspace)).toEqual({ ok: false, reason: "unsupported" });

				// Restored fixture returns to the environment-led baseline.
				const removed = Bun.spawnSync({ cmd: ["/bin/chmod", "-N", artifact] });
				expect(removed.exitCode).toBe(0);
				expect(pathHasAcl(artifact)).toBe(false);
				expect(await load(loader, workspace)).toEqual(baseline);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		240_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses an artifact whose directory ACL grants write",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-dir-"));
			try {
				const { loader, artifact, native } = await fixture(workspace);
				// Contract-aware baseline: a trusted ancestor above the anchor may carry the
				// approved single everyone DENY DELETE ACE, so "any ACL in the chain" is not
				// the rule any more.
				const baseline = expectedLoadOutcome(artifact);
				const applied = Bun.spawnSync({ cmd: ["/bin/chmod", "+a", "everyone allow write", native] });
				expect(applied.exitCode).toBe(0);
				expect(await load(loader, workspace)).toEqual({ ok: false, reason: "unsupported" });
				const removed = Bun.spawnSync({ cmd: ["/bin/chmod", "-N", native] });
				expect(removed.exitCode).toBe(0);
				expect(await load(loader, workspace)).toEqual(baseline);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		240_000,
	);
});

describe("ACL bootstrap trust (C1-L)", () => {
	const SHADOW_SOURCE = `#include <stdio.h>
#include <stdlib.h>
__attribute__((constructor)) static void marker(void) {
	const char *out = getenv("GJC_SHADOW_MARKER");
	if (!out) return;
	FILE *f = fopen(out, "w");
	if (f) { fputs("shadow-initializer-ran", f); fclose(f); }
}
void *acl_get_fd_np(int fd, int type) { (void)fd; (void)type; return NULL; }
int acl_get_entry(void *a, int b, void *c) { (void)a; (void)b; (void)c; return 0; }
int acl_free(void *a) { (void)a; return 0; }
int *__error(void) { static int e = 0; return &e; }
`;

	it("binds the ACL primitive from an absolute system library path", async () => {
		const code = stripComments(await Bun.file(LOADER).text());
		expect(code).toContain('"/usr/lib/libSystem.B.dylib"');
		expect(code).not.toContain('dlopen("libSystem.B.dylib"');
	});

	it.skipIf(process.platform !== "darwin")(
		"keeps the same bootstrap guarantees inside an actual compiled binary",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-shadow-compiled-"));
			try {
				await Bun.write(path.join(workspace, "shadow.c"), SHADOW_SOURCE);
				const built = Bun.spawnSync({
					cmd: ["/usr/bin/cc", "-dynamiclib", "-o", path.join(workspace, "libSystem.B.dylib"), "shadow.c"],
					cwd: workspace,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(built.exitCode).toBe(0);

				const probeFile = path.join(workspace, "probe.bin");
				await Bun.write(probeFile, "probe");
				await fs.chmod(probeFile, 0o600);
				const entry = path.join(workspace, "compiled-probe.ts");
				await Bun.write(
					entry,
					`import * as nodeFs from "node:fs";
import { inspectAclOnDescriptor } from ${JSON.stringify(LOADER)};
const fd = nodeFs.openSync(${JSON.stringify(probeFile)}, nodeFs.constants.O_RDONLY);
const classification = inspectAclOnDescriptor(fd);
nodeFs.closeSync(fd);
console.log(JSON.stringify({
	classification,
	markerRan: nodeFs.existsSync(process.env.GJC_SHADOW_MARKER ?? ""),
	compiled: import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN"),
}));`,
				);
				// Build outside the shadow directory: only the compiled binary's own run is
				// supposed to face the shadow library.
				const buildDir = path.join(workspace, "build");
				const buildTmp = path.join(workspace, "build-tmp");
				await fs.mkdir(buildDir, { recursive: true });
				await fs.mkdir(buildTmp, { recursive: true });
				const binary = path.join(buildDir, "compiled-probe");
				const compiled = Bun.spawnSync({
					cmd: [process.execPath, "build", "--compile", "--outfile", binary, entry],
					cwd: buildDir,
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: buildDir, TMPDIR: buildTmp },
					stdout: "pipe",
					stderr: "pipe",
				});
				expect({
					exitCode: compiled.exitCode,
					stderr: new TextDecoder().decode(compiled.stderr ?? new Uint8Array()).slice(0, 300),
				}).toEqual({ exitCode: 0, stderr: "" });

				const runCompiled = (extra: Record<string, string>) => {
					const markerPath = path.join(workspace, `marker-${Math.random().toString(36).slice(2)}.txt`);
					const child = Bun.spawnSync({
						cmd: [binary],
						// cwd holds the shadow `libSystem.B.dylib`.
						cwd: workspace,
						env: {
							PATH: "/usr/bin:/bin",
							HOME: workspace,
							TMPDIR: workspace,
							GJC_SHADOW_MARKER: markerPath,
							...extra,
						},
						stdout: "pipe",
						stderr: "pipe",
					});
					const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
					if (stdout === "") {
						throw new Error(
							`compiled probe produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 300)}`,
						);
					}
					return JSON.parse(stdout) as { classification: string; markerRan: boolean; compiled: boolean };
				};

				// Trusted primitive positive inside the compiled tuple, with the shadow
				// library sitting in the working directory: its initializer must not run.
				const shadowed = runCompiled({});
				expect(shadowed).toEqual({ classification: "absent", markerRan: false, compiled: true });

				// Search-path override inside the compiled tuple: refused before dlopen.
				for (const override of ["DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"]) {
					const guarded = runCompiled({ [override]: workspace });
					expect({ override, classification: guarded.classification, markerRan: guarded.markerRan }).toEqual({
						override,
						classification: "unproven",
						markerRan: false,
					});
				}
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		300_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"never initializes a task-owned shadow library and refuses a dyld-override environment before dlopen",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-shadow-"));
			try {
				await Bun.write(path.join(workspace, "shadow.c"), SHADOW_SOURCE);
				const built = Bun.spawnSync({
					cmd: ["/usr/bin/cc", "-dynamiclib", "-o", path.join(workspace, "libSystem.B.dylib"), "shadow.c"],
					cwd: workspace,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(built.exitCode).toBe(0);

				const probeFile = path.join(workspace, "probe.bin");
				await Bun.write(probeFile, "probe");
				await fs.chmod(probeFile, 0o600);
				const harness = path.join(workspace, "probe.ts");
				await Bun.write(
					harness,
					`const nodeFs = require("node:fs");
const { inspectAclOnDescriptor } = await import(${JSON.stringify(LOADER)});
const fd = nodeFs.openSync(${JSON.stringify(probeFile)}, nodeFs.constants.O_RDONLY);
const classification = inspectAclOnDescriptor(fd);
nodeFs.closeSync(fd);
console.log(JSON.stringify({
	classification,
	markerRan: nodeFs.existsSync(process.env.GJC_SHADOW_MARKER),
}));`,
				);

				const run = (cwd: string, extra: Record<string, string>) => {
					const markerPath = path.join(cwd, `marker-${Math.random().toString(36).slice(2)}.txt`);
					const child = Bun.spawnSync({
						cmd: [process.execPath, harness],
						cwd,
						env: {
							PATH: "/usr/bin:/bin",
							HOME: cwd,
							TMPDIR: cwd,
							GJC_SHADOW_MARKER: markerPath,
							...extra,
						},
						stdout: "pipe",
						stderr: "pipe",
					});
					const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
					if (stdout === "") {
						throw new Error(
							`probe produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 300)}`,
						);
					}
					return JSON.parse(stdout) as { classification: string; markerRan: boolean };
				};

				// The working directory holds a shadow `libSystem.B.dylib` whose initializer
				// writes a marker; a basename bootstrap loads and runs it. The absolute
				// system path must not, and classification must stay correct.
				expect(run(workspace, {})).toEqual({ classification: "absent", markerRan: false });

				// Search-path overrides: the absolute bootstrap is immune to them AND the
				// loader refuses before calling dlopen, so the initializer never runs.
				for (const override of ["DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"]) {
					expect({ override, ...run(workspace, { [override]: workspace }) }).toEqual({
						override,
						markerRan: false,
						classification: "unproven",
					});
				}

				// An insert override is applied by the dynamic loader at process start, before
				// any of this code exists: the initializer runs no matter what the loader does.
				// That is exactly why such an environment is refused rather than "prevented" --
				// the classification is unproven and no ACL claim is made.
				const inserted = run(workspace, {
					DYLD_INSERT_LIBRARIES: path.join(workspace, "libSystem.B.dylib"),
				});
				expect(inserted.classification).toBe("unproven");
				expect(inserted.markerRan).toBe(true);

				// Trusted positive: no shadow in the working directory, no override.
				const clean = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-shadow-clean-"));
				try {
					expect(run(clean, {})).toEqual({ classification: "absent", markerRan: false });
				} finally {
					await fs.rm(clean, { recursive: true, force: true });
				}
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		300_000,
	);
});

describe("artifact namespace anchor policy and real activation (ACL contract)", () => {
	const ADDON = "pi_natives.darwin-arm64.node";

	async function pkgVersion(): Promise<string> {
		return ((await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string }).version;
	}

	function installAcl(target: string, spec: string): void {
		const applied = Bun.spawnSync({ cmd: ["/bin/chmod", "+a", spec, target], stdout: "pipe", stderr: "pipe" });
		if (applied.exitCode !== 0) throw new Error(`fixture ACL ${spec} failed for ${target}`);
	}

	function clearAcl(target: string): void {
		Bun.spawnSync({ cmd: ["/bin/chmod", "-N", target], stdout: "pipe", stderr: "pipe" });
	}

	/**
	 * A disposable natives package inside the task fixture:
	 * `<temp>/above/pkg/native/<addon>`. `above` is the only place ACL fixtures are
	 * installed, so the approved above-anchor exception is exercised without touching a
	 * single existing path.
	 */
	async function fixture(workspace: string): Promise<{
		above: string;
		anchor: string;
		artifact: string;
		loader: string;
	}> {
		const above = path.join(workspace, "above");
		const root = path.join(above, "pkg");
		const anchor = path.join(root, "native");
		await fs.mkdir(anchor, { recursive: true });
		await fs.chmod(above, 0o755);
		const version = await pkgVersion();
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
		await Bun.write(path.join(anchor, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(anchor, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { [ADDON]: await fixtureSha256(ARTIFACT) },
			}),
		);
		const artifact = path.join(anchor, ADDON);
		await fs.copyFile(ARTIFACT, artifact);
		return { above, anchor, artifact, loader: path.join(anchor, "diagnostic-loader.js") };
	}

	async function probe(script: string, cwd: string): Promise<Record<string, unknown>> {
		const harness = path.join(cwd, `probe-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(harness, script);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd,
			env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		if (stdout === "") {
			throw new Error(
				`probe produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 400)}`,
			);
		}
		return JSON.parse(stdout) as Record<string, unknown>;
	}

	/** An agent publication fixture whose only ACL-bearing ancestor is `above`. */
	async function publication(workspace: string, bytes: string): Promise<{ above: string; agent: string }> {
		const above = path.join(workspace, "agent-above");
		const agent = path.join(above, "agent");
		const sdk = path.join(agent, "sdk");
		await fs.mkdir(sdk, { recursive: true });
		await fs.chmod(above, 0o755);
		await fs.chmod(agent, 0o700);
		await fs.chmod(sdk, 0o700);
		const leaf = path.join(sdk, "broker.json");
		await Bun.write(leaf, bytes);
		await fs.chmod(leaf, 0o600);
		return { above, agent };
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"activates the real addon with the approved ancestor exception above the anchor",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-activate-"));
			try {
				const { above, loader, artifact } = await fixture(workspace);
				installAcl(above, "everyone deny delete");
				const script = `const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(loader)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify({
	ok: loaded.ok,
	reason: loaded.reason ?? null,
	exportType: loaded.ok ? typeof loaded.value.openDiagnosticSnapshot : null,
}));`;
				expect(await probe(script, workspace)).toEqual({ ok: true, reason: null, exportType: "function" });
				// The anchor and the artifact themselves must stay strict.
				expect(aclEntriesOf(artifact)).toEqual([]);
			} finally {
				clearAcl(path.join(workspace, "above"));
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		240_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"drives a real lease through the loader API and refuses after a fixture mutation",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-lease-"));
			try {
				const { above, loader } = await fixture(workspace);
				installAcl(above, "everyone deny delete");
				const published = await publication(workspace, '{"generation":"loader-lease"}');
				installAcl(published.above, "everyone deny delete");
				const script = `const nodeFs = require("node:fs");
const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(loader)});
const loaded = loadDiagnosticNativeReadOnly();
if (!loaded.ok) { console.log(JSON.stringify({ stage: "load", reason: loaded.reason })); process.exit(0); }
const lease = loaded.value.openDiagnosticSnapshot(${JSON.stringify(published.agent)}, 2000);
const first = lease.read();
const revalidated = lease.revalidate();
// Deterministic barrier: the task fixture's own agent mode changes between reads.
nodeFs.chmodSync(${JSON.stringify(published.agent)}, 0o755);
const afterMutation = lease.read();
const revalidateAfter = lease.revalidate();
lease.close();
lease.close();
const afterClose = lease.read();
console.log(JSON.stringify({
	stage: "lease",
	leaseOk: lease.ok,
	firstOk: first.ok,
	firstBytes: first.ok ? new TextDecoder().decode(first.bytes) : null,
	revalidated: revalidated.ok,
	mutatedOk: afterMutation.ok,
	// N-API omits an absent optional field, so "no bytes released" is null or undefined.
	mutatedBytes: afterMutation.bytes === null || afterMutation.bytes === undefined,
	mutatedReason: afterMutation.reason,
	revalidateAfter: revalidateAfter.ok,
	afterCloseOk: afterClose.ok,
}));`;
				expect(await probe(script, workspace)).toEqual({
					stage: "lease",
					leaseOk: true,
					firstOk: true,
					firstBytes: '{"generation":"loader-lease"}',
					revalidated: true,
					mutatedOk: false,
					mutatedBytes: true,
					mutatedReason: "unsafe_discovery",
					revalidateAfter: false,
					afterCloseOk: false,
				});
			} finally {
				clearAcl(path.join(workspace, "above"));
				clearAcl(path.join(workspace, "agent-above"));
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"keeps the artifact namespace anchor and leaf strict",
		async () => {
			for (const target of ["anchor", "artifact"] as const) {
				const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `gjc-acl-anchor-${target}-`));
				try {
					const fixtures = await fixture(workspace);
					installAcl(fixtures.above, "everyone deny delete");
					installAcl(target === "anchor" ? fixtures.anchor : fixtures.artifact, "everyone deny delete");
					const script = `const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(fixtures.loader)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`;
					const observed: Record<string, unknown> = { target, ...(await probe(script, workspace)) };
					expect(observed).toEqual({ target, ok: false, reason: "unsupported" });
				} finally {
					// Every disposable ACE installed by this case is released before removal:
					// a deny-delete ACE would otherwise block the fixture cleanup.
					for (const target of [
						path.join(workspace, "above"),
						path.join(workspace, "above", "pkg", "native"),
						path.join(workspace, "above", "pkg", "native", ADDON),
					]) {
						clearAcl(target);
					}
					await fs.rm(workspace, { recursive: true, force: true });
				}
			}
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"refuses every non-allowlisted ancestor ACL above the anchor",
		async () => {
			const cases: [string, string[]][] = [
				["allow", ["everyone allow read"]],
				["mixed", ["everyone deny delete", "everyone allow read"]],
				["inherited", ["everyone deny delete,file_inherit"]],
				["extra-rights", ["everyone deny delete,write"]],
				["wrong-principal", ["staff deny delete"]],
				["multiple-deny", ["everyone deny delete", "staff deny delete"]],
			];
			for (const [label, specs] of cases) {
				const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-neg-"));
				try {
					const fixtures = await fixture(workspace);
					for (const spec of specs) installAcl(fixtures.above, spec);
					const script = `const { loadDiagnosticNativeReadOnly } = await import(${JSON.stringify(fixtures.loader)});
const loaded = loadDiagnosticNativeReadOnly();
console.log(JSON.stringify(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }));`;
					const observed: Record<string, unknown> = { label, ...(await probe(script, workspace)) };
					expect(observed).toEqual({ label, ok: false, reason: "unsupported" });
				} finally {
					clearAcl(path.join(workspace, "above"));
					await fs.rm(workspace, { recursive: true, force: true });
				}
			}
		},
		300_000,
	);
});

describe("ACL classifier completeness (ACL-FULL-MASK, ACL-COUNT-ERROR)", () => {
	/**
	 * Fixture helper: writes an extended ACL with chosen header flags, entry flags and
	 * rights through the platform's own ACL API. Test-side setup only, always inside a
	 * disposable task directory; production never sets an ACL.
	 */
	const CRAFT_SOURCE = `#include <errno.h>
#include <sys/acl.h>
#include <sys/kauth.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
	if (argc < 5) { printf("usage: craft <path> <headerFlags> <aceFlags> <aceRights>\\n"); return 2; }
	size_t size = KAUTH_FILESEC_SIZE(1);
	struct kauth_filesec *fs = calloc(1, size);
	fs->fsec_magic = KAUTH_FILESEC_MAGIC;
	fs->fsec_acl.acl_entrycount = 1;
	fs->fsec_acl.acl_flags = (u_int32_t)strtoul(argv[2], NULL, 0);
	struct kauth_ace *ace = &fs->fsec_acl.acl_ace[0];
	static const unsigned char everyone[16] = {0xab,0xcd,0xef,0xab,0xcd,0xef,0xab,0xcd,0xef,0xab,0xcd,0xef,0x00,0x00,0x00,0x0c};
	memcpy(&ace->ace_applicable, everyone, 16);
	ace->ace_flags = (u_int32_t)strtoul(argv[3], NULL, 0);
	ace->ace_rights = (u_int32_t)strtoul(argv[4], NULL, 0);
	acl_t acl = acl_copy_int_native(fs);
	free(fs);
	if (!acl) { printf("copy_int failed errno=%d\\n", errno); return 1; }
	int rc = acl_set_file(argv[1], ACL_TYPE_EXTENDED, acl);
	int saved = errno;
	acl_free(acl);
	if (rc != 0) { printf("set_file rc=%d errno=%d\\n", rc, saved); return 1; }
	return 0;
}
`;

	const KAUTH_ACE_DENY = 2;
	const KAUTH_VNODE_DELETE = 1 << 4;
	const KAUTH_ACL_NO_INHERIT = 1 << 17;
	const UNKNOWN_HIGH_FLAG = 1 << 28;
	const UNKNOWN_HIGH_RIGHT = 1 << 30;

	async function craftTool(workspace: string): Promise<string> {
		const source = path.join(workspace, "craft.c");
		const binary = path.join(workspace, "craft");
		await Bun.write(source, CRAFT_SOURCE);
		const built = Bun.spawnSync({
			cmd: ["/usr/bin/cc", "-o", binary, source],
			cwd: workspace,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (built.exitCode !== 0) {
			throw new Error(`craft helper build failed: ${new TextDecoder().decode(built.stderr ?? new Uint8Array())}`);
		}
		return binary;
	}

	function craft(tool: string, target: string, headerFlags: number, aceFlags: number, aceRights: number): void {
		const applied = Bun.spawnSync({
			cmd: [
				tool,
				target,
				`0x${headerFlags.toString(16)}`,
				`0x${aceFlags.toString(16)}`,
				`0x${aceRights.toString(16)}`,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (applied.exitCode !== 0) {
			throw new Error(`craft failed for ${target}: ${new TextDecoder().decode(applied.stdout ?? new Uint8Array())}`);
		}
	}

	function clearAcl(target: string): void {
		Bun.spawnSync({ cmd: ["/bin/chmod", "-N", target], stdout: "pipe", stderr: "pipe" });
	}

	async function classify(directory: string, workspace: string): Promise<string> {
		const harness = path.join(workspace, `classify-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(
			harness,
			`const nodeFs = require("node:fs");
const { inspectAncestorAclOnDescriptor } = await import(${JSON.stringify(LOADER)});
const fd = nodeFs.openSync(${JSON.stringify(directory)}, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
try {
	console.log(JSON.stringify({ decision: inspectAncestorAclOnDescriptor(fd) }));
} finally {
	nodeFs.closeSync(fd);
}`,
		);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		if (stdout === "") {
			throw new Error(
				`classify produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 400)}`,
			);
		}
		return (JSON.parse(stdout) as { decision: string }).decision;
	}

	it.skipIf(process.platform !== "darwin")(
		"refuses an ACL whose completeness is outside the exact approved mask",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-mask-"));
			const targets: string[] = [];
			try {
				const tool = await craftTool(workspace);
				const cases: [string, number, number, number, string][] = [
					// The exact approved shape stays admitted.
					["approved", 0, KAUTH_ACE_DENY, KAUTH_VNODE_DELETE, "approved-single-deny-delete"],
					// ACL header flags are part of the contract and were never inspected.
					["header-no-inherit", KAUTH_ACL_NO_INHERIT, KAUTH_ACE_DENY, KAUTH_VNODE_DELETE, "not-allowlisted"],
					// An entry flag outside the enumerated set.
					["unknown-entry-flag", 0, KAUTH_ACE_DENY | UNKNOWN_HIGH_FLAG, KAUTH_VNODE_DELETE, "not-allowlisted"],
					// A right outside the enumerated set.
					["unknown-right", 0, KAUTH_ACE_DENY, KAUTH_VNODE_DELETE | UNKNOWN_HIGH_RIGHT, "not-allowlisted"],
				];
				for (const [label, headerFlags, aceFlags, aceRights, expected] of cases) {
					const directory = path.join(workspace, `case-${label}`);
					await fs.mkdir(directory, { recursive: true, mode: 0o755 });
					targets.push(directory);
					craft(tool, directory, headerFlags, aceFlags, aceRights);
					expect({ label, decision: await classify(directory, workspace) }).toEqual({ label, decision: expected });
				}
			} finally {
				for (const target of targets) clearAcl(target);
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		300_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"never treats an iteration failure as proof of a single entry",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-count-"));
			const targets: string[] = [];
			try {
				// The patched copy lives in a fixture package so its sibling imports resolve.
				const fixtureNative = path.join(workspace, "pkg", "native");
				await fs.mkdir(fixtureNative, { recursive: true });
				const manifest = (await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as {
					version: string;
				};
				await Bun.write(
					path.join(workspace, "pkg", "package.json"),
					JSON.stringify({ name: "@gajae-code/natives", version: manifest.version }),
				);
				await Bun.write(
					path.join(fixtureNative, "diagnostic-artifact.json"),
					JSON.stringify({
						schema: "gjc.diagnostic-artifact",
						version: manifest.version,
						artifacts: { "pi_natives.darwin-arm64.node": await fixtureSha256(ARTIFACT) },
					}),
				);
				const tool = await craftTool(workspace);
				const directory = path.join(workspace, "approved");
				await fs.mkdir(directory, { recursive: true, mode: 0o755 });
				targets.push(directory);
				craft(tool, directory, 0, KAUTH_ACE_DENY, KAUTH_VNODE_DELETE);

				// Call-boundary injection over the exact product source: the iteration step
				// reports a failure with a real errno, which must never be read as
				// "there is no second entry".
				const harness = path.join(workspace, "count.ts");
				await Bun.write(
					harness,
					`const nodeFs = require("node:fs");
const source = await Bun.file(${JSON.stringify(LOADER)}).text();
const rows = [];
for (const fault of [{ label: "eio", result: -1, errno: 5 }, { label: "ebadf", result: -1, errno: 9 }, { label: "unknown", result: -1, errno: 1234 }, { label: "unexpected-return", result: 7, errno: 0 }]) {
	const patched = source.replace(
		"const next = symbols.aclGetEntry(acl, ACL_NEXT_ENTRY, nextOut);",
		"const next = (globalThis.__GJC_FAULT__.result); globalThis.__GJC_FAULT__.injected = true;",
	);
	if (patched === source) { rows.push({ fault: fault.label, decision: "patch-anchor-missing" }); continue; }
	const patchedWithErrno = patched.replace(
		"errno: () => {",
		"errno: () => { if (globalThis.__GJC_FAULT__.injected) return globalThis.__GJC_FAULT__.errno;",
	);
	const modulePath = ${JSON.stringify(path.join("WORKSPACE", "pkg", "native", "patched-"))} + fault.label + ".js";
	nodeFs.writeFileSync(modulePath, patchedWithErrno);
	globalThis.__GJC_FAULT__ = { result: fault.result, errno: fault.errno, injected: false };
	const { inspectAncestorAclOnDescriptor } = await import(modulePath);
	const fd = nodeFs.openSync(${JSON.stringify(directory)}, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
	try {
		rows.push({ fault: fault.label, decision: inspectAncestorAclOnDescriptor(fd) });
	} finally {
		nodeFs.closeSync(fd);
	}
}
console.log(JSON.stringify(rows));`,
				);
				const written = (await Bun.file(harness).text()).replaceAll("WORKSPACE", workspace);
				await Bun.write(harness, written);
				const child = Bun.spawnSync({
					cmd: [process.execPath, harness],
					cwd: workspace,
					env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
				if (stdout === "") {
					throw new Error(
						`count probe produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 400)}`,
					);
				}
				const rows = JSON.parse(stdout) as { fault: string; decision: string }[];
				// Every injected iteration failure must close as unproven, never as the
				// approved single-entry shape.
				expect(rows).toEqual([
					{ fault: "eio", decision: "unproven" },
					{ fault: "ebadf", decision: "unproven" },
					{ fault: "unknown", decision: "unproven" },
					{ fault: "unexpected-return", decision: "unproven" },
				]);
			} finally {
				for (const target of targets) clearAcl(target);
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		300_000,
	);

	it("classifies a validated representation, its cardinality and its full masks purely", async () => {
		const loaded = (await import(LOADER)) as {
			parseAclRepresentation?: (bytes: Uint8Array) => unknown;
			classifyAclRepresentation?: (parsed: unknown) => string;
		};
		// Pure layer: exercised with crafted byte buffers so the completeness rules can be
		// stated without the platform in the loop.
		expect(typeof loaded.parseAclRepresentation).toBe("function");
		expect(typeof loaded.classifyAclRepresentation).toBe("function");
		const parse = loaded.parseAclRepresentation as (bytes: Uint8Array) => { ok: boolean };
		const classify = loaded.classifyAclRepresentation as (parsed: unknown) => string;

		const build = (options: {
			magic?: number;
			count?: number;
			headerFlags?: number;
			aceFlags?: number;
			aceRights?: number;
			guid?: number[];
			entries?: number;
			trailing?: number;
		}): Uint8Array => {
			const entries = options.entries ?? 1;
			const bytes = new Uint8Array(44 + 24 * entries + (options.trailing ?? 0));
			const view = new DataView(bytes.buffer);
			view.setUint32(0, options.magic ?? 0x012cc16d, true);
			view.setUint32(36, options.count ?? entries, true);
			view.setUint32(40, options.headerFlags ?? 0, true);
			for (let index = 0; index < entries; index += 1) {
				const base = 44 + index * 24;
				const guid = options.guid ?? [
					0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x0c,
				];
				bytes.set(guid, base);
				view.setUint32(base + 16, options.aceFlags ?? 2, true);
				view.setUint32(base + 20, options.aceRights ?? 16, true);
			}
			return bytes;
		};

		expect(classify(parse(build({})))).toBe("approved-single-deny-delete");
		expect(classify(parse(build({ count: 0, entries: 0 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ entries: 2 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ entries: 5 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ headerFlags: 1 << 17 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ aceFlags: 2 | (1 << 28) })))).toBe("not-allowlisted");
		expect(classify(parse(build({ aceFlags: 1 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ aceRights: 16 | (1 << 30) })))).toBe("not-allowlisted");
		expect(classify(parse(build({ aceRights: 0 })))).toBe("not-allowlisted");
		expect(classify(parse(build({ guid: new Array(16).fill(1) })))).toBe("not-allowlisted");
		// Malformed representations never classify as anything but unproven.
		expect(classify(parse(build({ magic: 0xdeadbeef })))).toBe("unproven");
		expect(classify(parse(build({ trailing: 3 })))).toBe("unproven");
		expect(classify(parse(build({ count: 7 })))).toBe("unproven");
		expect(classify(parse(new Uint8Array(10)))).toBe("unproven");
		expect(classify(parse(new Uint8Array(0)))).toBe("unproven");
	});
});

describe("ACL regression matrix on the production seams (ACL-REGRESSION-MATRIX)", () => {
	const CRAFT_SOURCE = `#include <errno.h>
#include <sys/acl.h>
#include <sys/kauth.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
	if (argc < 5) { return 2; }
	size_t size = KAUTH_FILESEC_SIZE(1);
	struct kauth_filesec *fs = calloc(1, size);
	fs->fsec_magic = KAUTH_FILESEC_MAGIC;
	fs->fsec_acl.acl_entrycount = 1;
	fs->fsec_acl.acl_flags = (u_int32_t)strtoul(argv[2], NULL, 0);
	struct kauth_ace *ace = &fs->fsec_acl.acl_ace[0];
	static const unsigned char everyone[16] = {0xab,0xcd,0xef,0xab,0xcd,0xef,0xab,0xcd,0xef,0xab,0xcd,0xef,0x00,0x00,0x00,0x0c};
	memcpy(&ace->ace_applicable, everyone, 16);
	ace->ace_flags = (u_int32_t)strtoul(argv[3], NULL, 0);
	ace->ace_rights = (u_int32_t)strtoul(argv[4], NULL, 0);
	acl_t acl = acl_copy_int_native(fs);
	free(fs);
	if (!acl) { return 1; }
	int rc = acl_set_file(argv[1], ACL_TYPE_EXTENDED, acl);
	acl_free(acl);
	return rc == 0 ? 0 : 1;
}
`;

	/**
	 * Every row below runs the REAL loader source with one replacement at a production
	 * call boundary, so the rules under test are the shipped ones. Nothing about the
	 * classifier is reimplemented in the test.
	 */
	type Seam = { anchor: string; replacement: string };

	const SEAMS: Record<string, (argument: string) => Seam> = {
		handle: value => ({
			anchor: "aclGetFd: fd => library.symbols.acl_get_fd_np(fd, ACL_TYPE_EXTENDED),",
			replacement: `aclGetFd: fd => { const real = library.symbols.acl_get_fd_np(fd, ACL_TYPE_EXTENDED); ${value} },`,
		}),
		valid: value => ({
			anchor: "aclValid: acl => library.symbols.acl_valid(acl),",
			replacement: `aclValid: acl => { const real = library.symbols.acl_valid(acl); ${value} },`,
		}),
		size: value => ({
			anchor: "aclSize: acl => Number(library.symbols.acl_size(acl)),",
			replacement: `aclSize: acl => { const real = Number(library.symbols.acl_size(acl)); ${value} },`,
		}),
		copy: value => ({
			anchor:
				"aclCopyExtNative: (buffer, acl, size) =>\n\t\t\t\tNumber(library.symbols.acl_copy_ext_native(ptr(buffer), acl, size)),",
			replacement: `aclCopyExtNative: (buffer, acl, size) => { const real = Number(library.symbols.acl_copy_ext_native(ptr(buffer), acl, size)); ${value} },`,
		}),
		mask: value => ({
			anchor: "aclGetPermsetMask: (entry, out) => library.symbols.acl_get_permset_mask_np(entry, ptr(out)),",
			replacement: `aclGetPermsetMask: (entry, out) => { const real = library.symbols.acl_get_permset_mask_np(entry, ptr(out)); ${value} },`,
		}),
		entry: value => ({
			anchor: "aclGetEntry: (acl, id, out) => library.symbols.acl_get_entry(acl, id, ptr(out)),",
			replacement: `aclGetEntry: (acl, id, out) => { const real = library.symbols.acl_get_entry(acl, id, ptr(out)); ${value} },`,
		}),
		pointer: value => ({
			anchor: "readPointer: view => Number(view[0]),",
			replacement: `readPointer: view => { const real = Number(view[0]); ${value} },`,
		}),
		reset: value => ({
			anchor: "resetErrno: () => {",
			replacement: `resetErrno: () => { ${value}`,
		}),
		errno: value => ({
			anchor: "errno: () => {",
			replacement: `errno: () => { ${value}`,
		}),
		free: value => ({
			anchor: "aclFree: acl => library.symbols.acl_free(acl),",
			replacement: `aclFree: acl => { const real = library.symbols.acl_free(acl); ${value} },`,
		}),
	};

	async function fixturePackage(workspace: string): Promise<string> {
		const native = path.join(workspace, "pkg", "native");
		await fs.mkdir(native, { recursive: true });
		const manifest = (await Bun.file(path.join(NATIVE_DIR, "..", "package.json")).json()) as { version: string };
		await Bun.write(
			path.join(workspace, "pkg", "package.json"),
			JSON.stringify({ name: "@gajae-code/natives", version: manifest.version }),
		);
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version: manifest.version,
				artifacts: { "pi_natives.darwin-arm64.node": await fixtureSha256(ARTIFACT) },
			}),
		);
		return native;
	}

	async function craftTool(workspace: string): Promise<string> {
		const source = path.join(workspace, "craft.c");
		const binary = path.join(workspace, "craft");
		await Bun.write(source, CRAFT_SOURCE);
		const built = Bun.spawnSync({
			cmd: ["/usr/bin/cc", "-o", binary, source],
			cwd: workspace,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (built.exitCode !== 0) {
			throw new Error(`craft build failed: ${new TextDecoder().decode(built.stderr ?? new Uint8Array())}`);
		}
		return binary;
	}

	/** Run the real (optionally seam-patched) loader against one directory. */
	async function decide(
		native: string,
		workspace: string,
		directory: string,
		seams: Seam[],
		label: string,
		withTrace = false,
	): Promise<{
		decision: string;
		frees?: number;
		allocs?: number;
		errnoAfter?: number;
		trace?: string[];
		faultApplied?: string | null;
		usedErrno?: number | null;
	}> {
		let source = await Bun.file(LOADER).text();
		for (const seam of seams) {
			const anchor = seam.anchor.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
			if (!source.includes(anchor)) throw new Error(`seam anchor missing for ${label}: ${anchor.slice(0, 60)}`);
			source = source.replace(anchor, seam.replacement);
		}
		const modulePath = path.join(native, `patched-${label}-${Math.random().toString(36).slice(2)}.js`);
		await Bun.write(modulePath, source);
		const harness = path.join(workspace, `run-${label}-${Math.random().toString(36).slice(2)}.ts`);
		await Bun.write(
			harness,
			`const nodeFs = require("node:fs");
globalThis.__GJC_MATRIX__ = { frees: 0, trace: [] };
const { inspectAncestorAclOnDescriptor } = await import(${JSON.stringify("MODULE")});
const fd = nodeFs.openSync(${JSON.stringify(directory)}, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
let decision = "threw";
try {
	decision = inspectAncestorAclOnDescriptor(fd);
} finally {
	nodeFs.closeSync(fd);
}
console.log(JSON.stringify({
	decision,
	frees: globalThis.__GJC_MATRIX__.frees ?? 0,
	allocs: globalThis.__GJC_MATRIX__.allocs ?? 0,
	errnoAfter: globalThis.__GJC_MATRIX__.errnoAfter ?? null,
	trace: globalThis.__GJC_MATRIX__.trace,
	faultApplied: globalThis.__GJC_MATRIX__.faultApplied ?? null,
	usedErrno: globalThis.__GJC_MATRIX__.usedErrno ?? null,
}));`.replace(JSON.stringify("MODULE"), JSON.stringify(modulePath)),
		);
		const child = Bun.spawnSync({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		if (stdout === "") {
			throw new Error(
				`row ${label} produced no output: ${new TextDecoder().decode(child.stderr ?? new Uint8Array()).slice(0, 300)}`,
			);
		}
		const parsed = JSON.parse(stdout) as {
			decision: string;
			frees?: number;
			allocs?: number;
			errnoAfter?: number;
			trace?: string[];
			faultApplied?: string | null;
			usedErrno?: number | null;
		};
		if (withTrace && parsed.trace === undefined) throw new Error(`row ${label} produced no trace`);
		return parsed;
	}

	/**
	 * Raw-trace predicate for the ancestor pass: the nine boundary events must appear in
	 * order with NO cleanup interleaved, and no ancestor cleanup may precede the window's
	 * final capture. Nothing is filtered out of the trace before checking.
	 */
	function rawOrderHolds(trace: string[]): { ok: boolean; reason?: string; window?: string[] } {
		const expected = [
			"reset",
			"call:first",
			"capture",
			"reset",
			"call:last",
			"capture",
			"reset",
			"call:next",
			"capture",
		];
		const ancestorFirst = trace.lastIndexOf("call:first");
		if (ancestorFirst < 1) return { ok: false, reason: "no ancestor FIRST call" };
		const start = ancestorFirst - 1;
		const window = trace.slice(start, start + expected.length);
		if (window.length !== expected.length) return { ok: false, reason: "window truncated" };
		if (window.includes("free")) return { ok: false, reason: "cleanup inside the ancestor window" };
		if (window.some((event, index) => event !== expected[index])) {
			return { ok: false, reason: "window order differs", window };
		}
		const finalCapture = start + expected.length - 1;
		if (trace.slice(start, finalCapture).includes("free")) {
			return { ok: false, reason: "cleanup inside the ancestor window" };
		}
		if (!trace.slice(finalCapture + 1).includes("free")) {
			return { ok: false, reason: "no cleanup after the final capture" };
		}
		return { ok: true, window };
	}

	/** Same runner, but it also returns the recorded boundary trace. */
	async function decideTraced(
		native: string,
		workspace: string,
		directory: string,
		seams: Seam[],
		label: string,
	): Promise<{ decision: string; trace: string[] }> {
		const observed = (await decide(native, workspace, directory, seams, label, true)) as {
			decision: string;
			trace?: string[];
		};
		return { decision: observed.decision, trace: observed.trace ?? [] };
	}

	it.skipIf(process.platform !== "darwin")(
		"closes every COUNT call-boundary failure on the real source",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-matrix-count-"));
			const targets: string[] = [];
			try {
				const native = await fixturePackage(workspace);
				const tool = await craftTool(workspace);
				const directory = path.join(workspace, "approved");
				await fs.mkdir(directory, { recursive: true, mode: 0o755 });
				targets.push(directory);
				Bun.spawnSync({ cmd: [tool, directory, "0x0", "0x2", "0x10"], stdout: "pipe", stderr: "pipe" });

				// Control: the unpatched source admits the approved shape.
				expect((await decide(native, workspace, directory, [], "control-before")).decision).toBe(
					"approved-single-deny-delete",
				);

				const rows: [string, Seam[], string][] = [];
				for (const [name, errno] of [
					["einval", 22],
					["eio", 5],
					["ebadf", 9],
					["unknown", 1234],
				] as [string, number][]) {
					for (const selector of ["0", "-2"] as const) {
						const which = selector === "0" ? "first" : "last";
						rows.push([
							`${which}-minus-one-${name}`,
							[
								SEAMS.entry(`if (id === ${selector}) return -1; return real;`),
								SEAMS.errno(`if (globalThis.__GJC_MATRIX__.entryFailed) return ${errno};`),
								{
									anchor: "const first = symbols.aclGetEntry(acl, ACL_FIRST_ENTRY, firstOut);",
									replacement:
										"globalThis.__GJC_MATRIX__.entryFailed = true; const first = symbols.aclGetEntry(acl, ACL_FIRST_ENTRY, firstOut);",
								},
							],
							"unproven",
						]);
						rows.push([
							`${which}-unexpected-return-${name}`,
							[SEAMS.entry(`if (id === ${selector}) return 7; return real;`)],
							"unproven",
						]);
					}
				}
				// success + NULL entry pointer, and a FIRST/LAST pointer mismatch.
				// success + NULL entry pointer for FIRST and for LAST. The pointer reads are
				// counted so each row provably targets the intended step: read 1 is FIRST and
				// read 2 is LAST.
				rows.push([
					"first-success-null",
					[
						SEAMS.pointer(
							"globalThis.__GJC_MATRIX__.reads = (globalThis.__GJC_MATRIX__.reads ?? 0) + 1; if (globalThis.__GJC_MATRIX__.reads === 1) return 0; return real;",
						),
					],
					"unproven",
				]);
				rows.push([
					"last-success-null",
					[
						SEAMS.pointer(
							"globalThis.__GJC_MATRIX__.reads = (globalThis.__GJC_MATRIX__.reads ?? 0) + 1; if (globalThis.__GJC_MATRIX__.reads === 2) return 0; return real;",
						),
					],
					"unproven",
				]);
				rows.push([
					"first-last-mismatch",
					[
						SEAMS.pointer(
							"globalThis.__GJC_MATRIX__.calls = (globalThis.__GJC_MATRIX__.calls ?? 0) + 1; return globalThis.__GJC_MATRIX__.calls === 2 ? real + 24 : real;",
						),
					],
					"unproven",
				]);
				// NEXT rows on the real source.
				for (const [name, errno] of [
					["eio", 5],
					["ebadf", 9],
					["unknown", 1234],
					["zero", 0],
				] as [string, number][]) {
					rows.push([
						`next-minus-one-${name}`,
						[
							SEAMS.entry("if (id === -1) return -1; return real;"),
							SEAMS.errno(`if (globalThis.__GJC_MATRIX__.nextSeen) return ${errno};`),
							{
								anchor: "const next = symbols.aclGetEntry(acl, ACL_NEXT_ENTRY, nextOut);",
								replacement:
									"globalThis.__GJC_MATRIX__.nextSeen = true; const next = symbols.aclGetEntry(acl, ACL_NEXT_ENTRY, nextOut);",
							},
						],
						"unproven",
					]);
				}
				rows.push(["next-unexpected-return", [SEAMS.entry("if (id === -1) return 7; return real;")], "unproven"]);
				rows.push(["next-second-entry", [SEAMS.entry("if (id === -1) return 0; return real;")], "not-allowlisted"]);
				// errno availability and reset behaviour. The unconditional rows can already be
				// decided by the strict classification call that runs first, so each one is
				// paired with a row that provably fails only once the ancestor iterator has
				// been reached (the NEXT step), which is the step the contract is about.
				rows.push(["reset-false", [SEAMS.reset("return false;")], "unproven"]);
				rows.push(["reset-throws", [SEAMS.reset('throw new Error("reset unavailable");')], "unproven"]);
				rows.push(["errno-null", [SEAMS.errno("return null;")], "unproven"]);
				rows.push(["errno-throws", [SEAMS.errno('throw new Error("errno unavailable");')], "unproven"]);
				// Stage markers. `firstOut` exists only in the ancestor decision, so it marks the
				// ancestor pass; the NEXT marker must be set BEFORE that step's reset, which is
				// why it is anchored on the `nextOut` declaration and not on the call itself.
				const markAncestor: Seam = {
					anchor: "const firstOut = new BigUint64Array(1);",
					replacement:
						'globalThis.__GJC_MATRIX__.stage = "ancestor-first"; const firstOut = new BigUint64Array(1);',
				};
				const markNext: Seam = {
					anchor: "const nextOut = new BigUint64Array(1);",
					replacement: 'globalThis.__GJC_MATRIX__.stage = "ancestor-next"; const nextOut = new BigUint64Array(1);',
				};
				// Each iterator-targeted row records which stage consumed the fault, and the row
				// asserts that evidence, so a fault that silently landed on another step (the
				// mask reset, say) can no longer pass for an iterator failure.
				const iteratorRows: [string, Seam[], string][] = [
					[
						"iterator-reset-false",
						[
							markNext,
							SEAMS.reset(
								'if (globalThis.__GJC_MATRIX__.stage === "ancestor-next") { globalThis.__GJC_MATRIX__.faultApplied = "next-reset"; return false; }',
							),
						],
						"next-reset",
					],
					[
						"iterator-reset-throws",
						[
							markNext,
							SEAMS.reset(
								'if (globalThis.__GJC_MATRIX__.stage === "ancestor-next") { globalThis.__GJC_MATRIX__.faultApplied = "next-reset-throw"; throw new Error("reset unavailable at the iterator"); }',
							),
						],
						"next-reset-throw",
					],
					[
						"iterator-errno-null",
						[
							markNext,
							SEAMS.errno(
								'if (globalThis.__GJC_MATRIX__.stage === "ancestor-next") { globalThis.__GJC_MATRIX__.faultApplied = "next-errno-null"; return null; }',
							),
						],
						"next-errno-null",
					],
					[
						"iterator-errno-throws",
						[
							markNext,
							SEAMS.errno(
								'if (globalThis.__GJC_MATRIX__.stage === "ancestor-next") { globalThis.__GJC_MATRIX__.faultApplied = "next-errno-throw"; throw new Error("errno unavailable at the iterator"); }',
							),
						],
						"next-errno-throw",
					],
					[
						// The ancestor pass's own FIRST step: the strict classification call
						// enumerates first, so without the ancestor marker this fault would be
						// consumed there instead.
						"ancestor-first-minus-one-eio",
						[
							markAncestor,
							SEAMS.entry(
								'if (id === 0 && globalThis.__GJC_MATRIX__.stage === "ancestor-first") { globalThis.__GJC_MATRIX__.faultApplied = "ancestor-first"; globalThis.__GJC_MATRIX__.usedErrno = 5; return -1; } return real;',
							),
							SEAMS.errno(
								"if (globalThis.__GJC_MATRIX__.usedErrno !== undefined) return globalThis.__GJC_MATRIX__.usedErrno;",
							),
						],
						"ancestor-first",
					],
					[
						"ancestor-first-unexpected-return",
						[
							markAncestor,
							SEAMS.entry(
								'if (id === 0 && globalThis.__GJC_MATRIX__.stage === "ancestor-first") { globalThis.__GJC_MATRIX__.faultApplied = "ancestor-first-unexpected"; return 7; } return real;',
							),
						],
						"ancestor-first-unexpected",
					],
				];

				// The row count is pinned so the report can cite a measured number.
				expect(rows.length).toBe(29);
				expect(iteratorRows.length).toBe(6);
				for (const [label, seams, expected] of rows) {
					// Valid control immediately before and after every single fault row, not
					// only around the bundle.
					expect({
						label,
						stage: "before",
						decision: (await decide(native, workspace, directory, [], `${label}-before`)).decision,
					}).toEqual({ label, stage: "before", decision: "approved-single-deny-delete" });
					const observed = await decide(native, workspace, directory, seams, label);
					expect({ label, decision: observed.decision }).toEqual({ label, decision: expected });
					expect({
						label,
						stage: "after",
						decision: (await decide(native, workspace, directory, [], `${label}-after`)).decision,
					}).toEqual({ label, stage: "after", decision: "approved-single-deny-delete" });
				}

				// Stage-targeted rows: the decision closes AND the recorded evidence proves the
				// fault was consumed at the intended step.
				for (const [label, seams, expectedTarget] of iteratorRows) {
					const observed = await decide(native, workspace, directory, seams, label);
					expect({ label, decision: observed.decision, faultApplied: observed.faultApplied }).toEqual({
						label,
						decision: "unproven",
						faultApplied: expectedTarget,
					});
					if (label === "ancestor-first-minus-one-eio") {
						// The errno handed to the target step is the one the decision saw.
						expect(observed.usedErrno).toBe(5);
					}
					expect((await decide(native, workspace, directory, [], `${label}-after`)).decision).toBe(
						"approved-single-deny-delete",
					);
				}

				// Order regression: cleanup clobbers errno after the captures. The decision
				// must be unchanged and the clobber must really have happened.
				const ordered = await decide(
					native,
					workspace,
					directory,
					[
						// Mark the point after the last capture, then let cleanup clobber errno.
						{
							anchor: "const maskResult = symbols.aclGetPermsetMask(firstEntry, maskOut);",
							replacement:
								"const maskResult = symbols.aclGetPermsetMask(firstEntry, maskOut); globalThis.__GJC_MATRIX__.afterCaptures = true;",
						},
						SEAMS.free(
							"globalThis.__GJC_MATRIX__.frees = (globalThis.__GJC_MATRIX__.frees ?? 0) + 1; if (globalThis.__GJC_MATRIX__.afterCaptures) globalThis.__GJC_MATRIX__.errnoAfter = 5; return real;",
						),
						SEAMS.errno(
							"if (globalThis.__GJC_MATRIX__.errnoAfter !== undefined) return globalThis.__GJC_MATRIX__.errnoAfter;",
						),
					],
					"errno-clobbered-by-free",
				);
				expect({ decision: ordered.decision, errnoAfter: ordered.errnoAfter }).toEqual({
					decision: "approved-single-deny-delete",
					errnoAfter: 5,
				});

				expect((await decide(native, workspace, directory, [], "control-after")).decision).toBe(
					"approved-single-deny-delete",
				);
			} finally {
				for (const target of targets) Bun.spawnSync({ cmd: ["/bin/chmod", "-N", target] });
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"closes every FFI failure on the real source and frees the handle exactly once",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-matrix-ffi-"));
			const targets: string[] = [];
			try {
				const native = await fixturePackage(workspace);
				const tool = await craftTool(workspace);
				const directory = path.join(workspace, "approved");
				await fs.mkdir(directory, { recursive: true, mode: 0o755 });
				targets.push(directory);
				Bun.spawnSync({ cmd: [tool, directory, "0x0", "0x2", "0x10"], stdout: "pipe", stderr: "pipe" });
				const countFrees = SEAMS.free("globalThis.__GJC_MATRIX__.frees += 1; return real;");
				// Allocation counting makes "freed exactly once per allocated handle" the
				// assertion: the strict classification call before the ancestor decision
				// allocates and frees its own handle too.
				const countAllocs = (rowLogic: string): Seam =>
					SEAMS.handle(
						`const handle = typeof real === "bigint" ? Number(real) : real; if (handle) globalThis.__GJC_MATRIX__.allocs = (globalThis.__GJC_MATRIX__.allocs ?? 0) + 1; ${rowLogic}`,
					);

				const rows: [string, Seam[], string][] = [
					[
						"handle-null",
						[
							countAllocs(
								"if (real) { library.symbols.acl_free(real); globalThis.__GJC_MATRIX__.frees = (globalThis.__GJC_MATRIX__.frees ?? 0) + 1; } return 0;",
							),
							countFrees,
						],
						"unproven",
					],
					["valid-nonzero", [countAllocs("return real;"), SEAMS.valid("return 1;"), countFrees], "unproven"],
					[
						"valid-throws",
						[countAllocs("return real;"), SEAMS.valid('throw new Error("acl_valid failed");'), countFrees],
						"unproven",
					],
					["size-negative", [countAllocs("return real;"), SEAMS.size("return -1;"), countFrees], "unproven"],
					["size-zero", [countAllocs("return real;"), SEAMS.size("return 0;"), countFrees], "unproven"],
					[
						"size-oversize",
						[countAllocs("return real;"), SEAMS.size("return (1 << 20) + 1;"), countFrees],
						"unproven",
					],
					["size-noninteger", [countAllocs("return real;"), SEAMS.size("return 67.5;"), countFrees], "unproven"],
					[
						"size-throws",
						[countAllocs("return real;"), SEAMS.size('throw new Error("acl_size failed");'), countFrees],
						"unproven",
					],
					["copy-negative", [countAllocs("return real;"), SEAMS.copy("return -1;"), countFrees], "unproven"],
					["copy-short", [countAllocs("return real;"), SEAMS.copy("return 24;"), countFrees], "unproven"],
					[
						"copy-oversize",
						[countAllocs("return real;"), SEAMS.copy("return real + 24;"), countFrees],
						"unproven",
					],
					[
						"copy-throws",
						[countAllocs("return real;"), SEAMS.copy('throw new Error("acl_copy failed");'), countFrees],
						"unproven",
					],
					["mask-error", [countAllocs("return real;"), SEAMS.mask("return -1;"), countFrees], "unproven"],
					[
						"mask-throws",
						[countAllocs("return real;"), SEAMS.mask('throw new Error("mask getter failed");'), countFrees],
						"unproven",
					],
					[
						// The u64 mask must equal DELETE exactly, high bits included.
						"mask-high-bit",
						[countAllocs("return real;"), SEAMS.mask("out[0] = (1n << 32n) | 16n; return 0;"), countFrees],
						"not-allowlisted",
					],
					[
						"mask-extra-right",
						[countAllocs("return real;"), SEAMS.mask("out[0] = 16n | 4n; return 0;"), countFrees],
						"not-allowlisted",
					],
				];

				expect((await decide(native, workspace, directory, [countFrees], "control-before")).decision).toBe(
					"approved-single-deny-delete",
				);
				for (const [label, seams, expected] of rows) {
					expect({
						label,
						stage: "before",
						decision: (await decide(native, workspace, directory, [countFrees], `${label}-before`)).decision,
					}).toEqual({ label, stage: "before", decision: "approved-single-deny-delete" });
					const observed = await decide(native, workspace, directory, seams, label);
					// Every allocated handle is released exactly once, and no fault leaks one.
					// This is a frees == allocations invariant, not a fixed count: the strict
					// classification call allocates and frees its own handle first.
					expect({ label, decision: observed.decision, balanced: observed.frees === observed.allocs }).toEqual({
						label,
						decision: expected,
						balanced: true,
					});
					expect({
						label,
						stage: "after",
						decision: (await decide(native, workspace, directory, [countFrees], `${label}-after`)).decision,
					}).toEqual({ label, stage: "after", decision: "approved-single-deny-delete" });
				}
				expect((await decide(native, workspace, directory, [countFrees], "control-after")).decision).toBe(
					"approved-single-deny-delete",
				);
			} finally {
				for (const target of targets) Bun.spawnSync({ cmd: ["/bin/chmod", "-N", target] });
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"traces reset -> call -> capture -> free at the iterator boundaries",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-acl-matrix-trace-"));
			const targets: string[] = [];
			try {
				const native = await fixturePackage(workspace);
				const tool = await craftTool(workspace);
				const directory = path.join(workspace, "approved");
				await fs.mkdir(directory, { recursive: true, mode: 0o755 });
				targets.push(directory);
				Bun.spawnSync({ cmd: [tool, directory, "0x0", "0x2", "0x10"], stdout: "pipe", stderr: "pipe" });

				// Instrumentation records the real order of the boundary events. The
				// classifier itself is untouched: only the symbol wrappers append to a trace.
				const instrument: Seam[] = [
					SEAMS.reset('globalThis.__GJC_MATRIX__.trace.push("reset");'),
					SEAMS.errno('globalThis.__GJC_MATRIX__.trace.push("capture");'),
					SEAMS.entry(
						'globalThis.__GJC_MATRIX__.trace.push(id === 0 ? "call:first" : id === -2 ? "call:last" : "call:next"); return real;',
					),
					SEAMS.free('globalThis.__GJC_MATRIX__.trace.push("free"); return real;'),
				];
				const traced = await decideTraced(native, workspace, directory, instrument, "trace");

				// Only the iterator steps are asserted, because those are the steps the
				// contract constrains: each call is preceded by a reset and followed
				// immediately by a capture, and every free happens after all of them.
				// The predicate reads the RAW trace: no event is filtered out, so an interleaved
				// cleanup cannot hide. The window is anchored at the ancestor pass (its FIRST
				// call is the last one recorded); the strict pass's own cleanup sits before that
				// window and is therefore irrelevant.
				expect(rawOrderHolds(traced.trace)).toEqual({
					ok: true,
					window: [
						"reset",
						"call:first",
						"capture",
						"reset",
						"call:last",
						"capture",
						"reset",
						"call:next",
						"capture",
					],
				});
				expect(traced.decision).toBe("approved-single-deny-delete");

				// Bounded negative sensitivity control: a deliberately mis-ordered COPY of the
				// source, where the iterator capture is taken after the free, no longer
				// produces the expected trace and no longer admits the fixture. This is a
				// sensitivity check on the instrumentation, not a restoration of any earlier
				// test-first history.
				const misordered = await decideTraced(
					native,
					workspace,
					directory,
					[
						SEAMS.reset('globalThis.__GJC_MATRIX__.trace.push("reset");'),
						SEAMS.entry(
							'globalThis.__GJC_MATRIX__.trace.push(id === 0 ? "call:first" : id === -2 ? "call:last" : "call:next"); return real;',
						),
						SEAMS.free('globalThis.__GJC_MATRIX__.trace.push("free"); return real;'),
						// Cleanup happens at the iterator boundary BEFORE the capture, exactly the
						// ordering the contract forbids. No real allocation is released twice: the
						// cleanup is recorded and its errno clobber is what the capture then sees.
						{
							anchor: "const nextErrno = symbols.errno();",
							replacement:
								'globalThis.__GJC_MATRIX__.trace.push("free"); globalThis.__GJC_MATRIX__.clobbered = true; const nextErrno = symbols.errno();',
						},
						SEAMS.errno(
							'globalThis.__GJC_MATRIX__.trace.push("capture"); if (globalThis.__GJC_MATRIX__.clobbered) return 5;',
						),
					],
					"misordered",
				);
				// The same raw predicate must REJECT the mis-ordered copy.
				const misorderedVerdict = rawOrderHolds(misordered.trace);
				expect(misorderedVerdict.ok).toBe(false);
				expect(misorderedVerdict.reason).toBe("cleanup inside the ancestor window");
				expect(misordered.decision).not.toBe("approved-single-deny-delete");
			} finally {
				for (const target of targets) Bun.spawnSync({ cmd: ["/bin/chmod", "-N", target] });
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it("walks every field bit and structural shape, with the same expectations as the native side", async () => {
		const { parseAclRepresentation, classifyAclRepresentation } = (await import(LOADER)) as {
			parseAclRepresentation: (bytes: Uint8Array) => unknown;
			classifyAclRepresentation: (parsed: unknown) => string;
		};
		const representation = (
			count: number,
			entries: number,
			header: number,
			flags: number,
			rights: number,
		): Uint8Array => {
			const bytes = new Uint8Array(44 + 24 * entries);
			const view = new DataView(bytes.buffer);
			view.setUint32(0, 0x012cc16d, true);
			view.setUint32(36, count, true);
			view.setUint32(40, header, true);
			for (let index = 0; index < entries; index += 1) {
				const base = 44 + index * 24;
				bytes.set(
					[0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x0c],
					base,
				);
				view.setUint32(base + 16, flags, true);
				view.setUint32(base + 20, rights, true);
			}
			return bytes;
		};
		const decideBytes = (bytes: Uint8Array): string => classifyAclRepresentation(parseAclRepresentation(bytes));
		const approved = "approved-single-deny-delete";
		const refused = "not-allowlisted";
		const unproven = "unproven";

		expect(decideBytes(representation(1, 1, 0, 2, 16))).toBe(approved);
		for (let bit = 0; bit < 32; bit += 1) {
			const solo = 2 ** bit;
			expect({ bit, decision: decideBytes(representation(1, 1, solo, 2, 16)) }).toEqual({ bit, decision: refused });
			if (solo !== 2) {
				expect({ bit, decision: decideBytes(representation(1, 1, 0, solo, 16)) }).toEqual({
					bit,
					decision: refused,
				});
				expect({ bit, decision: decideBytes(representation(1, 1, 0, 2 | solo, 16)) }).toEqual({
					bit,
					decision: refused,
				});
			}
			if (solo !== 16) {
				expect({ bit, decision: decideBytes(representation(1, 1, 0, 2, solo)) }).toEqual({
					bit,
					decision: refused,
				});
				expect({ bit, decision: decideBytes(representation(1, 1, 0, 2, 16 | solo)) }).toEqual({
					bit,
					decision: refused,
				});
			}
		}
		expect(decideBytes(representation(1, 1, 0, 0, 16))).toBe(refused);
		expect(decideBytes(representation(1, 1, 0, 2, 0))).toBe(refused);

		for (const count of [0, 2, 5, 128]) {
			expect({ count, decision: decideBytes(representation(count, count, 0, 2, 16)) }).toEqual({
				count,
				decision: count === 1 ? approved : refused,
			});
		}
		expect(decideBytes(representation(129, 129, 0, 2, 16))).toBe(unproven);
		expect(decideBytes(representation(0xffffffff, 1, 0, 2, 16))).toBe(unproven);
		expect(decideBytes(representation(2, 1, 0, 2, 16))).toBe(unproven);
		expect(decideBytes(representation(1, 2, 0, 2, 16))).toBe(unproven);

		const swapped = representation(1, 1, 0, 2, 16);
		new DataView(swapped.buffer).setUint32(0, 0x012cc16d, false);
		expect(decideBytes(swapped)).toBe(unproven);
		const wrongMagic = representation(1, 1, 0, 2, 16);
		new DataView(wrongMagic.buffer).setUint32(0, 0xdeadbeef, true);
		expect(decideBytes(wrongMagic)).toBe(unproven);

		const full = representation(1, 1, 0, 2, 16);
		expect(decideBytes(full.slice(0, 43))).toBe(unproven);
		expect(decideBytes(full.slice(0, full.length - 1))).toBe(unproven);
		const plusOne = new Uint8Array(full.length + 1);
		plusOne.set(full);
		expect(decideBytes(plusOne)).toBe(unproven);
		const plusEntry = new Uint8Array(full.length + 24);
		plusEntry.set(full);
		expect(decideBytes(plusEntry)).toBe(unproven);
		expect(decideBytes(new Uint8Array(0))).toBe(unproven);

		const stranger = representation(1, 1, 0, 2, 16);
		stranger.set(new Uint8Array(16).fill(7), 44);
		expect(decideBytes(stranger)).toBe(refused);

		// The exported helper is not total over arbitrary objects: a direct call with a
		// hostile shape may throw. The production path's catch is what closes it as
		// unproven, and that boundary is asserted by the seam rows above.
		expect(() =>
			classifyAclRepresentation({
				ok: true,
				count: 1,
				headerFlags: 0,
				entries: [
					{
						get flags() {
							throw new Error("hostile getter");
						},
						rights: 16,
						guid: new Uint8Array(16),
					},
				],
			}),
		).toThrow();
		expect(classifyAclRepresentation({ ok: true, count: 1, headerFlags: 0, entries: [] })).toBe(unproven);
		expect(classifyAclRepresentation(null)).toBe(unproven);
		expect(classifyAclRepresentation({ ok: false })).toBe(unproven);
	});
});

describe("runtime tuple admission (R6)", () => {
	it("refuses every tuple except darwin/arm64 on Bun 1.4.0, before any filesystem or native access", async () => {
		const { loadDiagnosticNativeReadOnly } = (await import(LOADER)) as {
			loadDiagnosticNativeReadOnly: (runtime?: { platform?: string; arch?: string; bunVersion?: string }) => {
				ok: boolean;
				reason?: string;
			};
		};
		const unsupportedTuples = [
			{ platform: "linux", arch: "arm64", bunVersion: "1.4.0" },
			{ platform: "win32", arch: "arm64", bunVersion: "1.4.0" },
			{ platform: "darwin", arch: "x64", bunVersion: "1.4.0" },
			{ platform: "darwin", arch: "arm64", bunVersion: "1.4.1" },
			{ platform: "darwin", arch: "arm64", bunVersion: "1.3.9" },
			{ platform: "darwin", arch: "arm64", bunVersion: undefined },
		];
		for (const runtime of unsupportedTuples) {
			expect({ runtime, result: loadDiagnosticNativeReadOnly(runtime) }).toEqual({
				runtime,
				result: { ok: false, reason: "unsupported" },
			});
		}
	});

	it.skipIf(!SUPPORTED_RUNTIME)("still admits the one supported tuple", async () => {
		const { loadDiagnosticNativeReadOnly } = (await import(LOADER)) as {
			loadDiagnosticNativeReadOnly: (runtime?: { platform?: string; arch?: string; bunVersion?: string }) => {
				ok: boolean;
			};
		};
		// The tuple gate is what this row proves; whether the artifact's namespace is
		// admissible on this host is a separate, independently observed condition.
		const admissible = expectedLoadOutcome(ARTIFACT).ok;
		expect(loadDiagnosticNativeReadOnly({ platform: "darwin", arch: "arm64", bunVersion: "1.4.0" }).ok).toBe(
			admissible,
		);
		expect(loadDiagnosticNativeReadOnly().ok).toBe(admissible);
	});

	it("decides the runtime tuple before it touches the filesystem", async () => {
		const code = stripComments(await Bun.file(LOADER).text());
		const loadPath = code.slice(code.indexOf("export function loadDiagnosticNativeReadOnly"));
		const gate = loadPath.indexOf("supportedRuntime");
		expect(gate).toBeGreaterThan(0);
		expect(gate).toBeLessThan(loadPath.indexOf("selectArtifactLayout(require)"));
		expect(code).toContain('"1.4.0"');
	});
});

describe("compiled-distribution read-only cache (B3)", () => {
	const PACKAGE_ROOT = path.join(NATIVE_DIR, "..");

	async function packageVersion(): Promise<string> {
		return ((await Bun.file(path.join(PACKAGE_ROOT, "package.json")).json()) as { version: string }).version;
	}

	async function buildCompiledProbe(workspace: string, loader: string = LOADER): Promise<string> {
		const entry = path.join(workspace, `probe-${path.basename(path.dirname(path.dirname(loader)))}.ts`);
		await Bun.write(
			entry,
			`import { loadDiagnosticNativeReadOnly } from ${JSON.stringify(loader)};
const loaded = loadDiagnosticNativeReadOnly();
if (!loaded.ok) {
	console.log(JSON.stringify({ ok: false, reason: loaded.reason }));
} else {
	const lease = loaded.value.openDiagnosticSnapshot(process.argv[2] ?? "/nonexistent-task-agent", 2000);
	const first = lease.read();
	const revalidated = lease.revalidate();
	lease.close();
	lease.close();
	const afterClose = lease.read();
	console.log(
		JSON.stringify({
			ok: true,
			leaseOk: lease.ok,
			leaseReason: lease.reason,
			read: first.reason,
			revalidate: revalidated.reason,
			afterClose: afterClose.reason,
		}),
	);
}
`,
		);
		const output = `${entry.replace(/\.ts$/, "")}-bin`;
		const build = Bun.spawnSync({
			cmd: [process.execPath, "build", "--compile", "--outfile", output, entry],
			cwd: PACKAGE_ROOT,
			env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(build.exitCode).toBe(0);
		return output;
	}

	async function runCompiled(
		binary: string,
		home: string,
		argv: string[] = [],
	): Promise<{ parsed: Record<string, unknown>; stderr: string }> {
		const child = Bun.spawnSync({
			cmd: [binary, ...argv],
			cwd: home,
			env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array()).trim();
		return {
			parsed: JSON.parse(stdout) as Record<string, unknown>,
			stderr: new TextDecoder().decode(child.stderr ?? new Uint8Array()),
		};
	}

	async function fileSha256(file: string): Promise<string> {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
		return hasher.digest("hex");
	}

	type CacheSnapshot = {
		artifactSha256: string;
		artifactMode: number;
		entries: string[];
		versions: string[];
		home: string[];
	};

	async function cacheSnapshot(home: string, dir: string, artifact: string): Promise<CacheSnapshot> {
		const walk = async (root: string): Promise<string[]> => {
			const found: string[] = [];
			const visit = async (current: string): Promise<void> => {
				for (const entry of await fs.readdir(current, { withFileTypes: true })) {
					const child = path.join(current, entry.name);
					found.push(path.relative(root, child));
					if (entry.isDirectory()) await visit(child);
				}
			};
			await visit(root);
			return found.sort();
		};
		return {
			artifactSha256: await fileSha256(artifact),
			artifactMode: (await fs.stat(artifact)).mode & 0o777,
			entries: (await fs.readdir(dir)).sort(),
			versions: (await fs.readdir(path.join(home, ".gjc", "natives"))).sort(),
			home: await walk(path.join(home, ".gjc")),
		};
	}

	async function cacheDir(home: string, version: string): Promise<string> {
		const dir = path.join(home, ".gjc", "natives", version);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"uses the already verified cached artifact, exercises the lease and extracts nothing",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-compiled-"));
			try {
				const version = await packageVersion();
				const dir = await cacheDir(workspace, version);
				const cached = path.join(dir, "pi_natives.darwin-arm64.node");
				await fs.copyFile(ARTIFACT, cached);
				// Build the probe BEFORE the cache is sealed, so the compiled run itself
				// has no write permission anywhere in the cache path.
				const binary = await buildCompiledProbe(workspace);
				await fs.chmod(cached, 0o400);
				await fs.chmod(dir, 0o500);
				const before = await cacheSnapshot(workspace, dir, cached);
				const { parsed, stderr } = await runCompiled(binary, workspace);
				const after = await cacheSnapshot(workspace, dir, cached);
				const admissible = expectedLoadOutcome(cached).ok;
				expect(stderr).toBe("");
				expect(parsed.ok).toBe(admissible);
				if (!admissible) {
					// Read-only proof still holds: nothing was created or changed.
					expect(after).toEqual(before);
					expect(parsed.reason).toBe("unsupported");
					await fs.chmod(dir, 0o700);
					return;
				}
				// Lease API invocation proof: a missing publication is `absent`, close is
				// idempotent, and use after close fails closed.
				expect(parsed.leaseOk).toBe(false);
				expect(parsed.leaseReason).toBe("absent");
				expect(parsed.read).toBe("absent");
				expect(parsed.revalidate).toBe("absent");
				expect(parsed.afterClose).toBe("absent");
				// Read-only proof: identical artifact bytes and mode, identical cache
				// entries, and no new path anywhere under the task-owned HOME. The run
				// succeeded while every directory on the cache path denied writes, so no
				// extraction, staging or repair could have taken place.
				expect(after).toEqual(before);
				expect(after.artifactSha256).toBe(await fileSha256(ARTIFACT));
				expect(after.artifactMode).toBe(0o400);
				expect(after.entries).toEqual(["pi_natives.darwin-arm64.node"]);
				expect(after.versions).toEqual([version]);
				await fs.chmod(dir, 0o700);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"reports unsupported when the cache is absent",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-compiled-absent-"));
			try {
				const binary = await buildCompiledProbe(workspace);
				const { parsed } = await runCompiled(binary, workspace);
				expect(parsed).toEqual({ ok: false, reason: "unsupported" });
				// The loader did not create the cache location it refused to use.
				expect(await Bun.file(path.join(workspace, ".gjc", "natives")).exists()).toBe(false);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"reports unsupported for a corrupt cached artifact",
		async () => {
			const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-compiled-corrupt-"));
			try {
				const version = await packageVersion();
				const dir = await cacheDir(workspace, version);
				const cached = path.join(dir, "pi_natives.darwin-arm64.node");
				await Bun.write(cached, "not a mach-o addon");
				const binary = await buildCompiledProbe(workspace);
				const { parsed } = await runCompiled(binary, workspace);
				expect(parsed).toEqual({ ok: false, reason: "unsupported" });
				expect(await Bun.file(cached).text()).toBe("not a mach-o addon");
				expect((await fs.readdir(dir)).sort()).toEqual(["pi_natives.darwin-arm64.node"]);
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		120_000,
	);

	/**
	 * Task-independent version-mismatch isolation: the artifact under test is the
	 * freshly built one in this repo, and only the EXPECTED version differs,
	 * supplied by a copied fixture package manifest. Nothing outside the checkout
	 * is read, nothing is fetched and nothing is skipped, so an ordinary clone or
	 * CI runner exercises exactly this path.
	 */
	async function fixturePackageRoot(workspace: string, version: string): Promise<string> {
		const root = path.join(workspace, `pkg-${version}`);
		const native = path.join(root, "native");
		await fs.mkdir(native, { recursive: true });
		await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version }));
		await Bun.write(path.join(native, "diagnostic-loader.js"), await Bun.file(LOADER).text());
		await Bun.write(
			path.join(native, "diagnostic-artifact.json"),
			JSON.stringify({
				schema: "gjc.diagnostic-artifact",
				version,
				artifacts: { "pi_natives.darwin-arm64.node": await fixtureSha256(ARTIFACT) },
			}),
		);
		return root;
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"loads the cached artifact for the expected version and refuses a mismatched build",
		async () => {
			const realVersion = await packageVersion();
			for (const expectedVersion of [realVersion, "0.0.0-fixture"]) {
				const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-diag-version-"));
				try {
					const root = await fixturePackageRoot(workspace, expectedVersion);
					// The cache slot the loader will consult for this expected version.
					const dir = await cacheDir(workspace, expectedVersion);
					await fs.copyFile(ARTIFACT, path.join(dir, "pi_natives.darwin-arm64.node"));
					const binary = await buildCompiledProbe(workspace, path.join(root, "native", "diagnostic-loader.js"));
					const { parsed } = await runCompiled(binary, workspace);
					if (expectedVersion === realVersion) {
						// Control: with the same artifact in the same layout the only reason to
						// refuse is the independently observed namespace condition, so the
						// mismatch case below cannot pass for the wrong reason.
						const admissible = expectedLoadOutcome(path.join(dir, "pi_natives.darwin-arm64.node")).ok;
						expect(parsed.ok).toBe(admissible);
						if (admissible) expect(parsed.leaseReason).toBe("absent");
					} else {
						expect(parsed).toEqual({ ok: false, reason: "unsupported" });
					}
				} finally {
					await fs.rm(workspace, { recursive: true, force: true });
				}
			}
		},
		240_000,
	);

	it("refuses a binding without the diagnostic export or with a mismatched build", async () => {
		const { validateDiagnosticBinding } = (await import(LOADER)) as {
			validateDiagnosticBinding: (binding: unknown, expectedVersion: string) => boolean;
		};
		const valid = {
			diagnosticSnapshotOpen: () => undefined,
			nativeBuildInfo: () => ({ version: "1.2.3" }),
		};
		expect(validateDiagnosticBinding(valid, "1.2.3")).toBe(true);
		expect(validateDiagnosticBinding(valid, "1.2.4")).toBe(false);
		expect(validateDiagnosticBinding({ nativeBuildInfo: () => ({ version: "1.2.3" }) }, "1.2.3")).toBe(false);
		expect(validateDiagnosticBinding({ diagnosticSnapshotOpen: () => undefined }, "1.2.3")).toBe(false);
		expect(
			validateDiagnosticBinding(
				{ diagnosticSnapshotOpen: () => undefined, nativeBuildInfo: { version: "1.2.3" } },
				"1.2.3",
			),
		).toBe(false);
		expect(validateDiagnosticBinding(null, "1.2.3")).toBe(false);
	});
});

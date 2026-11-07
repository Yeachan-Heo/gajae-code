import { expect, spyOn, test } from "bun:test";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const packageNativeDir = path.join(import.meta.dir, "../native");
const realJs = path.join(packageNativeDir, "index.js");
const realDts = path.join(packageNativeDir, "index.d.ts");
const pkgScripts = path.join(import.meta.dir, "../scripts");
const repoRoot = path.join(import.meta.dir, "../../..");
const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

function symlinksAvailable(): boolean {
	const dir = fssync.mkdtempSync(path.join(os.tmpdir(), "native-link-probe-"));
	let created = false;
	try {
		fssync.symlinkSync("target", path.join(dir, "link"));
		created = true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES") throw err;
	} finally {
		fssync.rmSync(dir, { recursive: true, force: true });
	}
	return created;
}

const canSymlink = symlinksAvailable();
const loader = `prelude-keep\n${MARKER_START}\nexport const Old = 1;\n${MARKER_END}\ntail-keep\n`;
const declaration =
	'export declare const enum Color {\n\tRed = "red",\n}\nexport declare function editFindMatch(): void\n';

type Stamp = { dev: number; ino: number; nlink: number; symlink: boolean };
async function stamp(filePath: string): Promise<Stamp> {
	const st = await fs.lstat(filePath);
	return { dev: st.dev, ino: st.ino, nlink: st.nlink, symlink: st.isSymbolicLink() };
}
async function realStamps(): Promise<{ js: Stamp; dts: Stamp }> {
	return { js: await stamp(realJs), dts: await stamp(realDts) };
}
function deadPid(): number {
	for (let pid = 1_000_000; pid < 1_000_400; pid++) {
		try {
			process.kill(pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("no unused pid");
}
function fromUrl(abs: string): string {
	return JSON.stringify(pathToFileURL(abs).href);
}

type Fixture = {
	native: string;
	generateEnumExports: () => Promise<void>;
	cleanupStaleTemps: (dir: string) => Promise<void>;
	installBinary: (src: string, dest: string) => Promise<void>;
	installGeneratedBindings: (outputDir: string) => Promise<void>;
	ensurePublishDiagnosticDeclaration: () => Promise<void>;
	normalizeGeneratedDeclarationSpacing: () => Promise<void>;
	dispose: () => Promise<void>;
};

async function loadFixture(nativeTarget?: string): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-fix-"));
	const scripts = path.join(root, "scripts");
	const native = path.join(root, "native");
	await fs.mkdir(scripts);
	if (nativeTarget) await fs.symlink(nativeTarget, native);
	else await fs.mkdir(native);
	await fs.copyFile(path.join(pkgScripts, "gen-enums.ts"), path.join(scripts, "gen-enums.ts"));
	let build = await fs.readFile(path.join(pkgScripts, "build-native.ts"), "utf8");
	build = build.replaceAll(
		'from "../../../scripts/host-detect"',
		`from ${fromUrl(path.join(repoRoot, "scripts/host-detect.ts"))}`,
	);
	for (const name of ["diagnostic-artifact-manifest", "embed-guard", "gen-enums", "rust-toolchain-path"]) {
		build = build.replaceAll(`from "./${name}"`, `from ${fromUrl(path.join(pkgScripts, `${name}.ts`))}`);
	}
	build = build.replace(/^async function cleanupStaleTemps/m, "export async function cleanupStaleTemps");
	build = build.replace(/^async function installBinary/m, "export async function installBinary");
	build = build.replace(/^async function installGeneratedBindings/m, "export async function installGeneratedBindings");
	build = build.replace(
		/^async function ensurePublishDiagnosticDeclaration/m,
		"export async function ensurePublishDiagnosticDeclaration",
	);
	build = build.replace(
		/^async function normalizeGeneratedDeclarationSpacing/m,
		"export async function normalizeGeneratedDeclarationSpacing",
	);
	const buildPath = path.join(scripts, "build-native.ts");
	await fs.writeFile(buildPath, build);
	const gen = await import(pathToFileURL(path.join(scripts, "gen-enums.ts")).href);
	const inst = await import(pathToFileURL(buildPath).href);
	return {
		native,
		generateEnumExports: () => gen.generateEnumExports(native),
		cleanupStaleTemps: (dir: string) => inst.cleanupStaleTemps(dir),
		installBinary: (src: string, dest: string) => inst.installBinary(src, dest),
		installGeneratedBindings: (outputDir: string) => inst.installGeneratedBindings(outputDir, native),
		ensurePublishDiagnosticDeclaration: () => inst.ensurePublishDiagnosticDeclaration(),
		normalizeGeneratedDeclarationSpacing: () => inst.normalizeGeneratedDeclarationSpacing(),
		dispose: () => fs.rm(root, { recursive: true, force: true }),
	};
}

async function withFixture(run: (fx: Fixture) => Promise<void>, nativeTarget?: string): Promise<void> {
	const before = await realStamps();
	const fx = await loadFixture(nativeTarget);
	try {
		await run(fx);
	} finally {
		await fx.dispose();
		expect(await realStamps()).toEqual(before);
	}
}

function renameError(code: string): Error {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

test("fixtures leave package native entrypoints unchanged", async () => {
	const before = await realStamps();
	expect(before.js.ino).toBeGreaterThan(0);
	expect(before.dts.ino).toBeGreaterThan(0);
	expect(await realStamps()).toEqual(before);
});

test("regular index.d.ts still allows generation", async () => {
	await withFixture(async fx => {
		await fs.writeFile(path.join(fx.native, "index.js"), loader);
		await fs.writeFile(path.join(fx.native, "index.d.ts"), declaration);
		await fx.generateEnumExports();
		const jsOut = await fs.readFile(path.join(fx.native, "index.js"), "utf8");
		expect(jsOut.startsWith("prelude-keep\n")).toBe(true);
		expect(jsOut.endsWith("tail-keep\n")).toBe(true);
		expect(jsOut.includes("export const editFindMatch = nativeBindings.editFindMatch;")).toBe(true);
		expect(jsOut.includes("export const Old = 1;")).toBe(false);
		const dtsOut = await fs.readFile(path.join(fx.native, "index.d.ts"), "utf8");
		expect(dtsOut.includes("export declare enum Color")).toBe(true);
		expect(dtsOut.includes("export const enum")).toBe(false);
		expect((await fs.lstat(path.join(fx.native, "index.js"))).isSymbolicLink()).toBe(false);
		expect((await fs.lstat(path.join(fx.native, "index.d.ts"))).isSymbolicLink()).toBe(false);
	});
});

test.skipIf(!canSymlink)("symlinked parent directory still allows a regular declaration", async () => {
	const real = await fs.mkdtemp(path.join(os.tmpdir(), "native-real-"));
	try {
		await fs.writeFile(path.join(real, "index.js"), loader);
		await fs.writeFile(path.join(real, "index.d.ts"), declaration);
		await withFixture(async fx => {
			await fx.generateEnumExports();
			expect((await fs.lstat(fx.native)).isSymbolicLink()).toBe(true);
			const jsOut = await fs.readFile(path.join(real, "index.js"), "utf8");
			expect(jsOut.includes("export const editFindMatch = nativeBindings.editFindMatch;")).toBe(true);
			expect((await fs.readFile(path.join(real, "index.d.ts"), "utf8")).includes("export declare enum Color")).toBe(
				true,
			);
		}, real);
	} finally {
		await fs.rm(real, { recursive: true, force: true });
	}
});

test.skipIf(!canSymlink)("ensurePublishDiagnosticDeclaration refuses a symlinked declaration", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-secret-"));
		try {
			const secret = path.join(outside, "credential");
			await fs.writeFile(secret, "diagnostic: NativePublishDiagnostic\n", { mode: 0o600 });
			await fs.symlink(secret, path.join(fx.native, "index.d.ts"));
			await expect(fx.ensurePublishDiagnosticDeclaration()).rejects.toThrow(/Refusing to read/);
			expect(await fs.readFile(secret, "utf8")).toBe("diagnostic: NativePublishDiagnostic\n");
			expect((await fs.lstat(path.join(fx.native, "index.d.ts"))).isSymbolicLink()).toBe(true);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink)("symlinked index.d.ts is not published", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-secret-"));
		try {
			const secret = path.join(outside, "credential");
			await fs.writeFile(secret, "SECRET-CREDENTIAL", { mode: 0o600 });
			await fs.writeFile(path.join(fx.native, "index.js"), loader);
			await fs.symlink(secret, path.join(fx.native, "index.d.ts"));
			await expect(fx.generateEnumExports()).rejects.toThrow(/Refusing to read/);
			expect(await fs.readFile(secret, "utf8")).toBe("SECRET-CREDENTIAL");
			expect((await fs.lstat(path.join(fx.native, "index.d.ts"))).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(path.join(fx.native, "index.js"), "utf8")).toBe(loader);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink || process.platform === "win32")(
	"symlinked index.js loader is not read or republished",
	async () => {
		await withFixture(async fx => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-js-"));
			try {
				const jsTarget = path.join(outside, "index.js");
				const jsPath = path.join(fx.native, "index.js");
				const privateLoader = loader.replace("tail-keep", "privateToken='SECRET'");
				await fs.writeFile(jsTarget, privateLoader, { mode: 0o600 });
				await fs.chmod(jsTarget, 0o600);
				await fs.writeFile(path.join(fx.native, "index.d.ts"), declaration);
				await fs.symlink(jsTarget, jsPath);
				await expect(fx.generateEnumExports()).rejects.toThrow(/non-regular index\.js/);
				expect((await fs.lstat(jsPath)).isSymbolicLink()).toBe(true);
				expect(await fs.readFile(jsTarget, "utf8")).toBe(privateLoader);
				expect((await fs.stat(jsTarget)).mode & 0o777).toBe(0o600);
				for (const entry of await fs.readdir(fx.native)) {
					const entryPath = path.join(fx.native, entry);
					if ((await fs.lstat(entryPath)).isFile())
						expect(await fs.readFile(entryPath, "utf8")).not.toContain("SECRET");
				}
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		});
	},
);

test("concurrent cleanup retains a live temporary file and the destination", async () => {
	await withFixture(async fx => {
		const dest = path.join(fx.native, "index.js");
		await fs.writeFile(dest, "old-entrypoint");
		const live = path.join(fx.native, `index.js.tmp.${process.pid}.${crypto.randomUUID()}`);
		const dead = path.join(fx.native, `index.d.ts.tmp.${deadPid()}.${crypto.randomUUID()}`);
		await fs.writeFile(live, "live-temp");
		await fs.writeFile(dead, "stale");
		await fx.cleanupStaleTemps(fx.native);
		expect(await fs.readFile(live, "utf8")).toBe("live-temp");
		expect(await fs.readFile(dest, "utf8")).toBe("old-entrypoint");
		await expect(fs.lstat(dead)).rejects.toThrow();
	});
});

test.skipIf(!canSymlink)("cleanup unlinks a dead symlink temp without changing its target", async () => {
	await withFixture(async fx => {
		const sentinel = path.join(fx.native, "sentinel");
		await fs.writeFile(sentinel, "SAFE");
		const dead = path.join(fx.native, `index.d.ts.tmp.${deadPid()}.${crypto.randomUUID()}`);
		await fs.symlink(sentinel, dead);
		await fx.cleanupStaleTemps(fx.native);
		expect(await fs.readFile(sentinel, "utf8")).toBe("SAFE");
		await expect(fs.lstat(dead)).rejects.toThrow();
	});
});

test("cleanup still allows removal of a dead owner temporary file", async () => {
	await withFixture(async fx => {
		const dest = path.join(fx.native, "index.d.ts");
		await fs.writeFile(dest, "entrypoint");
		const dead = path.join(fx.native, `index.d.ts.tmp.${deadPid()}.${crypto.randomUUID()}`);
		await fs.writeFile(dead, "stale");
		await fx.cleanupStaleTemps(fx.native);
		expect(await fs.readFile(dest, "utf8")).toBe("entrypoint");
		await expect(fs.lstat(dead)).rejects.toThrow();
	});
});

async function expectRenameKeepsLink(
	code: string,
	run: () => Promise<void>,
	link: string,
	target: string,
	original: string,
): Promise<void> {
	const spy = spyOn(fs, "rename").mockImplementation(async () => {
		throw renameError(code);
	});
	try {
		await expect(run()).rejects.toThrow(/left the existing file in place/);
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe(original);
	} finally {
		spy.mockRestore();
	}
}

test("rename failure still updates a regular index in place", async () => {
	await withFixture(async fx => {
		const jsPath = path.join(fx.native, "index.js");
		const dtsPath = path.join(fx.native, "index.d.ts");
		await fs.writeFile(jsPath, loader);
		await fs.writeFile(dtsPath, declaration);
		const jsIno = (await fs.stat(jsPath)).ino;
		const spy = spyOn(fs, "rename").mockImplementation(async () => {
			throw renameError("EIO");
		});
		try {
			await fx.generateEnumExports();
			expect((await fs.readFile(jsPath, "utf8")).includes("export const editFindMatch")).toBe(true);
			expect((await fs.readFile(dtsPath, "utf8")).includes("export declare enum Color")).toBe(true);
			if (process.platform !== "win32") expect((await fs.stat(jsPath)).ino).toBe(jsIno);
		} finally {
			spy.mockRestore();
		}
	});
});

test.skipIf(!canSymlink)("missing temporary file leaves a symlinked declaration in place", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-dts-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const target = path.join(outside, "index.d.ts");
			const dtsPath = path.join(fx.native, "index.d.ts");
			await fs.writeFile(target, "original");
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fs.symlink(target, dtsPath);
			const spy = spyOn(fs, "rename").mockImplementation(async from => {
				await fs.unlink(String(from)).catch(() => {});
				throw renameError("ENOENT");
			});
			try {
				await expect(fx.installGeneratedBindings(outputDir)).rejects.toThrow(/left the existing file in place/);
				expect((await fs.lstat(dtsPath)).isSymbolicLink()).toBe(true);
				expect(await fs.readFile(target, "utf8")).toBe("original");
			} finally {
				spy.mockRestore();
			}
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test("install updates a regular index.d.ts and creates a missing one", async () => {
	await withFixture(async fx => {
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
		try {
			const dest = path.join(fx.native, "index.d.ts");
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fs.writeFile(dest, "old-bindings");
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(dest, "utf8")).toBe("new-bindings");
			await fs.unlink(dest);
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(dest, "utf8")).toBe("new-bindings");
			expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
		} finally {
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink)("rename EIO leaves a symlinked declaration in place", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const target = path.join(outside, "index.d.ts");
			const dest = path.join(fx.native, "index.d.ts");
			await fs.writeFile(target, "old-entrypoint");
			await fs.symlink(target, dest);
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await expectRenameKeepsLink(
				"EIO",
				() => fx.installGeneratedBindings(outputDir),
				dest,
				target,
				"old-entrypoint",
			);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink)("rename EACCES leaves a symlinked declaration in place", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const target = path.join(outside, "index.d.ts");
			const dest = path.join(fx.native, "index.d.ts");
			await fs.writeFile(target, "old-entrypoint");
			await fs.symlink(target, dest);
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await expectRenameKeepsLink(
				"EACCES",
				() => fx.installGeneratedBindings(outputDir),
				dest,
				target,
				"old-entrypoint",
			);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

const controllerSpacing =
	"export declare class ComputerController {\n  x: number\n}\n/**\n * Long-lived macOS appearance observer.\n */\n";

test("regular declaration spacing still allows the observer gap", async () => {
	await withFixture(async fx => {
		const dts = path.join(fx.native, "index.d.ts");
		await fs.writeFile(dts, controllerSpacing);
		await fx.normalizeGeneratedDeclarationSpacing();
		expect(await fs.readFile(dts, "utf8")).toContain("}\n\n/**\n * Long-lived macOS appearance observer.");
		expect((await fs.lstat(dts)).isSymbolicLink()).toBe(false);
	});
});

test.skipIf(!canSymlink)("declaration spacing refuses a symlinked index.d.ts", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-space-"));
		try {
			const target = path.join(outside, "secret.d.ts");
			await fs.writeFile(target, controllerSpacing);
			await fs.symlink(target, path.join(fx.native, "index.d.ts"));
			await expect(fx.normalizeGeneratedDeclarationSpacing()).rejects.toThrow(/Refusing to read/);
			expect(await fs.readFile(target, "utf8")).toBe(controllerSpacing);
			expect((await fs.lstat(path.join(fx.native, "index.d.ts"))).isSymbolicLink()).toBe(true);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

test("install preserves a 0600 regular declaration inode and mode", async () => {
	await withFixture(async fx => {
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const src = path.join(outputDir, "index.d.ts");
			const dest = path.join(fx.native, "index.d.ts");
			await fs.writeFile(src, "new-bindings");
			await fs.chmod(src, 0o644);
			await fs.writeFile(dest, "old-bindings");
			await fs.chmod(dest, 0o600);
			const before = await fs.stat(dest);
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(dest, "utf8")).toBe("new-bindings");
			if (process.platform !== "win32") {
				const after = await fs.stat(dest);
				expect(after.mode & 0o777).toBe(0o600);
				expect(after.ino).toBe(before.ino);
			}
		} finally {
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink)("install replaces a symlinked index.d.ts without changing its target", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const target = path.join(outside, "secret.d.ts");
			await fs.writeFile(target, "SECRET");
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fs.symlink(target, path.join(fx.native, "index.d.ts"));
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(target, "utf8")).toBe("SECRET");
			const st = await fs.lstat(path.join(fx.native, "index.d.ts"));
			expect(st.isSymbolicLink()).toBe(false);
			expect(await fs.readFile(path.join(fx.native, "index.d.ts"), "utf8")).toBe("new-bindings");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test.skipIf(!canSymlink)("install ignores a symlink at the old predictable temporary name", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const sentinel = path.join(outside, "sentinel");
			const planted = path.join(fx.native, `index.d.ts.tmp.${process.pid}`);
			await fs.writeFile(sentinel, "SECRET");
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fs.writeFile(path.join(fx.native, "index.d.ts"), "old-bindings");
			await fs.symlink(sentinel, planted);
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(sentinel, "utf8")).toBe("SECRET");
			expect((await fs.lstat(planted)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(path.join(fx.native, "index.d.ts"), "utf8")).toBe("new-bindings");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test.skipIf(process.platform === "win32")(
	"a missing index is created as a regular 0644 file without a temp or rename",
	async () => {
		await withFixture(async fx => {
			const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-out-"));
			const previousUmask = process.umask(0o022);
			const rename = spyOn(fs, "rename");
			try {
				await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
				const dest = path.join(fx.native, "index.d.ts");
				await fx.installGeneratedBindings(outputDir);
				const created = await fs.lstat(dest);
				expect(created.isFile()).toBe(true);
				expect(created.mode & 0o777).toBe(0o644);
				expect(await fs.readFile(dest, "utf8")).toBe("new-bindings");
				expect(rename).not.toHaveBeenCalled();
				expect((await fs.readdir(fx.native)).filter(entry => entry.includes(".tmp."))).toEqual([]);
			} finally {
				rename.mockRestore();
				process.umask(previousUmask);
				await fs.rm(outputDir, { recursive: true, force: true });
			}
		});
	},
);

test("overlapping installs leave one regular declaration", async () => {
	await withFixture(async fx => {
		const outputA = await fs.mkdtemp(path.join(os.tmpdir(), "native-a-"));
		const outputB = await fs.mkdtemp(path.join(os.tmpdir(), "native-b-"));
		try {
			await fs.writeFile(path.join(outputA, "index.d.ts"), "bindings-a");
			await fs.writeFile(path.join(outputB, "index.d.ts"), "bindings-b");
			await fs.writeFile(path.join(fx.native, "index.d.ts"), "old-bindings");
			await Promise.all([fx.installGeneratedBindings(outputA), fx.installGeneratedBindings(outputB)]);
			expect(["bindings-a", "bindings-b"]).toContain(await fs.readFile(path.join(fx.native, "index.d.ts"), "utf8"));
			expect((await fs.lstat(path.join(fx.native, "index.d.ts"))).isSymbolicLink()).toBe(false);
		} finally {
			await fs.rm(outputA, { recursive: true, force: true });
			await fs.rm(outputB, { recursive: true, force: true });
		}
	});
});

test.skipIf(process.platform === "win32")("install updates a hard-linked declaration on the same inode", async () => {
	await withFixture(async fx => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-link-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
		try {
			const dest = path.join(fx.native, "index.d.ts");
			const other = path.join(outside, "linked.d.ts");
			await fs.writeFile(dest, "old-bindings");
			await fs.link(dest, other);
			const before = await fs.stat(dest);
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fx.installGeneratedBindings(outputDir);
			expect(await fs.readFile(dest, "utf8")).toBe("new-bindings");
			expect(await fs.readFile(other, "utf8")).toBe("new-bindings");
			expect((await fs.stat(dest)).ino).toBe(before.ino);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	});
});

test("installBinary keeps the existing addon when rename fails off Windows", async () => {
	await withFixture(async fx => {
		const src = path.join(fx.native, "built.node");
		const dest = path.join(fx.native, "addon.node");
		await fs.writeFile(src, "new-addon");
		await fs.writeFile(dest, "old-addon");
		const spy = spyOn(fs, "rename").mockImplementation(async () => {
			throw renameError("EIO");
		});
		try {
			await expect(fx.installBinary(src, dest)).rejects.toThrow(/left the existing file in place/);
			expect(await fs.readFile(dest, "utf8")).toBe("old-addon");
		} finally {
			spy.mockRestore();
		}
	});
});

test("installBinary still replaces the addon after a Windows EPERM or EBUSY rename", async () => {
	for (const code of ["EPERM", "EBUSY"]) {
		await withFixture(async fx => {
			const src = path.join(fx.native, "built.node");
			const dest = path.join(fx.native, "addon.node");
			await fs.writeFile(src, "new-addon");
			await fs.writeFile(dest, "old-addon");
			const realRename = fs.rename.bind(fs);
			let calls = 0;
			const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (calls++ === 0) throw renameError(code);
				return realRename(from, to);
			});
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			try {
				await fx.installBinary(src, dest);
			} finally {
				Object.defineProperty(process, "platform", platform);
				spy.mockRestore();
			}
			expect(calls).toBe(2);
			expect(await fs.readFile(dest, "utf8")).toBe("new-addon");
			expect((await fs.readdir(fx.native)).filter(entry => entry.includes(".tmp."))).toEqual([]);
		});
	}
});

test.skipIf(!canSymlink || process.platform === "win32")(
	"install refuses a declaration whose parent directory is swapped after the check",
	async () => {
		await withFixture(async fx => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-swap-"));
			const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-src-"));
			try {
				const victim = path.join(outside, "index.d.ts");
				const dest = path.join(fx.native, "index.d.ts");
				await fs.writeFile(victim, "PRIVATE");
				await fs.writeFile(dest, "old-bindings");
				await fs.writeFile(path.join(outputDir, "index.d.ts"), "generated");
				const realOpen = fs.open.bind(fs);
				let swapped = false;
				const spy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
					if (!swapped && String(file) === dest) {
						swapped = true;
						await fs.rename(fx.native, `${fx.native}.moved`);
						await fs.symlink(outside, fx.native);
					}
					return realOpen(file, flags, mode);
				});
				try {
					await expect(fx.installGeneratedBindings(outputDir)).rejects.toThrow(/changed after it was checked/);
				} finally {
					spy.mockRestore();
				}
				expect(swapped).toBe(true);
				expect(await fs.readFile(victim, "utf8")).toBe("PRIVATE");
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
				await fs.rm(outputDir, { recursive: true, force: true });
			}
		});
	},
);

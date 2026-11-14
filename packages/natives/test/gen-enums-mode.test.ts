import { expect, test } from "bun:test";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const START = "// --- generated native exports (do not edit) ---";
const END = "// --- end generated native exports ---";
const loader = `prelude-keep\n${START}\nexport const Old = 1;\n${END}\ntail-keep\n`;
const declaration =
	'export declare const enum Color {\n\tRed = "red",\n}\nexport declare function editFindMatch(): void\n';

type Gen = {
	generateEnumExports: (root?: string) => Promise<void>;
	writeReplacingDestination?: (dest: string, contents: string) => Promise<void>;
};

function freshMode(): number {
	const umask = process.umask();
	process.umask(umask);
	return 0o644 & ~umask & 0o777;
}

function canSymlink(): boolean {
	const dir = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-link-probe-"));
	try {
		fssync.symlinkSync("target", path.join(dir, "link"));
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES") throw err;
		return false;
	} finally {
		fssync.rmSync(dir, { recursive: true, force: true });
	}
}

async function importCopy(root: string): Promise<Gen> {
	const scripts = path.join(root, "scripts");
	fssync.mkdirSync(scripts);
	fssync.copyFileSync(path.join(import.meta.dir, "../scripts/gen-enums.ts"), path.join(scripts, "gen-enums.ts"));
	return import(pathToFileURL(path.join(scripts, "gen-enums.ts")).href);
}

test("generateEnumExports keeps regular index.js and index.d.ts modes", async () => {
	for (const mode of [0o600, 0o640, 0o644] as const) {
		const root = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-mode-"));
		try {
			const native = path.join(root, "native");
			fssync.mkdirSync(native);
			const js = path.join(native, "index.js");
			const dts = path.join(native, "index.d.ts");
			fssync.writeFileSync(js, loader);
			fssync.writeFileSync(dts, declaration);
			fssync.chmodSync(js, mode);
			fssync.chmodSync(dts, mode);
			const jsIno = fssync.statSync(js).ino;
			const dtsIno = fssync.statSync(dts).ino;
			await (await importCopy(root)).generateEnumExports();
			expect(fssync.readFileSync(js, "utf8").includes("export const editFindMatch")).toBe(true);
			expect(fssync.readFileSync(dts, "utf8").includes("export declare enum Color")).toBe(true);
			if (process.platform !== "win32") {
				expect(fssync.statSync(js).mode & 0o777).toBe(mode);
				expect(fssync.statSync(dts).mode & 0o777).toBe(mode);
				expect(fssync.statSync(js).ino).toBe(jsIno);
				expect(fssync.statSync(dts).ino).toBe(dtsIno);
			}
		} finally {
			fssync.rmSync(root, { recursive: true, force: true });
		}
	}
});

let extraGid: number | undefined;
let ownerUid = 0;
const listGroups = process.getgroups;
const primaryGid = process.getgid;
const currentUid = process.getuid;
if (process.platform !== "win32" && listGroups && primaryGid && currentUid) {
	const extra = listGroups().find(gid => gid !== primaryGid());
	const uid = currentUid();
	if (extra !== undefined) {
		const probe = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-gid-"));
		try {
			const file = path.join(probe, "f");
			fssync.writeFileSync(file, "x");
			fssync.chownSync(file, uid, extra);
			if (fssync.statSync(file).gid === extra) {
				extraGid = extra;
				ownerUid = uid;
			}
		} catch {
			extraGid = undefined;
		} finally {
			fssync.rmSync(probe, { recursive: true, force: true });
		}
	}
}

test.skipIf(extraGid === undefined)("generateEnumExports keeps a supplementary group on 0640 indexes", async () => {
	const root = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-gid-"));
	try {
		const native = path.join(root, "native");
		fssync.mkdirSync(native);
		const js = path.join(native, "index.js");
		const dts = path.join(native, "index.d.ts");
		fssync.writeFileSync(js, loader);
		fssync.writeFileSync(dts, declaration);
		fssync.chmodSync(js, 0o640);
		fssync.chmodSync(dts, 0o640);
		const gid = extraGid ?? 0;
		fssync.chownSync(js, ownerUid, gid);
		fssync.chownSync(dts, ownerUid, gid);
		const jsIno = fssync.statSync(js).ino;
		const dtsIno = fssync.statSync(dts).ino;
		await (await importCopy(root)).generateEnumExports();
		expect(fssync.readFileSync(js, "utf8").includes("export const editFindMatch")).toBe(true);
		expect(fssync.statSync(js).gid).toBe(gid);
		expect(fssync.statSync(dts).gid).toBe(gid);
		expect(fssync.statSync(js).ino).toBe(jsIno);
		expect(fssync.statSync(dts).ino).toBe(dtsIno);
		expect(fssync.statSync(js).mode & 0o777).toBe(0o640);
		expect(fssync.statSync(dts).mode & 0o777).toBe(0o640);
	} finally {
		fssync.rmSync(root, { recursive: true, force: true });
	}
});

test("new destination is created mode 0644 subject to umask", async () => {
	const root = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-fresh-"));
	try {
		const write = (await importCopy(root)).writeReplacingDestination;
		expect(typeof write).toBe("function");
		const created = path.join(root, "index.js");
		await write!(created, "new");
		expect(fssync.readFileSync(created, "utf8")).toBe("new");
		if (process.platform !== "win32") expect(fssync.statSync(created).mode & 0o777).toBe(freshMode());
	} finally {
		fssync.rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(!canSymlink())("replaced symlink destination is not followed", async () => {
	const root = fssync.mkdtempSync(path.join(os.tmpdir(), "gen-sym-"));
	try {
		const write = (await importCopy(root)).writeReplacingDestination;
		expect(typeof write).toBe("function");
		const target = path.join(root, "secret");
		fssync.writeFileSync(target, "secret", { mode: 0o644 });
		fssync.chmodSync(target, 0o644);
		const link = path.join(root, "index.js");
		fssync.symlinkSync(target, link);
		await write!(link, "replaced");
		expect(fssync.lstatSync(link).isSymbolicLink()).toBe(false);
		expect(fssync.readFileSync(link, "utf8")).toBe("replaced");
		expect(fssync.readFileSync(target, "utf8")).toBe("secret");
		if (process.platform !== "win32") {
			expect(fssync.statSync(target).mode & 0o777).toBe(0o644);
			expect(fssync.statSync(link).mode & 0o777).toBe(freshMode());
		}
	} finally {
		fssync.rmSync(root, { recursive: true, force: true });
	}
});

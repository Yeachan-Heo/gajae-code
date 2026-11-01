import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import { openInEditor } from "../../src/utils/external-editor";

const tempDirs: string[] = [];
const plantedLinks: string[] = [];
const quietFds: number[] = [];

function quietStdio(): [number, number, number] {
	const devnull = process.platform === "win32" ? "NUL" : "/dev/null";
	const stdin = fs.openSync(devnull, "r");
	const stdout = fs.openSync(devnull, "w");
	quietFds.push(stdin, stdout);
	return [stdin, stdout, stdout];
}

function canSymlink(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-editor-link-probe-"));
	const target = path.join(dir, "target");
	const link = path.join(dir, "link");
	fs.writeFileSync(target, "x");
	try {
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const link of plantedLinks.splice(0)) {
		try {
			if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
		} catch {
			// The writer may already have removed the planted link.
		}
	}
	delete process.env.EDITOR_RESULT;
	for (const fd of quietFds.splice(0)) {
		try {
			fs.closeSync(fd);
		} catch {
			// Already closed with the child.
		}
	}
});

function makeDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-editor-temp-"));
	tempDirs.push(dir);
	return dir;
}

function editorCommand(dir: string, source: string): string {
	const script = path.join(dir, "editor.mjs");
	fs.writeFileSync(script, source);
	return `${process.execPath} ${script}`;
}

const recordingEditor = `
import * as fs from "node:fs";
const target = process.argv.at(-1);
const out = process.env.EDITOR_RESULT;
if (!target || !out) process.exit(2);
const st = fs.lstatSync(target);
fs.writeFileSync(out, JSON.stringify({
	path: target,
	symlink: st.isSymbolicLink(),
	mode: st.mode & 0o777,
}));
fs.writeFileSync(target, "EDITED\\n");
process.exit(0);
`;

function checked(name: string, fn: () => Promise<void>): void {
	it(name, async () => {
		try {
			await fn();
		} catch (error) {
			console.log(`(fail) ${name}`);
			throw error;
		}
		console.log(`(pass) ${name}`);
	});
}

describe("openInEditor temp file", () => {
	checked("keeps an editor rewrite and the requested extension", async () => {
		const dir = makeDir();
		const resultPath = path.join(dir, "result.json");
		process.env.EDITOR_RESULT = resultPath;
		const result = await openInEditor(editorCommand(dir, recordingEditor), "ORIGINAL\n", {
			extension: ".todo.md",
			stdio: quietStdio(),
		});
		expect(result).toBe("EDITED");
		const recorded = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { path: string };
		expect(recorded.path.endsWith(".todo.md")).toBe(true);
	});

	checked("keeps a null result when the editor exits non-zero", async () => {
		const dir = makeDir();
		const result = await openInEditor(editorCommand(dir, "process.exit(3);\n"), "ORIGINAL\n", {
			stdio: quietStdio(),
		});
		expect(result).toBeNull();
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		checked("does not follow a preexisting symlink at the predictable temp name", async () => {
			const dir = makeDir();
			const victim = path.join(dir, "victim");
			fs.writeFileSync(victim, "SAFE");
			const resultPath = path.join(dir, "result.json");
			process.env.EDITOR_RESULT = resultPath;
			const editor = editorCommand(dir, recordingEditor);
			const now = Date.now;
			const fixed = 1_700_000_000_000;
			Date.now = () => fixed;
			try {
				const observed = Snowflake.next();
				const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
				const id = Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
				const linkPath = path.join(os.tmpdir(), `gjc-editor-${id}.md`);
				plantedLinks.push(linkPath);
				try {
					fs.unlinkSync(linkPath);
				} catch {
					// No prior file at the predicted name.
				}
				fs.symlinkSync(victim, linkPath);
				const result = await openInEditor(editor, "ORIGINAL\n", {
					stdio: quietStdio(),
				});
				expect(result).toBe("EDITED");
				expect(fs.readFileSync(victim, "utf8")).toBe("SAFE");
				const recorded = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
					path: string;
					symlink: boolean;
					mode: number;
				};
				expect(recorded.symlink).toBe(false);
				expect(recorded.path).not.toBe(linkPath);
				expect(recorded.mode & 0o077).toBe(0);
			} finally {
				Date.now = now;
			}
		});
});

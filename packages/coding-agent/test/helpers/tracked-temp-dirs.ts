import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { TempDir } from "@gajae-code/utils";

export interface TrackedTempDirs {
	mkdtemp(prefix: string): Promise<string>;
	mkdtempSync(prefix: string): string;
	/** `TempDir.createSync` whose directory is also removed at file end. */
	tempDirSync(prefix: string): TempDir;
}

/**
 * `mkdtemp`/`mkdtempSync`/`TempDir.createSync` stand-ins that remove every
 * directory they created when the calling test file finishes.
 *
 * Call once at the top level of a test file. The `mkdtemp` pair takes the same
 * full prefix as its `node:fs` counterpart; `tempDirSync` takes a `TempDir`
 * prefix. The end-of-file removal also catches a directory that a writer which
 * outlived its test recreated after the test's own cleanup removed it.
 *
 * Unlike {@link createTempDirRegistry}, this writes nothing into the
 * directories, so fixtures that list their own contents are unaffected.
 */
export function trackTempDirs(): TrackedTempDirs {
	const created: string[] = [];
	afterAll(() => {
		for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	return {
		async mkdtemp(prefix) {
			const dir = await fsp.mkdtemp(prefix);
			created.push(dir);
			return dir;
		},
		mkdtempSync(prefix) {
			const dir = fs.mkdtempSync(prefix);
			created.push(dir);
			return dir;
		},
		tempDirSync(prefix) {
			const dir = TempDir.createSync(prefix);
			created.push(dir.path());
			return dir;
		},
	};
}

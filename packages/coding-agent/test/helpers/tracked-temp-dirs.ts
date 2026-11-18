import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * `mkdtemp`/`mkdtempSync` stand-ins that remove every directory they created
 * when the calling test file finishes.
 *
 * Call once at the top level of a test file. Both functions take the same full
 * prefix as their `node:fs` counterparts.
 *
 * Unlike {@link createTempDirRegistry}, this writes nothing into the
 * directories, so fixtures that list their own contents are unaffected. Use the
 * registry instead when a lazy writer can recreate a directory after teardown.
 */
export function trackTempDirs(): { mkdtemp(prefix: string): Promise<string>; mkdtempSync(prefix: string): string } {
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
	};
}

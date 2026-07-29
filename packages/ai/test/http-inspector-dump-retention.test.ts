import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneHttpRequestDumps } from "@gajae-code/ai/utils/http-inspector";

/**
 * Every HTTP 400 wrote a dump of the full sanitized request body and nothing ever
 * removed one. A developer machine reached 27,249 files totalling 7.0 GB,
 * averaging 264 KB each — 96% of everything under `~/.gjc`.
 *
 * The rotating application log already bounds itself (`maxSize: 10m`,
 * `maxFiles: 5`); these diagnostics now do too.
 */

const MAX_RETAINED = 50;
const tempDirs: string[] = [];

function dumpDirWith(count: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-http400-retention-"));
	tempDirs.push(dir);
	for (let i = 0; i < count; i++) {
		// Real writer format: `${Date.now()}-${hash}.json`, zero-padded here so the
		// lexical order the pruner relies on matches creation order deterministically.
		fs.writeFileSync(path.join(dir, `${String(1_700_000_000_000 + i).padStart(13, "0")}-h${i}.json`), "{}\n");
	}
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("HTTP 400 dump retention", () => {
	it("keeps everything while under the cap", async () => {
		const dir = dumpDirWith(MAX_RETAINED);
		expect(await pruneHttpRequestDumps(dir)).toBe(0);
		expect(fs.readdirSync(dir)).toHaveLength(MAX_RETAINED);
	});

	it("trims to the cap and keeps the newest dumps", async () => {
		const dir = dumpDirWith(MAX_RETAINED + 20);
		expect(await pruneHttpRequestDumps(dir)).toBe(20);

		const remaining = fs.readdirSync(dir).sort();
		expect(remaining).toHaveLength(MAX_RETAINED);
		// The 20 oldest are the ones that went.
		expect(remaining[0]).toContain("-h20.json");
		expect(remaining.at(-1)).toContain(`-h${MAX_RETAINED + 19}.json`);
	});

	it("leaves unrelated files alone", async () => {
		const dir = dumpDirWith(MAX_RETAINED + 5);
		fs.writeFileSync(path.join(dir, "README.txt"), "not a dump");
		await pruneHttpRequestDumps(dir);
		expect(fs.existsSync(path.join(dir, "README.txt"))).toBe(true);
	});

	it("is a no-op on a missing directory rather than throwing", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-http400-absent-"));
		fs.rmSync(dir, { recursive: true, force: true });
		expect(await pruneHttpRequestDumps(dir)).toBe(0);
	});
});

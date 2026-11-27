import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeRmSync } from "../../../../scripts/safe-cleanup";
import { FileSessionStorage } from "../../src/session/session-storage";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) safeRmSync(directory, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// Clean up through the spelling under os.tmpdir(): the native realpath expands an 8.3
	// short name (C:\Users\RUNNER~1) that safe cleanup does not recognise as the temp root.
	directories.push(created);
	return fs.realpathSync.native(created);
}

/** True when `directory` resolves a case alias of an entry to that entry (the Windows default). */
function isCaseInsensitive(directory: string): boolean {
	const probe = path.join(directory, "case-probe");
	fs.writeFileSync(probe, "");
	try {
		return fs.existsSync(path.join(directory, "CASE-PROBE"));
	} finally {
		fs.rmSync(probe);
	}
}

describe("append-lock identity of case-aliased transcripts", () => {
	it.skipIf(process.platform !== "win32")("gives case aliases of one transcript the same append lock", () => {
		vi.spyOn(os, "homedir").mockReturnValue(makeTempDir("gjc-case-alias-home-"));
		const sessions = makeTempDir("gjc-case-alias-session-");
		if (!isCaseInsensitive(sessions)) return;
		const storage = new FileSessionStorage();
		const lockPaths: string[] = [];
		const appendLock = (lockPath: string) => {
			lockPaths.push(lockPath);
			return storage.acquireExclusiveLockSync(lockPath);
		};
		// The first spelling creates the file; the later ones resolve to its on-disk name.
		for (const name of ["Session.jsonl", "session.jsonl", "SESSION.JSONL"]) {
			const writer = storage.openWriter(path.join(sessions, name), { flags: "a", appendLock });
			writer.writeLineSync(`${name}\n`);
			writer.closeSync();
		}
		expect(lockPaths).toHaveLength(3);
		expect(new Set(lockPaths).size).toBe(1);
		expect(fs.readFileSync(path.join(sessions, "Session.jsonl"), "utf8")).toBe(
			"Session.jsonl\nsession.jsonl\nSESSION.JSONL\n",
		);
	});
});

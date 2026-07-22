import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalizeTrustedPath } from "../../src/session/internal/managed-session-scope";

const testRoots: string[] = [];

afterEach(async () => {
	for (const root of testRoots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("Windows trusted storage canonicalization", () => {
	it("keeps a missing resident-cache tail writable through Bun", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-windows-canonical-"));
		testRoots.push(root);
		const missingTail = path.join(root, "sessions", "resident-cache", "instance", "blob");
		const canonical = canonicalizeTrustedPath(missingTail);

		expect(canonical).toMatch(/^[A-Za-z]:\\/);
		expect(canonical).not.toStartWith("\\\\?\\Volume{");
		await Bun.write(canonical, "resident-cache-ok");
		expect(await Bun.file(canonical).text()).toBe("resident-cache-ok");
	});

	it("keeps the resident-cache blob write mechanism working through node:fs", async () => {
		// Reproduces the exact operation that broke on Windows: `EphemeralBlobStore.putSync`
		// runs `fs.mkdirSync(dir, { recursive: true })` then `fs.writeFileSync(blobPath, data)`.
		// Bun's node:fs `writeFileSync`/`readFileSync` fail with ENOENT on the native
		// `\\?\Volume{GUID}\...` identity path even though `mkdirSync` succeeds, so a resident
		// blob write on that path drops the entry mid-turn/compaction. The canonicalized DOS
		// path must round-trip the same synchronous write and read.
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-windows-canonical-fs-"));
		testRoots.push(root);
		const residentDir = path.join(root, "sessions", "sess-id", "resident-cache", "sess-id-1234-1");
		const canonicalDir = canonicalizeTrustedPath(residentDir);

		expect(canonicalDir).toMatch(/^[A-Za-z]:\\/);
		expect(canonicalDir).not.toStartWith("\\\\?\\Volume{");

		const blobPath = path.join(canonicalDir, "blobhash");
		fs.mkdirSync(canonicalDir, { recursive: true });
		fs.writeFileSync(blobPath, "resident-blob-ok");
		expect(fs.readFileSync(blobPath, "utf8")).toBe("resident-blob-ok");
	});
});

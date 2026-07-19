import { afterEach, describe, expect, it } from "bun:test";
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
});

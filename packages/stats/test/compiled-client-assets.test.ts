import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCompiledClientAssetHandler } from "../src/compiled-client-assets";

async function archiveBytes(entries: Record<string, string>): Promise<Uint8Array> {
	return await new Bun.Archive(entries, { compress: "gzip" }).bytes();
}

describe("compiled stats client assets", () => {
	it("serves trusted assets from memory with MIME types and SPA routing", async () => {
		const bytes = await archiveBytes({
			"index.html": "<main>dashboard</main>",
			"index.js": "export const ready = true;",
			"styles.css": "main { display: block; }",
			"asset.data": "opaque",
		});
		const handler = createCompiledClientAssetHandler(() => bytes);

		const html = await handler.response("/");
		expect(html.status).toBe(200);
		expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await html.text()).toBe("<main>dashboard</main>");
		expect((await handler.response("/index.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect((await handler.response("/styles.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect((await handler.response("/asset.data")).headers.get("content-type")).toBe("application/octet-stream");
		expect(await (await handler.response("/requests/42")).text()).toBe("<main>dashboard</main>");
		expect(await (await handler.response("/missing.js")).text()).toBe("<main>dashboard</main>");
	});

	it("fails closed for unsafe, duplicate, or incomplete archives", async () => {
		for (const unsafeName of [
			"/absolute.js",
			"C:/absolute.js",
			"assets\\app.js",
			"../escape.js",
			"assets/./app.js",
			"assets//app.js",
			"encoded%2fpath.js",
			"control\u0001.js",
		]) {
			const handler = createCompiledClientAssetHandler(() =>
				archiveBytes({ "index.html": "ok", [unsafeName]: "unsafe" }),
			);
			await expect(handler.response("/")).rejects.toThrow("Unsafe compiled stats client archive entry");
		}

		const duplicateAlias = createCompiledClientAssetHandler(() =>
			archiveBytes({ "index.html": "one", "./index.html": "two" }),
		);
		await expect(duplicateAlias.response("/")).rejects.toThrow("Unsafe compiled stats client archive entry");

		const missingIndex = createCompiledClientAssetHandler(() => archiveBytes({ "index.js": "missing html" }));
		await expect(missingIndex.response("/")).rejects.toThrow("missing index.html");
	});

	it("coalesces concurrent initialization and retries after rejection", async () => {
		const bytes = await archiveBytes({ "index.html": "ready" });
		const gate = Promise.withResolvers<void>();
		let loads = 0;
		const concurrent = createCompiledClientAssetHandler(async () => {
			loads += 1;
			await gate.promise;
			return bytes;
		});
		const first = concurrent.response("/");
		const second = concurrent.response("/route");
		expect(loads).toBe(1);
		gate.resolve();
		expect(
			await Promise.all([first.then(response => response.text()), second.then(response => response.text())]),
		).toEqual(["ready", "ready"]);

		let attempts = 0;
		const retrying = createCompiledClientAssetHandler(() => {
			attempts += 1;
			return attempts === 1 ? null : bytes;
		});
		await expect(retrying.response("/")).rejects.toThrow("bundle missing");
		expect(await (await retrying.response("/")).text()).toBe("ready");
		expect(attempts).toBe(2);
	});

	it("never references or mutates a legacy deterministic cache path", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-stats-assets-test-"));
		try {
			const legacyTarget = path.join(tempRoot, "legacy-target");
			const legacyPath = path.join(tempRoot, "gjc-stats-client");
			await fs.mkdir(legacyTarget);
			await Bun.write(path.join(legacyTarget, "sentinel"), "untouched");
			await fs.symlink(legacyTarget, legacyPath, "dir");
			const handler = createCompiledClientAssetHandler(() => archiveBytes({ "index.html": "memory only" }));

			expect(await (await handler.response("/")).text()).toBe("memory only");
			expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
			expect(await Bun.file(path.join(legacyTarget, "sentinel")).text()).toBe("untouched");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});

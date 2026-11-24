import { describe, expect, it } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportFromFile } from "../../src/export/html";
import { createHtmlExportTempFile } from "../../src/export/html/html-export-destination";

const TRANSCRIPT = `${JSON.stringify({ type: "session", version: 5, id: "mode", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/cwd" })}\n`;

describe("HTML export file mode", () => {
	it("writes into an owner-only temp file beside the output", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(path.join(tmpdir(), "html-export-mode-"));
		try {
			const temp = createHtmlExportTempFile(path.join(dir, "new.html"));
			closeSync(temp.fd);
			expect(path.dirname(temp.path)).toBe(dir);
			expect((await stat(temp.path)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("replaces a world-readable output with an owner-only export and leaves no temp file", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(path.join(tmpdir(), "html-export-mode-"));
		try {
			const sessionFile = path.join(dir, "session.jsonl");
			await writeFile(sessionFile, TRANSCRIPT, { mode: 0o600 });
			const existing = path.join(dir, "old.html");
			await writeFile(existing, "previous export");
			await chmod(existing, 0o666);

			await exportFromFile(sessionFile, { outputPath: existing });

			expect((await stat(existing)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(existing).text()).toContain('<script id="session-data"');
			expect((await readdir(dir)).sort()).toEqual(["old.html", "session.jsonl"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

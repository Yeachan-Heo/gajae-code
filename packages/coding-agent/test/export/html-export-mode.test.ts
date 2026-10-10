import { describe, expect, it } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openHtmlExportDestination } from "../../src/export/html/html-export-destination";

describe("HTML export file mode", () => {
	it("creates an owner-only file and removes other users' access from an existing one", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(path.join(tmpdir(), "html-export-mode-"));
		try {
			const created = path.join(dir, "new.html");
			closeSync(openHtmlExportDestination(created));
			expect((await stat(created)).mode & 0o777).toBe(0o600);

			const existing = path.join(dir, "old.html");
			await writeFile(existing, "transcript");
			await chmod(existing, 0o666);
			closeSync(openHtmlExportDestination(existing));
			expect((await stat(existing)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(existing).text()).toBe("transcript");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

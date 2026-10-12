import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test("concurrent docs generation publishes a complete index without temporary files", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-docs-generation-"));
	roots.push(root);
	const script = path.join(root, "packages/coding-agent/scripts/generate-docs-index.ts");
	const source = path.join(import.meta.dir, "../packages/coding-agent/scripts/generate-docs-index.ts");
	await Bun.write(script, await Bun.file(source).text());
	await Bun.write(path.join(root, "docs/guide.md"), "# Guide\n");
	await Bun.write(path.join(root, "docs/tools/python.md"), "# Python\n");

	await Promise.all(
		Array.from({ length: 5 }, async () => {
			const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode, stderr).toBe(0);
		}),
	);

	const outputDir = path.join(root, "packages/coding-agent/src/internal-urls");
	const output = await Bun.file(path.join(outputDir, "docs-index.generated.ts")).text();
	expect(output).toContain('export const EMBEDDED_DOC_FILENAMES: readonly string[] = ["guide.md","tools/python.md"];');
	expect(output).toContain('"guide.md": "# Guide\\n",');
	expect(output).toContain('"tools/python.md": "# Python\\n",');
	expect(await fs.readdir(outputDir)).toEqual(["docs-index.generated.ts"]);
});

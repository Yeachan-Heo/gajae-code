import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getIndentation } from "../src/tab-spacing";

async function config(content: string, fn: (root: string) => void | Promise<void>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "c05-"));
	try {
		await fs.writeFile(path.join(root, ".editorconfig"), `root=true\n${content}\n`);
		await fn(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
describe("EditorConfig display property resolution", () => {
	it("explicit tab_width controls visible columns", async () => {
		await config("[*]\nindent_size=2\ntab_width=8", root => {
			expect(getIndentation(path.join(root, "x.ts"))).toBe(8);
		});
	});
	it("unset removes earlier indent_size while preserving separate explicit tab_width", async () => {
		await config("[*]\nindent_size=2\ntab_width=8\n[*.ts]\nindent_size=unset", root => {
			expect(getIndentation("x.ts", root)).toBe(8);
		});
	});
	it("unset removes earlier tab_width and falls back to default", async () => {
		await config("[*]\ntab_width=8\n[*.ts]\ntab_width=unset", root => {
			expect(getIndentation("x.ts", root)).toBe(3);
		});
	});
	it("unset in nested editorconfig removes inherited size", async () => {
		await config("[*]\nindent_size=8", async root => {
			await fs.mkdir(path.join(root, "nested"));
			await fs.writeFile(path.join(root, "nested", ".editorconfig"), "[*.ts]\nindent_size=unset\n");
			expect(getIndentation("nested/x.ts", root)).toBe(3);
		});
	});
	it("ordinary indent_size without explicit width stays supported", async () => {
		await config("[*]\nindent_size=4", root => {
			expect(getIndentation("x.ts", root)).toBe(4);
		});
	});

	it("unset tab_width falls back to a remaining numeric indent_size", async () => {
		await config("[*]\nindent_size=4\ntab_width=8\n[*.ts]\ntab_width=unset", root => {
			expect(getIndentation("x.ts", root)).toBe(4);
		});
	});
	it("indent_size=tab uses explicit width or the default", async () => {
		await config("[*]\nindent_size=tab\ntab_width=6", root => expect(getIndentation("x.ts", root)).toBe(6));
		await config("[*]\nindent_size=tab", root => expect(getIndentation("x.ts", root)).toBe(3));
	});
});

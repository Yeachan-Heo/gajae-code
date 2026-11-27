import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceTabs } from "../src/utils";

it("expands file tabs using explicit EditorConfig tab_width rather than indent_size", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tui-editorconfig-"));
	try {
		await fs.writeFile(path.join(root, ".editorconfig"), "root=true\n[*]\nindent_size=2\ntab_width=8\n");
		expect(replaceTabs("\treturn 1;", path.join(root, "index.ts"))).toBe("        return 1;");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { getIndentation } from "../src/tab-spacing";

describe("EditorConfig dot-prefixed children", () => {
	it("applies an anchored section to a child directory beginning with two dots", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spacing-dot-child-"));
		try {
			await fs.mkdir(path.join(root, "..cache"));
			await Bun.write(path.join(root, ".editorconfig"), "root=true\n[..cache/*.ts]\nindent_size=8\n");
			expect(getIndentation("..cache/file.ts", root)).toBe(8);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("resolves a parent path against its own ancestor config, not the caller project", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "spacing-parent-"));
		try {
			await fs.mkdir(path.join(root, "project"));
			await fs.mkdir(path.join(root, "outside"));
			await Bun.write(path.join(root, ".editorconfig"), "root=true\n[outside/*.ts]\nindent_size=6\n");
			await Bun.write(path.join(root, "project", ".editorconfig"), "root=true\n[*]\nindent_size=9\n");
			expect(getIndentation("../outside/file.ts", path.join(root, "project"))).toBe(6);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("property: dot-prefixed child names preserve root and nested rules, seed 5112026, 30 inputs", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 2, max: 6 }),
				fc.constantFrom("cache", "config", "data"),
				fc.integer({ min: 1, max: 16 }),
				async (dots, suffix, width) => {
					const root = await fs.mkdtemp(path.join(os.tmpdir(), "spacing-dot-property-"));
					const child = `${".".repeat(dots)}${suffix}`;
					try {
						await fs.mkdir(path.join(root, child));
						await Bun.write(path.join(root, ".editorconfig"), `root=true\n[${child}/*.ts]\ntab_width=${width}\n`);
						await Bun.write(path.join(root, child, ".editorconfig"), "[*.md]\ntab_width=7\n");
						expect(getIndentation(`${child}/file.ts`, root)).toBe(width);
						expect(getIndentation(`${child}/file.md`, root)).toBe(7);
					} finally {
						await fs.rm(root, { recursive: true, force: true });
					}
				},
			),
			{ seed: 5112026, numRuns: 30 },
		);
	});
});

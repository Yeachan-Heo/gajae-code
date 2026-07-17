import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { verifyExpectedFiles } from "../src/verify";

async function createTempDirs(): Promise<{
	root: string;
	expectedDir: string;
	actualDir: string;
	cleanup: () => Promise<void>;
}> {
	const tempDir = await TempDir.create("@reach-benchmark-verify-");
	const expectedDir = tempDir.join("expected");
	const actualDir = tempDir.join("actual");
	await fs.mkdir(expectedDir, { recursive: true });
	await fs.mkdir(actualDir, { recursive: true });
	return {
		root: tempDir.absolute(),
		expectedDir,
		actualDir,
		cleanup: async () => {
			await tempDir.remove();
		},
	};
}

describe("verifyExpectedFiles", () => {
	it("reports missing files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Missing files: index.ts");
		} finally {
			await cleanup();
		}
	});

	it("reports unexpected files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "extra.ts"), "export const extra = true;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Unexpected files: extra.ts");
		} finally {
			await cleanup();
		}
	});

	it("ignores GJC session runtime metadata created inside the benchmark workspace", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, ".gjc", "_session-123", "runtime-state.json"), "{}\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("does not reinterpret literal backslashes as separators on POSIX", async () => {
		if (path.sep !== "/") return;

		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, ".gjc\\_session-123\\runtime-state.json"), "{}\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Unexpected files: .gjc\\_session-123\\runtime-state.json");
		} finally {
			await cleanup();
		}
	});

	it("does not ignore files that only resemble a session directory", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, ".gjc", "_session-decoy.json"), "{}\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain(`Unexpected files: ${path.join(".gjc", "_session-decoy.json")}`);
		} finally {
			await cleanup();
		}
	});
	it("reports shared GJC files as unexpected alongside session runtime metadata", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, ".gjc", "_session-123", "runtime-state.json"), "{}\n");
			await Bun.write(path.join(actualDir, ".gjc", "agents", "foo.md"), "# Agent\n");
			await Bun.write(path.join(actualDir, ".gjc", "mcp.json"), "{}\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain(
				`Unexpected files: ${path.join(".gjc", "agents", "foo.md")}, ${path.join(".gjc", "mcp.json")}`,
			);
		} finally {
			await cleanup();
		}
	});

	it("fails with diff output when formatted content differs", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "const value = 2;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.diff).toContain("-const value = 1;");
			expect(result.diff).toContain("+const value = 2;");
			expect(result.diffStats?.linesChanged).toBeGreaterThan(0);
			expect(result.diffStats?.charsChanged).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it("succeeds when formatted content matches despite whitespace differences", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			const expected = "function test() {\n  return 1;\n}\n";
			const actual = "function test(){\nreturn 1;\n}\n";
			await Bun.write(path.join(expectedDir, "index.ts"), expected);
			await Bun.write(path.join(actualDir, "index.ts"), actual);

			const result = await verifyExpectedFiles(expectedDir, actualDir);
			const actualAfter = await Bun.file(path.join(actualDir, "index.ts")).text();

			expect(result.success).toBe(true);
			expect(result.formattedEquivalent).toBe(true);
			expect(actualAfter).toBe(actual);
		} finally {
			await cleanup();
		}
	});

	it("normalizes line endings before comparison", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\r\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("preserves expected whitespace on non-formatted files when differences are whitespace-only", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "notes.txt"), "alpha  beta\ngamma\n");
			await Bun.write(path.join(actualDir, "notes.txt"), "alpha beta\ngamma\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");

function packedFiles(): string[] {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "pm", "pack", "--dry-run"],
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	expect(result.exitCode, stderr || stdout).toBe(0);

	return stdout
		.split("\n")
		.map(line => line.match(/^packed\s+(?:\S+)\s+(.+)$/)?.[1])
		.filter((file): file is string => file !== undefined);
}

describe("coding-agent package files", () => {
	it("excludes duplicate/generated-source package payloads without dropping runtime generated docs", () => {
		const files = packedFiles();
		const fileSet = new Set(files);

		expect(files.some(file => file.startsWith("vendor/insane-search/engine/tests/"))).toBe(false);
		expect(fileSet.has("src/export/html/template.html")).toBe(false);
		expect(fileSet.has("src/export/html/template.css")).toBe(false);
		expect(fileSet.has("src/export/html/template.js")).toBe(false);

		expect(fileSet.has("src/export/html/template.generated.ts")).toBe(true);
		expect(fileSet.has("src/internal-urls/docs-index.generated.ts")).toBe(true);
		expect(fileSet.has("src/sdk/broker/internal-source.bunfig.toml")).toBe(true);
		expect(fileSet.has("src/sdk/broker/internal-source-marker-2178.txt")).toBe(true);
	});
});

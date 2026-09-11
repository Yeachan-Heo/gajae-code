import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { convertFileWithMarkit } from "../src/utils/markit";
import { ensureMupdfWasmResolution } from "../src/utils/mupdf-wasm";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";
const fixturePdfPath = path.resolve(import.meta.dirname, "fixtures/dummy-pdf-fixture.pdf");

describe("mupdf wasm embedding (#5433)", () => {
	it("seeds the emscripten module config with a locateFile hook", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const previous = globalScope[MODULE_CONFIG_KEY];
		delete globalScope[MODULE_CONFIG_KEY];
		try {
			ensureMupdfWasmResolution();
			const seeded = globalScope[MODULE_CONFIG_KEY] as { locateFile?: unknown } | undefined;
			expect(typeof seeded?.locateFile).toBe("function");
			// Idempotent: seeding again must not replace an existing config.
			ensureMupdfWasmResolution();
			expect(globalScope[MODULE_CONFIG_KEY]).toBe(seeded);
		} finally {
			if (previous === undefined) {
				delete globalScope[MODULE_CONFIG_KEY];
			} else {
				globalScope[MODULE_CONFIG_KEY] = previous;
			}
		}
	});

	it("preserves a pre-existing emscripten module config", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const sentinel = { locateFile: () => "/sentinel/mupdf-wasm.wasm" };
		const previous = globalScope[MODULE_CONFIG_KEY];
		globalScope[MODULE_CONFIG_KEY] = sentinel;
		try {
			ensureMupdfWasmResolution();
			expect(globalScope[MODULE_CONFIG_KEY]).toBe(sentinel);
		} finally {
			if (previous === undefined) {
				delete globalScope[MODULE_CONFIG_KEY];
			} else {
				globalScope[MODULE_CONFIG_KEY] = previous;
			}
		}
	});

	it("converts a one-page PDF to text through markit", async () => {
		const result = await convertFileWithMarkit(fixturePdfPath);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Dummy PDF file");
	});

	it("reports a bounded error for a corrupt PDF instead of succeeding", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mupdf-corrupt-"));
		try {
			const corruptPath = path.join(tempDir, "corrupt.pdf");
			fs.writeFileSync(corruptPath, Buffer.from("%PDF-1.4 not really a pdf\n"));
			const result = await convertFileWithMarkit(corruptPath);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("pdf:");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("mupdf wasm embedding in a compiled binary (#5433)", () => {
	it("converts a one-page PDF end to end", async () => {
		const workspaceRoot = path.resolve(import.meta.dirname, "../..");
		const fixtureEntry = path.resolve(import.meta.dirname, "fixtures/mupdf-compiled-convert-entry.ts");
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mupdf-compiled-"));
		const executable = path.join(outDir, "mupdf-convert-fixture");
		try {
			const compile = Bun.spawn(
				[process.execPath, "build", fixtureEntry, "--compile", "--minify", "--keep-names", "--outfile", executable],
				{ cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" },
			);
			const [compileExit, compileStderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
			expect(compileExit, compileStderr.slice(0, 2000)).toBe(0);

			const run = Bun.spawn([executable, fixturePdfPath], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
			const [runExit, stdout, stderr] = await Promise.all([
				run.exited,
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
			]);
			expect(stderr).not.toContain("mupdf-wasm.wasm");
			expect(runExit, stderr.slice(0, 2000) || stdout).toBe(0);
			expect(stdout).toContain("CONVERTED:Dummy PDF file");
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	}, 240_000);
});

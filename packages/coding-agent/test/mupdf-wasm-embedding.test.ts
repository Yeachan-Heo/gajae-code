import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { generateMuPdfAsset, resetMuPdfAsset } from "../scripts/embed-mupdf";
import { convertFileWithMarkit } from "../src/utils/markit";
import { ensureMupdfWasmResolution } from "../src/utils/mupdf-wasm";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";
const fixturePdfPath = path.resolve(import.meta.dirname, "fixtures/dummy-pdf-fixture.pdf");

describe("mupdf wasm embedding (#5433)", () => {
	it("lets an ordinary source runtime use mupdf's adjacent wasm sidecar", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const previous = globalScope[MODULE_CONFIG_KEY];
		delete globalScope[MODULE_CONFIG_KEY];
		try {
			ensureMupdfWasmResolution();
			expect(globalScope[MODULE_CONFIG_KEY]).toBeUndefined();
		} finally {
			if (previous === undefined) {
				delete globalScope[MODULE_CONFIG_KEY];
			} else {
				globalScope[MODULE_CONFIG_KEY] = previous;
			}
		}
	});

	it("loads from an npm-style package layout without resolving the monorepo-only embedded asset", async () => {
		const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mupdf-package-layout-"));
		const packageUtils = path.join(tempDir, "node_modules", "@gajae-code", "coding-agent", "src", "utils");
		const scopeDir = path.join(tempDir, "node_modules", "@gajae-code");
		try {
			fs.mkdirSync(packageUtils, { recursive: true });
			fs.copyFileSync(
				path.resolve(import.meta.dirname, "../package.json"),
				path.join(tempDir, "node_modules", "@gajae-code", "coding-agent", "package.json"),
			);
			fs.copyFileSync(
				path.resolve(import.meta.dirname, "../src/utils/mupdf-wasm.ts"),
				path.join(packageUtils, "mupdf-wasm.ts"),
			);
			fs.copyFileSync(
				path.resolve(import.meta.dirname, "../src/utils/mupdf-wasm-embedded.ts"),
				path.join(packageUtils, "mupdf-wasm-embedded.ts"),
			);
			fs.symlinkSync(
				fs.realpathSync(path.join(repositoryRoot, "node_modules", "@gajae-code", "utils")),
				path.join(scopeDir, "utils"),
				"dir",
			);

			const loaded = await import(`${pathToFileURL(path.join(packageUtils, "mupdf-wasm.ts")).href}?package-layout`);
			expect(typeof loaded.ensureMupdfWasmResolution).toBe("function");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
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
		// A compiled binary carries the WASM only if the embedding step ran first.
		// scripts/ci-release-build-binaries.ts does exactly this around the release
		// compile, so the test has to reproduce it or it asserts against a binary
		// that no release ever ships. Reset afterwards: the generated module is
		// checked in as the source-install (undefined) form.
		await generateMuPdfAsset();
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
			await resetMuPdfAsset();
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	}, 240_000);
});

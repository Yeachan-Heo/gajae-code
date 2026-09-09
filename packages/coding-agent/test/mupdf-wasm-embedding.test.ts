import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMarkitMupdfWasm } from "../scripts/generate-mupdf-wasm";

import { convertFileWithMarkit } from "../src/utils/markit";
import { ensureMupdfWasmResolution } from "../src/utils/mupdf-wasm";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";
const fixturePdfPath = path.resolve(import.meta.dirname, "fixtures/dummy-pdf-fixture.pdf");

describe("mupdf wasm embedding (#5433)", () => {
	it("resolves markit's nested MuPDF rather than a different hoisted instance", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-mupdf-installed-"));
		try {
			const packageDir = path.join(tempDir, "node_modules/@gajae-code/coding-agent");
			const installedMarkit = path.join(tempDir, "node_modules/markit-ai");
			const markitRoot = path.resolve(path.dirname(Bun.resolveSync("markit-ai", import.meta.dirname)), "..");
			const mupdfRoot = path.resolve(path.dirname(resolveMarkitMupdfWasm()), "..");
			fs.mkdirSync(packageDir, { recursive: true });
			fs.cpSync(markitRoot, installedMarkit, { recursive: true });
			const nestedMupdf = path.join(installedMarkit, "node_modules/mupdf");
			fs.cpSync(mupdfRoot, nestedMupdf, { recursive: true });
			fs.cpSync(mupdfRoot, path.join(tempDir, "node_modules/mupdf"), { recursive: true });
			const resolved = resolveMarkitMupdfWasm(packageDir);
			expect(resolved).toBe(path.join(nestedMupdf, "dist/mupdf-wasm.wasm"));
			expect(await Bun.file(resolved).bytes()).toEqual(await Bun.file(resolveMarkitMupdfWasm()).bytes());
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("seeds the emscripten module config with a locateFile hook", () => {
		const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
		const previous = globalScope[MODULE_CONFIG_KEY];
		delete globalScope[MODULE_CONFIG_KEY];
		try {
			ensureMupdfWasmResolution();
			const seeded = globalScope[MODULE_CONFIG_KEY] as { locateFile?: unknown } | undefined;
			expect(typeof seeded?.locateFile).toBe("function");
			expect((seeded as { locateFile: () => string }).locateFile()).toBe(resolveMarkitMupdfWasm());
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
			const embeddedProbe = path.join(outDir, "embedded-probe.ts");
			const expectedHash = new Bun.CryptoHasher("sha256")
				.update(await Bun.file(resolveMarkitMupdfWasm()).bytes())
				.digest("hex");
			await Bun.write(
				embeddedProbe,
				`import { embeddedFiles } from "bun";
import ${JSON.stringify(fixtureEntry)};
const wasm = embeddedFiles.find(file => file.name.includes("mupdf-wasm"));
if (!wasm) throw new Error("MuPDF WASM was not embedded");
const hash = new Bun.CryptoHasher("sha256").update(await wasm.bytes()).digest("hex");
if (hash !== ${JSON.stringify(expectedHash)}) throw new Error("Embedded WASM differs from markit's dependency instance");
`,
			);
			const compile = Bun.spawn(
				[
					process.execPath,
					"build",
					embeddedProbe,
					"--compile",
					"--minify",
					"--keep-names",
					"--outfile",
					executable,
				],
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

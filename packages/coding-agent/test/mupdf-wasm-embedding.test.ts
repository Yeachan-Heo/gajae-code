import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertFileWithMarkit } from "../src/utils/markit";
import { ensureMupdfWasmResolution } from "../src/utils/mupdf-wasm";
import { resolveMarkitMupdfWasm } from "../src/utils/mupdf-wasm-path";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";
const fixturePdfPath = path.resolve(import.meta.dirname, "fixtures/dummy-pdf-fixture.pdf");

describe("mupdf wasm embedding (#5433)", () => {
	it("resolves from the coding-agent package root by default", () => {
		const packageDir = path.resolve(import.meta.dirname, "..");
		const markitEntry = Bun.resolveSync("markit-ai", packageDir);
		const mupdfEntry = Bun.resolveSync("mupdf", path.dirname(markitEntry));
		expect(resolveMarkitMupdfWasm()).toBe(path.join(path.dirname(mupdfEntry), "mupdf-wasm.wasm"));
	});

	it("keeps the executable WASM generator out of runtime asset imports", async () => {
		const packageDir = path.resolve(import.meta.dirname, "..");
		const parser = new Bun.Transpiler({ loader: "ts", target: "bun" });
		const runtimeImports = parser
			.scan(await Bun.file(path.join(packageDir, "src/utils/mupdf-wasm.ts")).text())
			.imports.map(entry => entry.path);
		const helperImports = parser
			.scan(await Bun.file(path.join(packageDir, "src/utils/mupdf-wasm-path.ts")).text())
			.imports.map(entry => entry.path);
		const generatorImports = parser
			.scan(await Bun.file(path.join(packageDir, "scripts/generate-mupdf-wasm.ts")).text())
			.imports.map(entry => entry.path);
		expect(runtimeImports).toContain("./mupdf-wasm-path");
		expect(
			runtimeImports.some(specifier => specifier.includes("scripts/") || specifier.includes("generate-mupdf")),
		).toBe(false);
		expect(helperImports).toEqual(["node:path"]);
		expect(generatorImports).toContain("../src/utils/mupdf-wasm-path");
	});
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

// The PDF fixture does not load the CLI's complete minified module/worker graph.
// Exercise the real build entrypoint as well: hosted run 34365508250 compiled
// successfully, then dist/gjc --smoke-test failed while parsing an identifier.
describe("full compiled CLI startup (#5452)", () => {
	it("builds dist/gjc and completes the full smoke test in a clean environment", async () => {
		const repoRoot = path.resolve(import.meta.dirname, "../../..");
		const packageDir = path.join(repoRoot, "packages/coding-agent");
		const artifactsRoot = path.join(repoRoot, "artifacts");
		await fsPromises.mkdir(artifactsRoot, { recursive: true });
		const evidenceDir = await fsPromises.mkdtemp(path.join(artifactsRoot, "compiled-cli-smoke-"));
		const runtimeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-full-compiled-smoke-"));
		try {
			// Do not inherit GJC session/broker/managed-runtime variables or credentials.
			// Keep the Bun executable used by this test first on PATH for build subprocesses.
			const baseEnv: NodeJS.ProcessEnv = {
				PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter),
				TMPDIR: os.tmpdir(),
				TEMP: os.tmpdir(),
				TMP: os.tmpdir(),
			};
			for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
				if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
			}
			const phases = [
				{
					name: "build",
					command: [process.execPath, "run", "build"],
					cwd: packageDir,
					timeout: 300_000,
				},
				{
					name: "smoke",
					command: [path.join(packageDir, "dist/gjc"), "--smoke-test"],
					// No project files or node_modules in the runtime working directory.
					cwd: runtimeDir,
					timeout: 120_000,
				},
			];
			for (const phase of phases) {
				const home = path.join(runtimeDir, phase.name, "home");
				const xdg = path.join(runtimeDir, phase.name, "xdg");
				const env = {
					...baseEnv,
					HOME: home,
					USERPROFILE: home,
					XDG_CONFIG_HOME: path.join(xdg, "config"),
					XDG_DATA_HOME: path.join(xdg, "data"),
					XDG_CACHE_HOME: path.join(xdg, "cache"),
					XDG_STATE_HOME: path.join(xdg, "state"),
				};
				for (const directory of [
					home,
					env.XDG_CONFIG_HOME,
					env.XDG_DATA_HOME,
					env.XDG_CACHE_HOME,
					env.XDG_STATE_HOME,
				]) {
					await fsPromises.mkdir(directory, { recursive: true });
				}
				const proc = Bun.spawn(phase.command, {
					cwd: phase.cwd,
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					timeout: phase.timeout,
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				await Promise.all([
					Bun.write(path.join(evidenceDir, `${phase.name}.stdout.log`), stdout),
					Bun.write(path.join(evidenceDir, `${phase.name}.stderr.log`), stderr),
					Bun.write(
						path.join(evidenceDir, `${phase.name}.json`),
						JSON.stringify(
							{
								command: phase.command,
								cwd: phase.cwd,
								bunVersion: Bun.version,
								exitCode,
								signalCode: proc.signalCode,
							},
							null,
							2,
						),
					),
				]);
				const diagnostic = `${phase.name} failed; evidence: ${evidenceDir}\nexit=${exitCode} signal=${proc.signalCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
				expect(exitCode, diagnostic).toBe(0);
				if (phase.name === "smoke") expect(stdout, diagnostic).toContain("smoke-test: ok");
			}
		} finally {
			await fsPromises.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 600_000);
});

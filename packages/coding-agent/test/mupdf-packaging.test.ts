import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { resolvePublishDependency } from "../../../scripts/ci-release-publish";
import { canonicalizePackageTarball } from "../../../scripts/release-evidence";
import {
	buildDevCompileArgs,
	buildReleaseCompileArgs,
	devEntrypoints,
	releaseEntrypoints,
} from "../scripts/compile-args";
import { generateMuPdfAsset, resetMuPdfAsset } from "../scripts/embed-mupdf";
import { mupdfAssetMapping, sanitizeMuPdfDiagnostic, withMuPdfDiagnostic } from "../src/utils/mupdf";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageRoot = path.join(repoRoot, "packages/coding-agent");
const markitRoot = path.join(packageRoot, "vendor/markit-ai");
const markitEntry = path.join(markitRoot, "dist/index.js");
const mupdfEntry = Bun.resolveSync("mupdf", path.dirname(markitEntry));

// A generated, valid one-page PDF keeps this regression independent of network
// access, the W3C endpoint, and an installed PDF authoring program.
function dummyPdf(): string {
	const stream = "BT /F1 16 Tf 50 150 Td (Dummy PDF file) Tj ET q 1 0 0 rg 50 50 100 80 re f Q";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const entrySource = `
import { convertBufferWithMarkit, convertFileWithMarkit } from ${JSON.stringify(path.join(packageRoot, "src/utils/markit.ts"))};
import { mupdfAssetMapping } from ${JSON.stringify(path.join(packageRoot, "src/utils/mupdf.ts"))};
import { extractPages, renderImageRegion } from ${JSON.stringify(path.join(markitRoot, "dist/converters/pdf/extract.js"))};
const mode = process.argv[2];
const originalFile = Bun.file;
let faultedReads = 0;
if (mode === "wasm-failure") {
	await Bun.write("corrupt.wasm", new Uint8Array([0, 1, 2, 3]));
	// Substitute only the asset read, before the first preparation. No module
	// configuration mutation or global unhandled-rejection handler is involved.
	Bun.file = function (asset, ...args) {
		if (typeof asset === "string" && asset.includes("mupdf-wasm") && asset.endsWith(".wasm")) {
			faultedReads++;
			return originalFile("corrupt.wasm");
		}
		return originalFile(asset, ...args);
	};
}
const bytes = Buffer.from(mode === "invalid-pdf" ? "not a PDF document" : ${JSON.stringify(dummyPdf())});
const buffer = await convertBufferWithMarkit(bytes, " PDF ");
Bun.file = originalFile;
let file;
let rendered;
let recovery;
if (mode === "invalid-pdf") {
	const filePath = process.cwd() + "/malformed.pdf";
	await Bun.write(filePath, bytes);
	file = await convertFileWithMarkit(filePath);
}
if (mode === "success") {
	await Bun.write("input.pdf", bytes);
	file = await convertFileWithMarkit("input.pdf");
	// Exercise markit-ai's shared asynchronous MuPDF module and synchronous
	// image-region renderer, not a separate rendering implementation.
	await extractPages(bytes);
	const png = renderImageRegion(bytes, {
		id: "red-rectangle", pageNumber: 1,
		bbox: { x: 50, y: 70, w: 100, h: 80 }, topY: 130,
	});
	// Deliberately delayed: eager import would bypass Markit's initialization lifecycle.
	const mupdf = await import(${JSON.stringify(mupdfEntry)});
	const image = new mupdf.Image(png);
	const pixmap = image.toPixmap();
	try {
		const pixels = pixmap.getPixels();
		const center = 100 * pixmap.getStride() + 120 * pixmap.getNumberOfComponents();
		rendered = {
			signature: Array.from(png.subarray(0, 8)),
			width: pixmap.getWidth(), height: pixmap.getHeight(),
			center: Array.from(pixels.subarray(center, center + 3)),
			corner: Array.from(pixels.subarray(0, 3)),
		};
	} finally {
		pixmap.destroy();
		image.destroy();
	}
}
if (mode === "wasm-failure") {
	recovery = await convertBufferWithMarkit(Buffer.from("<h1>Still usable</h1>"), ".html");
	// Let any secondary rejection surface before this process exits naturally.
	await Bun.sleep(20);
}
process.stdout.write(JSON.stringify({ buffer, file, rendered, recovery, faultedReads, mapping: mupdfAssetMapping }));
`;

interface ConversionOutput {
	buffer: { ok: boolean; content: string; error?: string };
	file?: { ok: boolean; content: string; error?: string };
	mapping: string;
	faultedReads?: number;
	wasmValid?: boolean;
	loaderError?: { name: string; message: string };
	recovery?: { ok: boolean; content: string; error?: string };
	rendered?: { signature: number[]; width: number; height: number; center: number[]; corner: number[] };
}

async function runIsolated(command: string[], cwd: string): Promise<ConversionOutput> {
	const child = Bun.spawn(command, {
		cwd,
		env: { HOME: cwd, TMPDIR: cwd, PATH: "", NODE_PATH: "", LANG: "C" },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
	expect(stderr).not.toMatch(/Unhandled|CompileError|wasm streaming compile failed/i);
	return JSON.parse(stdout) as ConversionOutput;
}

describe("MuPDF standalone packaging", () => {
	it("generates a static file import and resets to a portable source mapping", async () => {
		const mapping = path.join(packageRoot, "src/utils/mupdf-embedded.ts");
		try {
			await generateMuPdfAsset();
			expect(await Bun.file(mapping).text()).toContain('with { type: "file" }');
		} finally {
			await resetMuPdfAsset();
		}
		expect(await Bun.file(mapping).text()).toContain("= undefined;");
		expect(await Bun.file(mapping).text()).not.toContain("node_modules");
	});

	for (const layout of ["nested", "hoisted"]) {
		it(`resolves source WASM in a relocated ${layout} install without the repository`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mupdf-install-"));
			try {
				await resetMuPdfAsset();
				const installed = path.join(directory, "node_modules/@gajae-code/coding-agent");
				const utils = path.join(installed, "src/utils");
				await fs.mkdir(utils, { recursive: true });
				for (const name of ["mupdf.ts", "mupdf-embedded.ts"]) {
					await fs.copyFile(path.join(packageRoot, "src/utils", name), path.join(utils, name));
				}
				const scope = path.join(directory, "node_modules/@gajae-code");
				await fs.mkdir(scope, { recursive: true });
				await fs.symlink(path.join(repoRoot, "packages/utils"), path.join(scope, "utils"), "dir");
				const lazyEntry = path.join(installed, "lazy.ts");
				await Bun.write(
					lazyEntry,
					`
import { mupdfAssetMapping } from "./src/utils/mupdf";
console.log(JSON.stringify({ buffer: { ok: true, content: "" }, mapping: mupdfAssetMapping }));
`,
				);
				const lazyOutput = await runIsolated([process.execPath, lazyEntry], directory);
				expect(lazyOutput.mapping).toContain("unresolved");
				const dependencies = path.join(layout === "nested" ? installed : directory, "node_modules");
				const markit = path.join(installed, "vendor/markit-ai/dist");
				await fs.mkdir(markit, { recursive: true });
				await Bun.write(path.join(markit, "index.js"), "export {};\n");
				const dependency = path.join(dependencies, "mupdf");
				const original = path.dirname(path.dirname(mupdfEntry));
				await fs.cp(original, dependency, { recursive: true, dereference: true });
				const entry = path.join(installed, "probe.ts");
				await Bun.write(
					entry,
					`
import { prepareMuPdf, mupdfAssetMapping } from "./src/utils/mupdf";
await prepareMuPdf();
await WebAssembly.compile(globalThis.$libmupdf_wasm_Module.wasmBinary);
console.log(JSON.stringify({ buffer: { ok: true, content: "" }, mapping: mupdfAssetMapping }));
`,
				);
				const output = await runIsolated([process.execPath, entry], directory);
				expect(output.buffer.ok).toBe(true);
				expect(output.mapping).toContain(await fs.realpath(dependency));
				expect(output.mapping).not.toContain(repoRoot);
				expect(output.mapping).toContain(path.join(await fs.realpath(dependency), "dist/mupdf.js"));
				const scripts = path.join(installed, "scripts");
				await fs.mkdir(scripts);
				await fs.copyFile(path.join(packageRoot, "scripts/embed-mupdf.ts"), path.join(scripts, "embed-mupdf.ts"));
				await Bun.write(
					entry,
					`
import { generateMuPdfAsset } from "./scripts/embed-mupdf";
await generateMuPdfAsset();
console.log(JSON.stringify({ buffer: { ok: true, content: "" }, mapping: await Bun.file(new URL("./src/utils/mupdf-embedded.ts", import.meta.url)).text() }));
`,
				);
				const generated = await runIsolated([process.execPath, entry], directory);
				expect(generated.mapping).toContain(
					JSON.stringify(path.join(await fs.realpath(dependency), "dist/mupdf-wasm.wasm")),
				);
				expect(generated.mapping).toContain(
					JSON.stringify(path.join(await fs.realpath(dependency), "dist/mupdf.js")),
				);
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}

	for (const fault of ["missing", "corrupt"] as const) {
		it(`retains the ${fault} JS loader error class and safe reason without resolved paths`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mupdf-loader-"));
			try {
				const utils = path.join(directory, "src/utils");
				await fs.mkdir(utils, { recursive: true });
				for (const name of ["markit.ts", "mupdf.ts", "mupdf-embedded.ts"]) {
					await fs.copyFile(path.join(packageRoot, "src/utils", name), path.join(utils, name));
				}
				await fs.mkdir(path.join(directory, "src/tools"));
				await fs.copyFile(
					path.join(packageRoot, "src/tools/tool-errors.ts"),
					path.join(directory, "src/tools/tool-errors.ts"),
				);
				const modules = path.join(directory, "node_modules");
				const markit = path.join(directory, "vendor/markit-ai");
				const originalMarkit = markitRoot;
				await fs.cp(originalMarkit, markit, {
					recursive: true,
					dereference: true,
					filter: source => path.basename(source) !== "node_modules",
				});
				const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();
				await fs.mkdir(modules, { recursive: true });
				for (const name of Object.keys(manifest.dependencies)) {
					if (name === "mupdf" || name.startsWith("@gajae-code/")) continue;
					await fs.mkdir(path.dirname(path.join(modules, name)), { recursive: true });
					await fs.symlink(
						await fs.realpath(path.join(repoRoot, "node_modules", name)),
						path.join(modules, name),
						"dir",
					);
				}
				await fs.mkdir(path.join(modules, "@gajae-code"));
				await fs.symlink(path.join(repoRoot, "packages/utils"), path.join(modules, "@gajae-code/utils"), "dir");
				const originalMuPdf = path.dirname(
					path.dirname(Bun.resolveSync("mupdf", path.join(originalMarkit, "dist"))),
				);
				const dependency = path.join(modules, "mupdf");
				await fs.cp(originalMuPdf, dependency, { recursive: true, dereference: true });
				// Only the temporary package is damaged. Its real WASM stays intact.
				const loader = path.join(dependency, "dist/mupdf-wasm.js");
				if (fault === "missing") await fs.rm(loader);
				else await Bun.write(loader, "export const broken = ;\n");
				const entry = path.join(directory, "probe.ts");
				await Bun.write(
					entry,
					`
import { convertBufferWithMarkit } from "./src/utils/markit";
import { mupdfAssetMapping } from "./src/utils/mupdf";
const buffer = await convertBufferWithMarkit(Buffer.from(${JSON.stringify(dummyPdf())}), ".pdf");
const wasmValid = WebAssembly.validate(globalThis.$libmupdf_wasm_Module.wasmBinary);
let loaderError;
try { await import(${JSON.stringify(path.join(dependency, "dist/mupdf.js"))}); }
catch (error) { loaderError = { name: error.name, message: error.message }; }
const recovery = await convertBufferWithMarkit(Buffer.from("<h1>Still usable</h1>"), ".html");
await Bun.sleep(20);
console.log(JSON.stringify({ buffer, wasmValid, loaderError, recovery, mapping: mupdfAssetMapping }));
`,
				);
				const output = await runIsolated([process.execPath, entry], directory);
				expect(output.wasmValid).toBe(true);
				expect(output.buffer.ok).toBe(false);
				expect(output.buffer.content).toBe("");
				expect(output.buffer.error).toContain("AggregateError");
				expect(output.buffer.error).toContain("MuPDF module initialization failed");
				expect(output.loaderError?.message).toBeTruthy();
				expect(output.buffer.error).toContain(`${output.loaderError!.name}:`);
				expect(output.buffer.error).toContain(sanitizeMuPdfDiagnostic(output.loaderError!.message));
				expect(output.buffer.error).not.toContain(directory);
				expect(output.buffer.error).not.toContain(repoRoot);
				if (fault === "missing") {
					expect(output.buffer.error).toMatch(/Cannot find|Module not found/i);
					expect(output.buffer.error).toContain("[path redacted]");
				} else {
					expect(output.buffer.error).toMatch(/Unexpected|Expected|Syntax/i);
				}
				if (fault === "missing") expect(output.loaderError?.message).toContain("mupdf-wasm.js");
				else expect(output.loaderError?.name).toBe("BuildMessage");
				expect(output.mapping).toContain(path.join(await fs.realpath(dependency), "dist/mupdf.js"));
				expect(output.recovery?.ok).toBe(true);
				expect(output.recovery?.content).toContain("Still usable");
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}

	it("reports a missing compiled mapping instead of resolving a host dependency", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mupdf-missing-"));
		try {
			await resetMuPdfAsset();
			const entry = path.join(directory, "entry.ts");
			const executable = path.join(directory, "probe");
			await Bun.write(
				entry,
				`
import { prepareMuPdf } from ${JSON.stringify(path.join(packageRoot, "src/utils/mupdf.ts"))};
try { await prepareMuPdf(); throw new Error("Unexpected success"); }
catch (error) { console.log(JSON.stringify({ buffer: { ok: false, content: "", error: error.message } })); }
`,
			);
			const build = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", executable], {
				stdout: "ignore",
				stderr: "inherit",
			});
			expect(await build.exited).toBe(0);
			await fs.rm(entry);
			const output = await runIsolated([executable], directory);
			expect(output.buffer.error).toContain("Compiled MuPDF WASM mapping is missing");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 120_000);
	it("keeps original causes and resolved provenance in operational debug logging only", () => {
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const rootCause = new WebAssembly.CompileError("invalid WASM at /private/install/mupdf-wasm.wasm");
			const failure = new Error("asset initialization failed", { cause: rootCause });
			const diagnostic = withMuPdfDiagnostic(failure);
			expect(diagnostic.cause).toBe(failure);
			expect(failure.cause).toBe(rootCause);
			expect(diagnostic.message).toContain("MuPDF; package asset; mupdf-wasm.wasm");
			expect(diagnostic.message).not.toContain(mupdfAssetMapping);
			expect(diagnostic.message).not.toContain("/private/install");
			expect(debug).toHaveBeenCalledWith("MuPDF conversion failed", {
				mapping: mupdfAssetMapping,
				error: expect.stringContaining(rootCause.message),
				initializationFailure: "undefined",
			});
		} finally {
			debug.mockRestore();
		}
	});

	it("redacts path-bearing cause fields and control characters while retaining safe reasons", () => {
		for (const location of [
			"/Users/private user/install/mupdf-wasm.js",
			"C:\\Users\\private user\\mupdf-wasm.js",
			"\\\\host\\private\\mupdf-wasm.js",
			"~/private/mupdf-wasm.js",
			"[REDACTED]/private/mupdf-wasm.js",
			"file:%2FUsers%2Fprivate%2Fmupdf-wasm.js",
			"/Users/pri\u0000vate/mupdf-wasm.js",
		]) {
			const cause = new Error(`Cannot find module '${location}' from '${location}'`);
			const diagnostic = withMuPdfDiagnostic(cause);
			expect(diagnostic.cause).toBe(cause);
			expect(sanitizeMuPdfDiagnostic(`${cause.name}: ${cause.message}`)).toBe(
				"Error: Cannot find module '[path redacted]' from '[path redacted]'",
			);
		}
		expect(sanitizeMuPdfDiagnostic("CompileError: invalid WASM")).toBe("CompileError: invalid WASM");
	});

	for (const channel of ["source", "release", "dev"] as const) {
		it(`${channel} converts short PDFs and diagnoses failures without a runtime dependency install`, async () => {
			const buildDir = await fs.mkdtemp(path.join(repoRoot, ".mupdf-packaging-"));
			const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mupdf-runtime-"));
			try {
				const entry = path.join(buildDir, "entry.ts");
				const executable = path.join(runtimeDir, "pdf-reader");
				await Bun.write(entry, entrySource);
				let command = [process.execPath, entry];
				if (channel !== "source") {
					await generateMuPdfAsset();
					const entrypoints = channel === "release" ? releaseEntrypoints : devEntrypoints;
					const args =
						channel === "release"
							? buildReleaseCompileArgs(`bun-${process.platform}-${process.arch}`, executable)
							: buildDevCompileArgs(executable);
					// Exercise the actual shared release/dev flags, replacing only the
					// product entrypoints with this small PDF conversion executable.
					const firstEntrypoint = args.indexOf(entrypoints[0]);
					args.splice(firstEntrypoint, entrypoints.length, entry);
					args[0] = process.execPath;
					const build = Bun.spawn(args, {
						cwd: channel === "release" ? repoRoot : packageRoot,
						stdout: "pipe",
						stderr: "pipe",
					});
					const [exitCode, stdout, stderr] = await Promise.all([
						build.exited,
						new Response(build.stdout).text(),
						new Response(build.stderr).text(),
					]);
					expect({ exitCode, diagnostics: exitCode ? stdout + stderr : "" }).toEqual({
						exitCode: 0,
						diagnostics: "",
					});
					await resetMuPdfAsset();
					command = [executable];
					// The standalone must not need even its original build entrypoint.
					await fs.rm(buildDir, { recursive: true, force: true });
				}

				const success = await runIsolated([...command, "success"], runtimeDir);
				expect(success.buffer.ok).toBe(true);
				expect(success.buffer.content).toContain("Dummy PDF file");
				expect(success.file?.ok).toBe(true);
				expect(success.file?.content).toContain("Dummy PDF file");
				expect(success.rendered).toEqual({
					signature: [137, 80, 78, 71, 13, 10, 26, 10],
					width: 240,
					height: 200,
					center: [255, 0, 0],
					corner: [255, 255, 255],
				});
				if (channel !== "source") {
					expect(success.mapping).toContain("$bunfs");
					expect(success.mapping).toContain("build-time provenance");
				}

				for (const mode of ["invalid-pdf", "wasm-failure"]) {
					const failure = await runIsolated([...command, mode], runtimeDir);
					expect(failure.buffer.ok).toBe(false);
					expect(failure.buffer.content).toBe("");
					expect(failure.buffer.error).toContain("MuPDF;");
					expect(failure.buffer.error).toContain(channel === "source" ? "package asset" : "embedded asset");
					for (const result of mode === "invalid-pdf" ? [failure.buffer, failure.file!] : [failure.buffer]) {
						expect(result.ok).toBe(false);
						expect(result.content).toBe("");
						expect(result.error).toContain("PDF conversion failed");
						expect(result.error).not.toContain(repoRoot);
						expect(result.error).not.toContain(buildDir);
						expect(result.error).not.toContain(runtimeDir);
						expect(result.error).not.toContain("$bunfs");
						for (const resolvedPath of failure.mapping.split(" -> ").slice(1)) {
							expect(result.error).not.toContain(
								resolvedPath.split("; WASM")[0].replace("build-time provenance ", ""),
							);
						}
					}
					expect(failure.buffer.error).not.toContain("npm install");
					if (mode === "wasm-failure") {
						expect(failure.buffer.error).toContain("CompileError");
						expect(failure.faultedReads).toBe(1);
						expect(failure.recovery?.ok).toBe(true);
						expect(failure.recovery?.content).toContain("Still usable");
					}
				}
				expect(await fs.readdir(runtimeDir)).not.toContain("node_modules");
			} finally {
				await resetMuPdfAsset();
				await fs.rm(buildDir, { recursive: true, force: true });
				await fs.rm(runtimeDir, { recursive: true, force: true });
			}
		}, 120_000);
	}
});

// Real pack/install roundtrips must work without repository symlinks or patches.
async function snapshotFiles(directory: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(current: string): Promise<void> {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const filename = path.join(current, entry.name);
			if (entry.isDirectory()) await visit(filename);
			else
				files[path.relative(directory, filename)] = entry.isSymbolicLink()
					? `symlink:${await fs.readlink(filename)}`
					: new Bun.CryptoHasher("sha256").update(await Bun.file(filename).bytes()).digest("hex");
		}
	}
	await visit(directory);
	return files;
}

async function runPackageCommand(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, diagnostics: exitCode ? stdout + stderr : "" }).toEqual({ exitCode: 0, diagnostics: "" });
}

describe("published vendored Markit", () => {
	for (const packer of ["npm", "bun"]) {
		it(`${packer} packs twice without changing dependencies and installs portable conversion and read tools`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-markit-tarball-"));
			try {
				await resetMuPdfAsset();
				const publisher = path.join(directory, "workspace/packages/coding-agent");
				const tarballs = path.join(directory, "tarballs");
				const consumer = path.join(directory, "consumer");
				await fs.mkdir(tarballs);
				await fs.mkdir(consumer);
				await fs.cp(packageRoot, publisher, {
					recursive: true,
					filter: source => path.basename(source) !== "node_modules" && !source.endsWith(".tgz"),
				});
				const manifest = await Bun.file(path.join(publisher, "package.json")).json();
				for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
					for (const [name, version] of Object.entries(manifest[field] ?? {})) {
						manifest[field][name] = await resolvePublishDependency(name, version as string);
					}
				}
				expect(manifest.dependencies["markit-ai"]).toBeUndefined();
				expect(manifest.bundledDependencies).toBeUndefined();
				expect(manifest.bundleDependencies).toBeUndefined();
				expect(manifest.patchedDependencies).toBeUndefined();
				expect(manifest.scripts.postinstall).toBeUndefined();
				expect(manifest.scripts.prepack).not.toMatch(/stage-markit|node_modules|patch/);
				await Bun.write(path.join(publisher, "package.json"), JSON.stringify(manifest));
				// Reproduce the build workspace explicitly; none of these links are packed.
				const buildScripts = path.join(directory, "workspace/scripts");
				await fs.mkdir(buildScripts, { recursive: true });
				await fs.copyFile(
					path.join(repoRoot, "scripts/safe-cleanup.ts"),
					path.join(buildScripts, "safe-cleanup.ts"),
				);
				// Pre-existing dependency contents must remain untouched by every pack lifecycle.
				const modules = path.join(publisher, "node_modules");
				const existing = path.join(modules, "markit-ai");
				await fs.mkdir(existing, { recursive: true });
				for (const name of await fs.readdir(path.join(repoRoot, "node_modules"))) {
					if (name === "markit-ai" || name.startsWith(".")) continue;
					await fs.symlink(
						await fs.realpath(path.join(repoRoot, "node_modules", name)),
						path.join(modules, name),
						"dir",
					);
				}
				await Bun.write(path.join(existing, "user-file"), "preserve existing dependency");
				const before = await fs.lstat(existing);
				const contents = await snapshotFiles(modules);
				const pack =
					packer === "npm"
						? ["npm", "pack", "--pack-destination", tarballs]
						: [process.execPath, "pm", "pack", "--destination", tarballs];
				await runPackageCommand(pack, publisher);
				const archives = (await fs.readdir(tarballs)).filter(name => name.endsWith(".tgz"));
				expect(archives).toHaveLength(1);
				const archive = path.join(tarballs, archives[0]!);
				// Default canonicalization enforces release compressed/unpacked/member/count limits.
				const canonical = canonicalizePackageTarball(await Bun.file(archive).bytes());
				expect(canonical.byteLength).toBeGreaterThan(0);
				await runPackageCommand(pack, publisher);
				expect(canonicalizePackageTarball(await Bun.file(archive).bytes())).toEqual(canonical);
				const after = await fs.lstat(existing);
				expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
				expect(await snapshotFiles(modules)).toEqual(contents);
				const unpacked = path.join(directory, "unpacked");
				await fs.mkdir(unpacked);
				await runPackageCommand(["tar", "-xzf", archive, "-C", unpacked], directory);
				const packed = path.join(unpacked, "package");
				expect(await snapshotFiles(path.join(packed, "vendor/markit-ai"))).toEqual(await snapshotFiles(markitRoot));
				const packedFiles = await snapshotFiles(packed);
				expect(Object.values(packedFiles).some(value => value.startsWith("symlink:"))).toBe(false);
				expect(await fs.readdir(packed)).not.toContain("node_modules");
				await fs.rm(publisher, { recursive: true });
				await Bun.write(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
				await runPackageCommand(
					packer === "npm"
						? ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", archive]
						: [process.execPath, "add", "--ignore-scripts", archive],
					consumer,
				);
				const installed = await fs.realpath(path.join(consumer, "node_modules/@gajae-code/coding-agent"));
				expect(installed.startsWith(`${await fs.realpath(consumer)}${path.sep}`)).toBe(true);
				const vendored = path.join(installed, "vendor/markit-ai");
				expect(await snapshotFiles(vendored)).toEqual(await snapshotFiles(markitRoot));
				expect(await Bun.file(path.join(vendored, "LICENSE")).text()).toContain("MIT");
				expect(await Bun.file(path.join(vendored, "dist/markit.js")).text()).toContain("new AggregateError");
				expect(await Bun.file(path.join(vendored, "dist/converters/pdf/extract.js")).text()).not.toContain(
					'require("mupdf")',
				);
				const mupdf = Bun.resolveSync("mupdf", path.join(vendored, "dist"));
				expect(mupdf.startsWith(`${await fs.realpath(consumer)}${path.sep}`)).toBe(true);
				const mupdfManifest = await Bun.file(path.join(path.dirname(path.dirname(mupdf)), "package.json")).json();
				expect(mupdfManifest.version).toBe(manifest.dependencies.mupdf);
				expect(await Bun.file(path.join(path.dirname(path.dirname(mupdf)), "LICENSE")).text()).toContain(
					"GNU AFFERO GENERAL PUBLIC LICENSE",
				);
				const entry = path.join(installed, "published-probe.ts");
				const installedSource = entrySource.replaceAll(packageRoot, installed).replaceAll(mupdfEntry, mupdf);
				expect(installedSource).not.toContain(repoRoot);
				await Bun.write(entry, installedSource);
				const success = await runIsolated([process.execPath, entry, "success"], consumer);
				expect(success.buffer.ok).toBe(true);
				expect(success.buffer.content).toContain("Dummy PDF file");
				expect(success.file?.content).toContain("Dummy PDF file");
				expect(success.rendered).toEqual({
					signature: [137, 80, 78, 71, 13, 10, 26, 10],
					width: 240,
					height: 200,
					center: [255, 0, 0],
					corner: [255, 255, 255],
				});
				expect(success.mapping).toContain(mupdf);
				expect(success.mapping).not.toContain(repoRoot);
				const readEntry = path.join(installed, "published-read.ts");
				await Bun.write(
					readEntry,
					`
import { Settings } from "./src/config/settings";
import { ReadTool } from "./src/tools/read";
const session = { cwd: process.cwd(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => null, settings: Settings.isolated({ "fetch.enabled": true }) };
await Bun.write("read.pdf", ${JSON.stringify(dummyPdf())});
await Bun.write("invalid.pdf", "%PDF-1.4 malformed payload");
await Bun.write("image.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
const reader = new ReadTool(session);
const text = await reader.execute("published-text", { path: "read.pdf" });
if (!JSON.stringify(text).includes("Dummy PDF file")) throw new Error("Published read lost PDF text");
const image = await reader.execute("published-image", { path: "image.png" });
if (!image.content.some(item => item.type === "image" && item.mimeType === "image/png")) throw new Error("Published read lost image");
let diagnostic;
try { diagnostic = JSON.stringify(await reader.execute("published-invalid", { path: "invalid.pdf" })); }
catch (error) { diagnostic = String(error); }
if (!diagnostic.includes("MuPDF") || diagnostic.includes(${JSON.stringify(path.dirname(mupdf))}) || diagnostic.includes("build-time provenance")) throw new Error("Published read lost safe PDF diagnostic");
console.log(JSON.stringify({ buffer: { ok: true, content: "published read text/image/privacy" }, mapping: "" }));
`,
				);
				const read = await runIsolated([process.execPath, readEntry], consumer);
				expect(read.buffer.ok).toBe(true);
				// Damage only the installed loader; a fresh process must preserve its cause.
				await fs.rm(path.join(path.dirname(mupdf), "mupdf-wasm.js"));
				const failure = await runIsolated([process.execPath, entry, "loader-failure"], consumer);
				expect(failure.buffer.ok).toBe(false);
				expect(failure.buffer.error).toContain("AggregateError");
				expect(failure.buffer.error).toContain("MuPDF module initialization failed");
				expect(failure.buffer.error).toMatch(/Cannot find|Module not found/i);
				for (const privatePath of [directory, await fs.realpath(directory), repoRoot])
					expect(failure.buffer.error).not.toContain(privatePath);
				expect(failure.buffer.error).not.toContain("npm install");
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		}, 300_000);
	}
});

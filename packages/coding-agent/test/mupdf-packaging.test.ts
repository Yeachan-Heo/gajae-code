import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildDevCompileArgs,
	buildReleaseCompileArgs,
	devEntrypoints,
	releaseEntrypoints,
} from "../scripts/compile-args";
import { generateMuPdfAsset, resetMuPdfAsset } from "../scripts/embed-mupdf";
import { withMuPdfDiagnostic } from "../src/utils/mupdf";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageRoot = path.join(repoRoot, "packages/coding-agent");

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
import { extractPages, renderImageRegion } from ${JSON.stringify(fileURLToPath(new URL("./converters/pdf/extract.js", import.meta.resolve("markit-ai"))))};
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
	const mupdf = await import("mupdf");
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
	await new Promise(resolve => setTimeout(resolve, 20));
}
process.stdout.write(JSON.stringify({ buffer, file, rendered, recovery, faultedReads, mapping: mupdfAssetMapping }));
`;

interface ConversionOutput {
	buffer: { ok: boolean; content: string; error?: string };
	file?: { ok: boolean; content: string; error?: string };
	mapping: string;
	faultedReads?: number;
	recovery?: { ok: boolean; content: string; error?: string };
	rendered?: { signature: number[]; width: number; height: number; center: number[]; corner: number[] };
}

async function runIsolated(command: string[], cwd: string): Promise<ConversionOutput> {
	const child = Bun.spawn(command, {
		cwd,
		env: { HOME: cwd, TMPDIR: cwd, PATH: "", NODE_PATH: "", LANG: "C" },
		stdout: "pipe",
		stderr: "pipe",
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
				const dependency = path.join(layout === "nested" ? installed : directory, "node_modules/mupdf");
				const original = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("mupdf"))));
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
	it("keeps the original exception and its cause in the diagnostic error", () => {
		const rootCause = new WebAssembly.CompileError("invalid WASM");
		const failure = new Error("asset initialization failed", { cause: rootCause });
		const diagnostic = withMuPdfDiagnostic(failure);
		expect(diagnostic.cause).toBe(failure);
		expect(failure.cause).toBe(rootCause);
		expect(diagnostic.message).toContain("module mupdf");
		expect(diagnostic.message).toContain("mupdf-wasm.wasm ->");
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
				if (channel !== "source") expect(success.mapping).toContain("$bunfs");

				for (const mode of ["invalid-pdf", "wasm-failure"]) {
					const failure = await runIsolated([...command, mode], runtimeDir);
					expect(failure.buffer.ok).toBe(false);
					expect(failure.buffer.content).toBe("");
					expect(failure.buffer.error).toContain("module mupdf");
					expect(failure.buffer.error).toContain("mupdf-wasm.wasm ->");
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

#!/usr/bin/env bun
/** Reproduce the patched MIT converter; --check is strictly local and read-only. */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const packageRoot = path.resolve(import.meta.dir, "..");
const vendorRoot = path.join(packageRoot, "vendor");
const vendorDir = path.join(vendorRoot, "markit-ai");
const patchPath = path.join(vendorRoot, "markit-ai.patch");
const sourceUrl = "https://registry.npmjs.org/markit-ai/-/markit-ai-0.5.3.tgz";
const sourceIntegrity =
	"sha512-h4nhn6a/SNXEdc3kLVtL37TspxjUNCNL0OM7LRWxd389ZByI/B7bjNNgxFdVAT0O+H7ZekSwLdVe/lws1l2AZQ==";
const provenanceName = "MANIFEST.json";
const maxArchiveBytes = 16 * 1024 * 1024;

interface FileHash {
	path: string;
	sha256: string;
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function selectedFile(name: string): boolean {
	return name === "LICENSE" || name === "package.json" || name.startsWith("dist/");
}

async function inventory(directory: string): Promise<FileHash[]> {
	const files: FileHash[] = [];
	async function walk(relative: string): Promise<void> {
		const absolute = path.join(directory, relative);
		const metadata = await fs.lstat(absolute);
		if (metadata.isDirectory()) {
			if (relative !== "" && relative !== "dist" && !relative.startsWith("dist/")) {
				throw new Error(`Unexpected vendor directory: ${relative}`);
			}
			for (const name of (await fs.readdir(absolute)).sort()) {
				await walk(relative ? `${relative}/${name}` : name);
			}
		} else if (metadata.isFile()) {
			if (relative === provenanceName) return;
			if (!selectedFile(relative)) throw new Error(`Unexpected vendor file: ${relative}`);
			files.push({ path: relative, sha256: sha256(await Bun.file(absolute).bytes()) });
		} else {
			throw new Error(`Vendor entries must be regular files or directories: ${relative}`);
		}
	}
	await walk("");
	for (const required of [
		"LICENSE",
		"package.json",
		"dist/index.js",
		"dist/index.d.ts",
		"dist/converters/pdf/extract.js",
		"dist/markit.js",
	]) {
		if (!files.some(file => file.path === required)) throw new Error(`Missing vendor file: ${required}`);
	}
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function provenance(directory: string): Promise<string> {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			upstream: { name: "markit-ai", version: "0.5.3", license: "MIT", url: sourceUrl, integrity: sourceIntegrity },
			patch: { path: "../markit-ai.patch", sha256: sha256(await Bun.file(patchPath).bytes()) },
			files: await inventory(directory),
		},
		null,
		"\t",
	)}\n`;
}

async function verifyContents(directory: string): Promise<void> {
	const upstream = await Bun.file(path.join(directory, "package.json")).json();
	if (upstream.name !== "markit-ai" || upstream.version !== "0.5.3" || upstream.license !== "MIT") {
		throw new Error("Vendored manifest must identify MIT markit-ai@0.5.3");
	}
	const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();
	for (const dependency of Object.keys(upstream.dependencies)) {
		if (typeof manifest.dependencies?.[dependency] !== "string") {
			throw new Error(`Missing direct converter runtime dependency: ${dependency}`);
		}
	}
	if (manifest.dependencies.mupdf !== "1.28.0" || manifest.dependencies["markit-ai"] !== undefined) {
		throw new Error("Converter must use vendored Markit and pinned mupdf@1.28.0");
	}
	const extract = await Bun.file(path.join(directory, "dist/converters/pdf/extract.js")).text();
	const markit = await Bun.file(path.join(directory, "dist/markit.js")).text();
	if (
		/require\(["']mupdf["']\)/u.test(extract) ||
		!extract.includes("\nlet mupdf;\n") ||
		!extract.includes('mupdf = await import("mupdf")') ||
		!extract.includes('new Error("MuPDF module initialization failed", { cause })') ||
		!markit.includes("new AggregateError(errors.map((entry) => entry.error)") ||
		!markit.includes("{ cause: errors[0].error }")
	)
		throw new Error("Vendored Markit is missing the required MuPDF/diagnostics patch");
}

async function check(): Promise<void> {
	if (!(await fs.lstat(vendorRoot)).isDirectory()) throw new Error("Vendor root must be a real directory");
	if (!(await fs.lstat(patchPath)).isFile()) throw new Error("Vendor patch must be a regular file");
	// Inventory rejects symlinks before any content verification reads them.
	const expected = await provenance(vendorDir);
	if ((await Bun.file(path.join(vendorDir, provenanceName)).text()) !== expected) {
		throw new Error("Markit vendor inventory or patch hash differs; regenerate from the pinned artifact");
	}
	await verifyContents(vendorDir);
	process.stdout.write("Markit vendor verification passed (markit-ai@0.5.3, local hashes)\n");
}

async function download(): Promise<Uint8Array> {
	const response = await fetch(sourceUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
	if (!response.ok || !response.body) throw new Error(`Pinned Markit download failed: HTTP ${response.status}`);
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of response.body) {
		length += chunk.byteLength;
		if (length > maxArchiveBytes) throw new Error("Pinned Markit archive exceeds size limit");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks, length);
	if (`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` !== sourceIntegrity) {
		throw new Error("Pinned Markit archive integrity mismatch");
	}
	return bytes;
}

async function generate(): Promise<void> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vendor-markit-"));
	try {
		const bytes = await download();
		await Bun.write(path.join(temporaryRoot, "markit-ai-0.5.3.tgz"), bytes);
		const source = path.join(temporaryRoot, "source");
		await fs.mkdir(source);
		// Read verified archive entries as data and create only regular files. Never
		// ask an extractor to recreate upstream symlinks, permissions, or devices.
		const entries = await new Bun.Archive(bytes).files();
		let unpackedBytes = 0;
		for (const [name, file] of entries) {
			if (
				!name.startsWith("package/") ||
				name.includes("\\") ||
				name.includes("\0") ||
				name.split("/").some(part => part === "" || part === "." || part === "..")
			) {
				throw new Error(`Unsafe pinned archive entry: ${name}`);
			}
			unpackedBytes += file.size;
			if (unpackedBytes > maxArchiveBytes) throw new Error("Pinned Markit unpacked files exceed size limit");
			const relative = name.slice("package/".length);
			if (!selectedFile(relative)) continue;
			const destination = path.join(source, relative);
			await Bun.write(destination, file);
			await fs.chmod(destination, 0o644);
		}
		await $`git apply --check ${patchPath}`.cwd(source);
		await $`git apply ${patchPath}`.cwd(source);
		await verifyContents(source);
		await Bun.write(path.join(source, provenanceName), await provenance(source));
		if (!(await fs.lstat(vendorRoot)).isDirectory()) throw new Error("Vendor root must be a real directory");
		const existing = await fs.lstat(vendorDir).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (existing) {
			// Refuse unrelated contents and symlinks rather than silently deleting them.
			await inventory(vendorDir);
			const oldManifest = await Bun.file(path.join(vendorDir, "package.json")).json();
			if (oldManifest.name !== "markit-ai") throw new Error("Refusing to replace an unrelated vendor tree");
			await fs.rm(vendorDir, { recursive: true });
		}
		await fs.cp(source, vendorDir, { recursive: true, force: false, errorOnExist: true });
		await check();
	} finally {
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--generate")) {
		throw new Error("Use exactly --check (offline verification) or --generate (pinned regeneration)");
	}
	if (args[0] === "--generate") await generate();
	else await check();
}

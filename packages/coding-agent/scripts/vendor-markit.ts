#!/usr/bin/env bun
/** Reproduce the patched MIT converter; --check is strictly local and read-only. */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { createTwoFilesPatch } from "diff";

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

async function removalTokens(): Promise<string[]> {
	const patternPath = path.resolve(packageRoot, "../../scripts/agpl-removal-patterns.json");
	const patterns = (await Bun.file(patternPath).json()) as { tokens?: Array<{ value?: unknown }> };
	if (!Array.isArray(patterns.tokens) || patterns.tokens.some(rule => typeof rule.value !== "string" || !rule.value)) {
		throw new Error("Removal audit pattern file is malformed");
	}
	return patterns.tokens.map(rule => rule.value as string);
}

function includesRetiredIdentifier(value: string, tokens: readonly string[]): boolean {
	const lower = value.toLowerCase();
	return tokens.some(token => lower.includes(token.toLowerCase()));
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
			for (const name of (await fs.readdir(absolute)).sort()) await walk(relative ? `${relative}/${name}` : name);
		} else if (metadata.isFile()) {
			if (relative === provenanceName) return;
			if (!selectedFile(relative)) throw new Error(`Unexpected vendor file: ${relative}`);
			files.push({
				path: relative,
				sha256: crypto
					.createHash("sha256")
					.update(await Bun.file(absolute).bytes())
					.digest("hex"),
			});
		} else {
			throw new Error(`Vendor entries must be regular files or directories: ${relative}`);
		}
	}
	await walk("");
	for (const required of ["LICENSE", "package.json", "dist/index.js", "dist/index.d.ts", "dist/markit.js"]) {
		if (!files.some(file => file.path === required)) throw new Error(`Missing vendor file: ${required}`);
	}
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function provenance(directory: string): Promise<string> {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			upstream: { name: "markit-ai", version: "0.5.3", license: "MIT", url: sourceUrl, integrity: sourceIntegrity },
			patch: {
				path: "../markit-ai.patch",
				sha256: crypto
					.createHash("sha256")
					.update(await Bun.file(patchPath).bytes())
					.digest("hex"),
			},
			files: await inventory(directory),
		},
		null,
		"\t",
	)}\n`;
}

function replaceExactlyOnce(source: string, before: string, after: string, label: string): string {
	const index = source.indexOf(before);
	if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
		throw new Error(`Pinned converter source did not contain exactly one expected section: ${label}`);
	}
	return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

async function applyLocalChanges(directory: string, tokens: readonly string[]): Promise<void> {
	const markitPath = path.join(directory, "dist/markit.js");
	let markit = await Bun.file(markitPath).text();
	markit = replaceExactlyOnce(
		markit,
		'import { PdfConverter } from "./converters/pdf/index.js";\n',
		"",
		"PDF converter import",
	);
	markit = replaceExactlyOnce(markit, "            new PdfConverter(),\n", "", "PDF converter registration");
	const errorPlaceholder = "$" + "{details}";
	const originalError = `throw new Error(\`Conversion failed:\\n${errorPlaceholder}\`);`;
	const replacementError = `throw new AggregateError(errors.map((entry) => entry.error), \`Conversion failed:\\n${errorPlaceholder}\`, { cause: errors[0].error });`;
	markit = replaceExactlyOnce(markit, originalError, replacementError, "conversion error cause chain");
	await Bun.write(markitPath, markit);

	for (const file of ["dist/index.js", "dist/index.d.ts"]) {
		const filePath = path.join(directory, file);
		const source = await Bun.file(filePath).text();
		await Bun.write(
			filePath,
			replaceExactlyOnce(
				source,
				'export { PdfConverter } from "./converters/pdf/index.js";\n',
				"",
				"PDF converter public export",
			),
		);
	}

	const manifestPath = path.join(directory, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as { dependencies?: Record<string, string> };
	if (!manifest.dependencies) throw new Error("Pinned converter manifest has no dependencies object");
	let removed = 0;
	for (const dependency of Object.keys(manifest.dependencies)) {
		if (includesRetiredIdentifier(dependency, tokens)) {
			delete manifest.dependencies[dependency];
			removed += 1;
		}
	}
	if (removed !== 1) throw new Error("Pinned converter manifest must contain exactly one retired PDF dependency");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await fs.rm(path.join(directory, "dist/converters/pdf"), { recursive: true, force: true });
}

async function fileContents(directory: string): Promise<Map<string, Buffer>> {
	const contents = new Map<string, Buffer>();
	for (const file of await inventory(directory))
		contents.set(file.path, Buffer.from(await Bun.file(path.join(directory, file.path)).bytes()));
	return contents;
}

function gitBlobHash(bytes: Buffer | undefined): string {
	if (!bytes) return "0".repeat(40);
	return crypto
		.createHash("sha1")
		.update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
		.digest("hex");
}

async function makePatch(original: string, updated: string): Promise<string> {
	const before = await fileContents(original);
	const after = await fileContents(updated);
	const names = [...new Set([...before.keys(), ...after.keys()])].sort();
	const chunks: string[] = [];
	for (const name of names) {
		const oldBytes = before.get(name);
		const newBytes = after.get(name);
		if (oldBytes && newBytes && oldBytes.equals(newBytes)) continue;
		const diff = createTwoFilesPatch(
			oldBytes ? `a/${name}` : "/dev/null",
			newBytes ? `b/${name}` : "/dev/null",
			oldBytes?.toString("utf8") ?? "",
			newBytes?.toString("utf8") ?? "",
		).replace(/^={10,}\n/u, "");
		chunks.push(
			`diff --git a/${name} b/${name}\n${oldBytes ? "" : "new file mode 100644\n"}${newBytes ? "" : "deleted file mode 100644\n"}index ${gitBlobHash(oldBytes)}..${gitBlobHash(newBytes)} 100644\n${diff}`,
		);
	}
	return chunks.join("");
}

async function verifyContents(directory: string): Promise<void> {
	const upstream = (await Bun.file(path.join(directory, "package.json")).json()) as {
		name?: unknown;
		version?: unknown;
		license?: unknown;
		dependencies?: Record<string, string>;
	};
	if (upstream.name !== "markit-ai" || upstream.version !== "0.5.3" || upstream.license !== "MIT") {
		throw new Error("Vendored manifest must identify MIT markit-ai@0.5.3");
	}
	const tokens = await removalTokens();
	const rootManifest = (await Bun.file(path.join(packageRoot, "package.json")).json()) as {
		dependencies?: Record<string, string>;
	};
	for (const dependency of Object.keys(upstream.dependencies ?? {})) {
		if (typeof rootManifest.dependencies?.[dependency] !== "string") {
			throw new Error(`Missing direct converter runtime dependency: ${dependency}`);
		}
	}
	if (Object.keys(rootManifest.dependencies ?? {}).some(dependency => includesRetiredIdentifier(dependency, tokens))) {
		throw new Error("Coding-agent still declares a retired PDF runtime dependency");
	}
	const files = await inventory(directory);
	for (const file of files) {
		if (includesRetiredIdentifier(file.path, tokens))
			throw new Error("Vendored converter contains a retired PDF file path");
		const contents = Buffer.from(await Bun.file(path.join(directory, file.path)).bytes()).toString("latin1");
		if (includesRetiredIdentifier(contents, tokens))
			throw new Error("Vendored converter contains a retired PDF runtime reference");
	}
	if (files.some(file => file.path.startsWith("dist/converters/pdf/")))
		throw new Error("Vendored converter still contains PDF modules");
	const [markit, index, declarations] = await Promise.all([
		Bun.file(path.join(directory, "dist/markit.js")).text(),
		Bun.file(path.join(directory, "dist/index.js")).text(),
		Bun.file(path.join(directory, "dist/index.d.ts")).text(),
	]);
	if (
		markit.includes("PdfConverter") ||
		index.includes("PdfConverter") ||
		declarations.includes("PdfConverter") ||
		!markit.includes("new AggregateError(errors.map((entry) => entry.error)") ||
		!markit.includes("{ cause: errors[0].error }")
	) {
		throw new Error("Vendored Markit must remove the PDF converter and preserve conversion causes");
	}
}

async function check(): Promise<void> {
	if (!(await fs.lstat(vendorRoot)).isDirectory()) throw new Error("Vendor root must be a real directory");
	if (!(await fs.lstat(patchPath)).isFile()) throw new Error("Vendor patch must be a regular file");
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
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > maxArchiveBytes) throw new Error("Pinned Markit archive exceeds size limit");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks, size);
	if (`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` !== sourceIntegrity) {
		throw new Error("Pinned Markit archive integrity mismatch");
	}
	return bytes;
}

async function generate(): Promise<void> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-vendor-markit-"));
	try {
		const bytes = await download();
		const source = path.join(temporaryRoot, "source");
		const updated = path.join(temporaryRoot, "updated");
		await fs.mkdir(source);
		const archiveEntries = await new Bun.Archive(bytes).files();
		let unpackedSize = 0;
		for (const [name, file] of archiveEntries) {
			if (
				!name.startsWith("package/") ||
				name.includes("\\") ||
				name.includes("\0") ||
				name.split("/").some(part => !part || part === "." || part === "..")
			) {
				throw new Error(`Unsafe pinned archive entry: ${name}`);
			}
			unpackedSize += file.size;
			if (unpackedSize > maxArchiveBytes) throw new Error("Pinned Markit unpacked files exceed size limit");
			const relative = name.slice("package/".length);
			if (!selectedFile(relative)) continue;
			const destination = path.join(source, relative);
			await Bun.write(destination, file);
			await fs.chmod(destination, 0o644);
		}
		await fs.cp(source, updated, { recursive: true });
		await applyLocalChanges(updated, await removalTokens());
		const patch = await makePatch(source, updated);
		const temporaryPatch = path.join(temporaryRoot, "markit-ai.patch");
		await Bun.write(temporaryPatch, patch);
		await $`git apply --check ${temporaryPatch}`.cwd(source);
		await $`git apply ${temporaryPatch}`.cwd(source);
		await verifyContents(source);
		await Bun.write(patchPath, patch);
		await Bun.write(path.join(source, provenanceName), await provenance(source));

		if (!(await fs.lstat(vendorRoot)).isDirectory()) throw new Error("Vendor root must be a real directory");
		const existing = await fs.lstat(vendorDir).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (existing) {
			await inventory(vendorDir);
			const manifest = await Bun.file(path.join(vendorDir, "package.json")).json();
			if (manifest.name !== "markit-ai") throw new Error("Refusing to replace an unrelated vendor tree");
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

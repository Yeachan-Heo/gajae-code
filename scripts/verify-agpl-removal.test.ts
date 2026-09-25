import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

interface TokenRule {
	id: string;
	value: string;
}
interface PatternFile {
	tokens: TokenRule[];
	signatures: { npmPackageIntegrity: string; embeddedWasmSha256: string };
	allowlist: Array<{ type: string; pattern: string; heading?: string; reason: string }>;
}
interface Finding {
	input: string;
	member?: string;
	offset: number;
	rule: string;
	verdict: "PASS" | "FAIL";
	reason?: string;
	attributedTo?: { path: string; sha256: string };
}
interface AuditReport {
	status: "PASS" | "FAIL";
	findings: Finding[];
}
interface TarFixtureEntry {
	path: string;
	data: Buffer;
	type?: string;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const scanner = path.join(import.meta.dir, "verify-agpl-removal.ts");
const basePatterns = (await Bun.file(path.join(import.meta.dir, "agpl-removal-patterns.json")).json()) as PatternFile;
const roots: string[] = [];
const tokenFor = (id: string): string => {
	const rule = basePatterns.tokens.find(candidate => candidate.id === id);
	if (!rule) throw new Error(`missing pattern rule: ${id}`);
	return rule.value;
};
const identifier = tokenFor("packageIdentifier");
const noticeHeading = basePatterns.allowlist.find(rule => rule.type === "heading")!.heading!;
const wasmMagic = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function writeFiles(root: string, entries: Record<string, string | Uint8Array>): Promise<void> {
	for (const [relative, content] of Object.entries(entries)) {
		const destination = path.join(root, relative);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await Bun.write(destination, content);
	}
}

function scan(root: string, mode: "--active-refs" | "--payload", args: string[] = []) {
	const child = Bun.spawnSync([process.execPath, scanner, mode, "--root", root, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = child.stdout.toString("utf8");
	const report = JSON.parse(stdout) as AuditReport;
	return { exitCode: child.exitCode, report, stderr: child.stderr.toString("utf8") };
}

async function makeGitRoot(files: Record<string, string> = {}): Promise<string> {
	const root = await makeRoot("gjc-agpl-refs-");
	await writeFiles(root, {
		"package.json": JSON.stringify({ name: "audit-fixture", workspaces: { catalog: {} } }),
		"bun.lock": JSON.stringify({ lockfileVersion: 1, packages: {} }),
		"packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", dependencies: {} }),
		"packages/x/src/index.ts": "export const ready = true;\n",
		"packages/x/scripts/build.ts": "export const ready = true;\n",
		"packages/x/test/plain.test.ts": "const proseOnly = 'ignored test prose';\n",
		"packages/x/changelog.d/history.md": "Historical release note.\n",
		"packages/x/CHANGELOG.md": "## Released\nHistorical release note.\n",
		"NOTICE.md": `# Notices\n\nCurrent notice content.\n\n${noticeHeading}\n\nHistorical note.\n`,
		"docs/rust-porting-plan.md": "Inventory plan.\n",
		"packages/coding-agent/vendor/markit-ai.patch": "diff --git a/file b/file\n-old line\n",
		".github/workflows/ci.yml": "jobs:\n  binaries:\n    steps: []\n",
		"scripts/agpl-removal-patterns.json": await Bun.file(path.join(import.meta.dir, "agpl-removal-patterns.json")).text(),
		...files,
	});
	for (const command of [["git", "init", "--quiet"], ["git", "add", "-A"]]) {
		const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
	}
	return root;
}

function octal(header: Buffer, offset: number, width: number, value: number): void {
	header.write(value.toString(8).padStart(width - 1, "0"), offset, width - 1, "ascii");
	header[offset + width - 1] = 0;
}

function tarHeader(filePath: string, data: Buffer, type = "0"): Buffer {
	const header = Buffer.alloc(512);
	header.write(filePath, 0, "utf8");
	octal(header, 100, 8, 0o644);
	octal(header, 108, 8, 0);
	octal(header, 116, 8, 0);
	octal(header, 124, 12, data.length);
	octal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	header[156] = type.charCodeAt(0);
	header.write("ustar", 257, "ascii");
	header[262] = 0;
	header.write("00", 263, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function tarball(entries: readonly TarFixtureEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		blocks.push(tarHeader(entry.path, entry.data, entry.type ?? "0"), entry.data);
		const padding = (512 - (entry.data.length % 512)) % 512;
		if (padding) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

interface PackageOptions {
	files?: Record<string, string | Uint8Array>;
	manifestDependencies?: Record<string, string>;
	vendorDependencies?: Record<string, string>;
	changelog?: string;
	patterns?: PatternFile;
}

async function makePackage(options: PackageOptions = {}): Promise<{ root: string; archive: string }> {
	const root = await makeRoot("gjc-agpl-payload-");
	const patterns: PatternFile = options.patterns ?? basePatterns;
	await writeFiles(root, {
		"scripts/agpl-removal-patterns.json": `${JSON.stringify(patterns, null, 2)}\n`,
		"packages/coding-agent/package.json": JSON.stringify({
			name: "@gajae-code/coding-agent",
			version: "0.17.6",
			files: ["CHANGELOG.md", "README.md", "changelog.d", "src", "vendor", "!vendor/markit-ai.patch"],
			dependencies: options.manifestDependencies ?? {},
		}),
		"packages/coding-agent/CHANGELOG.md": options.changelog ?? `Historical release text mentions ${identifier}.\n`,
		"packages/coding-agent/README.md": "Ordinary package prose.\n",
		"packages/coding-agent/changelog.d/a.md": `Release note: removed ${identifier}.\n`,
		"packages/coding-agent/src/index.js": "export const ready = true;\n",
		"packages/coding-agent/src/internal-urls/docs-index.generated.ts": "export const docs = [];\n",
		"packages/coding-agent/vendor/markit-ai/dist/markit.js": "export const converter = true;\n",
		"packages/coding-agent/vendor/markit-ai/package.json": JSON.stringify({
			name: "vendor-converter",
			version: "0.5.3",
			dependencies: options.vendorDependencies ?? {},
		}),
		...(options.files ?? {}),
	});
	await writeFiles(root, {
		"artifacts/gjc.bin": "safe binary fixture",
		"docs/guide.md": "A document with ordinary text.\n",
	});
	const destination = path.join(root, "artifacts/packed");
	await fs.mkdir(destination, { recursive: true });
	const result = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", destination], {
		cwd: path.join(root, "packages/coding-agent"),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`bun pm pack failed: ${result.stderr.toString("utf8")}`);
	const archives = (await fs.readdir(destination)).filter(name => name.endsWith(".tgz"));
	if (archives.length !== 1) throw new Error(`expected one archive, found ${archives.length}`);
	return { root, archive: path.join(destination, archives[0]!) };
}

async function payload(root: string, archive: string, extra: string[] = []) {
	return scan(root, "--payload", ["--tarball", archive, "--binary", "artifacts/gjc.bin", "--prose-root", ".", ...extra]);
}

async function compileFixture(root: string, source: string, files: Record<string, string>): Promise<string> {
	const sourcePath = path.join(root, "entry.ts");
	await Bun.write(sourcePath, source);
	await writeFiles(root, files);
	const output = path.join(root, "compiled-fixture");
	const result = Bun.spawnSync([
		process.execPath,
		"build",
		"--compile",
		"--minify",
		"--keep-names",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-tsconfig",
		"--no-compile-autoload-package-json",
		sourcePath,
		"--outfile",
		output,
	], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`compiled fixture failed: ${result.stderr.toString("utf8")}`);
	return output;
}

it("uses the existing bounded tar reader rather than implementing another parser", async () => {
		const evidence = await Bun.file(path.join(import.meta.dir, "release-evidence.ts")).text();
		const scannerSource = await Bun.file(scanner).text();
		expect(evidence.match(/^export interface PackageTarballMember \{/gmu)).toHaveLength(1);
		expect(evidence.match(/^export function readPackageTarballMembers\(/gmu)).toHaveLength(1);
		expect(evidence).not.toMatch(/^export (?:function parseTarEntries|interface TarEntry)\b/gmu);
		expect(scannerSource).not.toMatch(/\b(?:gunzip|ustar|parseTarEntries)\b/u);
	});
describe("scoped active PDF dependency reference audit", () => {
	it("allows configured release prose and negative lines of the vendored patch", async () => {
		const root = await makeGitRoot({
			"packages/x/changelog.d/history.md": `Removed ${identifier}.\n`,
			"packages/x/CHANGELOG.md": `## Released\nRemoved ${identifier}.\n`,
			"NOTICE.md": `# Notices\n\nCurrent notice.\n\n${noticeHeading}\n\nRemoved ${identifier}.\n`,
			"docs/rust-porting-plan.md": `Planning note: ${identifier}.\n`,
			"packages/x/test/plain.test.ts": `const proseOnly = ${JSON.stringify(identifier)};\n`,
			"packages/coding-agent/vendor/markit-ai.patch": `diff --git a/file b/file\n-${identifier}\n`,
		});
		const result = scan(root, "--active-refs");
		expect(result.exitCode).toBe(0);
		expect(result.report.status).toBe("PASS");
	});

	it("fails injected active imports, script calls, manifests, lock entries, CI edges, assets, and added patch lines", async () => {
		const cases: Array<[string, string]> = [
			["packages/x/src/dynamic.ts", `void import(${JSON.stringify(identifier)});\n`],
			["packages/x/scripts/build.ts", `require(${JSON.stringify(identifier)});\n`],
			["package.json", JSON.stringify({ name: "root", dependencies: { [identifier]: "1" } })],
			["packages/x/package.json", JSON.stringify({ name: "x", dependencies: { [identifier]: "1" } })],
			["bun.lock", JSON.stringify({ packages: { [identifier]: [identifier] } })],
			[".github/workflows/ci.yml", `jobs:\n  binaries:\n    needs: [${tokenFor("releaseCiJob")}]\n`],
			["scripts/ci-release-build-binaries.ts", `function obsolete() { return ${JSON.stringify(tokenFor("wasmEmbedScript"))}; }\n`],
			[".github/workflows/ci.yml", `expectedAssets: [${JSON.stringify(identifier)}]\n`],
			["packages/coding-agent/vendor/markit-ai.patch", `diff --git a/file b/file\n+${identifier}\n`],
		];
		for (const [file, content] of cases) {
			const root = await makeGitRoot({ [file]: content });
			const result = scan(root, "--active-refs");
			expect(result.exitCode).toBe(2, file);
			expect(result.report.status).toBe("FAIL", file);
		}
	});

	it("fails a notice hit outside the history heading", async () => {
		const root = await makeGitRoot({ "NOTICE.md": `# Notices\n${identifier}\n\n${noticeHeading}\nHistorical note.\n` });
		const result = scan(root, "--active-refs");
		expect(result.exitCode).toBe(2);
		expect(result.report.findings.some(finding => finding.input === "NOTICE.md" && finding.verdict === "FAIL")).toBe(true);
	});
	it("keeps configured binary signatures out of prose sources", async () => {
		const prosePaths = [
			"packages/coding-agent/CHANGELOG.md",
			"NOTICE.md",
			...(await Array.fromAsync(new Bun.Glob("packages/*/changelog.d/*.md").scan({ cwd: repoRoot }))),
			...(await Array.fromAsync(new Bun.Glob("docs/**/*.md").scan({ cwd: repoRoot }))),
		];
		for (const relative of prosePaths) {
			const text = await Bun.file(path.join(repoRoot, relative)).text();
			expect(text).not.toContain(basePatterns.signatures.npmPackageIntegrity);
			expect(text).not.toContain(basePatterns.signatures.embeddedWasmSha256);
		}
	});
});

describe("member-scoped release payload audit", () => {
	it("passes prose changelogs but fails the same token planted in runtime JavaScript", async () => {
		const pass = await makePackage();
		const clean = await payload(pass.root, pass.archive);
		expect(clean.exitCode).toBe(0);
		expect(clean.report.status).toBe("PASS");
		expect(clean.report.findings.some(finding => finding.member === "package/CHANGELOG.md" && finding.verdict === "PASS")).toBe(true);

		const planted = await makePackage({ files: { "packages/coding-agent/vendor/markit-ai/dist/markit.js": `const runtimeToken = ${JSON.stringify(identifier)};\n` } });
		const failed = await payload(planted.root, planted.archive);
		expect(failed.exitCode).toBe(2);
		expect(failed.report.findings.some(finding => finding.member === "package/vendor/markit-ai/dist/markit.js" && finding.verdict === "FAIL")).toBe(true);
	});

	it("fails source text and dependencies in both packed manifests", async () => {
		for (const options of [
			{ files: { "packages/coding-agent/src/utils/x.ts": `const token = ${JSON.stringify(identifier)};\n` } },
			{ manifestDependencies: { [identifier]: "1" } },
			{ vendorDependencies: { [identifier]: "1" } },
		]) {
			const fixture = await makePackage(options);
			const result = await payload(fixture.root, fixture.archive);
			expect(result.exitCode).toBe(2);
			expect(result.report.status).toBe("FAIL");
		}
	});

	it("keeps signature scans strict in changelog prose", async () => {
		const wasmModule = Buffer.concat([wasmMagic, Buffer.from([1, 1, 0])]);
		const wasmSha256 = createHash("sha256").update(wasmModule).digest("hex");
		const patterns = { ...basePatterns, signatures: { ...basePatterns.signatures, embeddedWasmSha256: wasmSha256 } };
		const changelog = Buffer.concat([
			Buffer.from(`Historical note contains ${basePatterns.signatures.npmPackageIntegrity} and the WebAssembly signature.\n`),
			wasmModule,
		]);
		const fixture = await makePackage({ patterns, files: { "packages/coding-agent/CHANGELOG.md": changelog } });
		const result = await payload(fixture.root, fixture.archive);
		expect(result.exitCode).toBe(2);
		expect(result.report.findings.some(finding => finding.member === "package/CHANGELOG.md" && finding.rule === "npm-package-integrity")).toBe(true);
		expect(result.report.findings.some(finding => finding.member === "package/CHANGELOG.md" && finding.rule === "embedded-wasm-module")).toBe(true);
	});

	it("attributes a docs-index hit only to identical text from the build tree", async () => {
		const document = `Documentation paragraph before ${identifier} and after the removed dependency. This exact prose is embedded in the index.`;
		const pass = await makePackage({
			files: { "packages/coding-agent/src/internal-urls/docs-index.generated.ts": `export const docs = ${JSON.stringify(document)};\n` },
		});
		await Bun.write(path.join(pass.root, "docs/guide.md"), `${document}\n`);
		const passing = await payload(pass.root, pass.archive);
		expect(passing.exitCode).toBe(0);
		const attribution = passing.report.findings.find(finding => finding.member === "package/src/internal-urls/docs-index.generated.ts");
		expect(attribution?.verdict).toBe("PASS");
		expect(attribution?.attributedTo?.path).toBe("docs/guide.md");
		expect(attribution?.attributedTo?.sha256).toBe(createHash("sha256").update(`${document}\n`).digest("hex"));

		const planted = await makePackage({
			files: { "packages/coding-agent/src/internal-urls/docs-index.generated.ts": `export const ${identifier} = [];\n` },
		});
		const failing = await payload(planted.root, planted.archive);
		expect(failing.exitCode).toBe(2);
		expect(failing.report.findings.some(finding => finding.member === "package/src/internal-urls/docs-index.generated.ts" && finding.verdict === "FAIL")).toBe(true);

		const mismatch = await makePackage({
			files: { "packages/coding-agent/src/internal-urls/docs-index.generated.ts": `export const docs = ${JSON.stringify(document)};\n` },
		});
		await Bun.write(path.join(mismatch.root, "docs/guide.md"), `${document.replace("paragraph before", "tampered paragraph before")}\n`);
		const mismatched = await payload(mismatch.root, mismatch.archive);
		expect(mismatched.exitCode).toBe(2);
		expect(mismatched.report.findings.some(finding => finding.member === "package/src/internal-urls/docs-index.generated.ts" && finding.verdict === "FAIL")).toBe(true);
	});

	it("fails binary tokens in UTF-8 and UTF-16LE and a matching WebAssembly module hash", async () => {
		for (const encoded of [Buffer.from(identifier, "utf8"), Buffer.from(identifier, "utf16le")]) {
			const fixture = await makePackage({ files: { "packages/coding-agent/src/runtime.node": encoded } });
			const result = await payload(fixture.root, fixture.archive);
			expect(result.exitCode).toBe(2);
			expect(result.report.findings.some(finding => finding.member === "package/src/runtime.node" && finding.verdict === "FAIL")).toBe(true);
		}

		const wasmModule = Buffer.concat([wasmMagic, Buffer.from([1, 1, 0])]);
		const signature = createHash("sha256").update(wasmModule).digest("hex");
		const patterns = { ...basePatterns, signatures: { ...basePatterns.signatures, embeddedWasmSha256: signature } };
		const fixture = await makePackage({ patterns, files: { "packages/coding-agent/src/runtime.wasm": Buffer.concat([wasmModule, Buffer.from([0xff])]) } });
		const result = await payload(fixture.root, fixture.archive);
		expect(result.exitCode).toBe(2);
		expect(result.report.findings.some(finding => finding.rule === "embedded-wasm-module")).toBe(true);

		const addon = await makePackage();
		const addonPath = "artifacts/copied.node";
		await Bun.write(path.join(addon.root, addonPath), Buffer.concat([Buffer.from("native-addon"), Buffer.from(identifier, "utf8")]));
		const addonResult = await payload(addon.root, addon.archive, ["--addon", addonPath]);
		expect(addonResult.exitCode).toBe(2);
		expect(addonResult.report.findings.some(finding => finding.input === addonPath && finding.verdict === "FAIL")).toBe(true);
	});

	it("reports rejected traversal and oversized tarballs as failures rather than skipped scans", async () => {
		const traversal = await makePackage();
		const unsafePath = path.join(traversal.root, "artifacts/traversal.tgz");
		await Bun.write(unsafePath, tarball([{ path: "package/../escape.js", data: Buffer.from("x") }]));
		const traversalResult = await payload(traversal.root, unsafePath);
		expect(traversalResult.exitCode).toBe(2);
		expect(traversalResult.report.findings.some(finding => finding.rule === "tarball-reader" && finding.reason?.includes("unsafe"))).toBe(true);

		const oversized = await makePackage();
		const oversizedTarball = path.join(oversized.root, "artifacts/oversized.tgz");
		await Bun.write(oversizedTarball, tarball([{ path: "package/large.js", data: Buffer.alloc(32) }]));
		const oversizedResult = await payload(oversized.root, oversizedTarball, ["--tarball-limits-json", JSON.stringify({ maxCompressedBytes: 1024, maxUnpackedBytes: 2048, maxEntryBytes: 16, maxFileCount: 4 })]);
		expect(oversizedResult.exitCode).toBe(2);
		expect(oversizedResult.report.findings.some(finding => finding.rule === "tarball-reader" && finding.reason?.includes("exceeds 16"))).toBe(true);
	});
});

describe("compiled payload token attribution", () => {
	it("accepts changelog prose but rejects code literals and dynamic imports", async () => {
		const root = await makeRoot("gjc-agpl-compiled-");
		const prose = `Historical release note includes require("${identifier}") as a removed example.`;
		await writeFiles(root, { "CHANGELOG.md": `${prose}\n` });
		const passBinary = await compileFixture(root, 'import text from "./CHANGELOG.md" with { type: "text" }; process.stdout.write(text);\n', {});
		const passRoot = await makePackage({ changelog: `${prose}\n` });
		const pass = await payload(passRoot.root, passRoot.archive, ["--binary", passBinary]);
		expect(pass.exitCode).toBe(0);
		expect(pass.report.findings.some(finding => finding.input === path.relative(passRoot.root, passBinary) && finding.verdict === "PASS" && finding.attributedTo?.path.endsWith("CHANGELOG.md"))).toBe(true);

		const literalRoot = await makePackage({ changelog: `${prose}\n` });
		const literal = await compileFixture(literalRoot.root, `const planted = ${JSON.stringify(identifier)}; process.stdout.write(planted);\n`, {});
		const literalResult = await payload(literalRoot.root, literalRoot.archive, ["--binary", literal]);
		expect(literalResult.exitCode).toBe(2);
		expect(literalResult.report.findings.some(finding => finding.input === path.relative(literalRoot.root, literal) && finding.verdict === "FAIL")).toBe(true);

		const importRoot = await makePackage({ changelog: `${prose}\n` });
		const importBinary = await compileFixture(
			importRoot.root,
			`const target = process.env.PDF_FIXTURE_TARGET ?? ${JSON.stringify(`./${identifier}.js`)}; const module = await import(target); process.stdout.write(String(module.value));\n`,
			{ [`${identifier}.js`]: "export const value = true;\n" },
		);
		const importResult = await payload(importRoot.root, importRoot.archive, ["--binary", importBinary]);
		expect(importResult.exitCode).toBe(2);
		expect(importResult.report.findings.some(finding => finding.input === path.relative(importRoot.root, importBinary) && finding.verdict === "FAIL")).toBe(true);
	}, 240_000);

	it("rejects a compiled binary that embeds the signature-matched WebAssembly asset", async () => {
		const wasmModule = Buffer.concat([wasmMagic, Buffer.from([1, 1, 0])]);
		const wasmSha256 = createHash("sha256").update(wasmModule).digest("hex");
		const patterns = { ...basePatterns, signatures: { ...basePatterns.signatures, embeddedWasmSha256: wasmSha256 } };
		const fixture = await makePackage({ patterns });
		const binary = await compileFixture(
			fixture.root,
			'import embeddedAsset from "./embedded.wasm" with { type: "file" }; process.stdout.write(embeddedAsset);\n',
			{ "embedded.wasm": Buffer.concat([wasmModule, Buffer.from([0xff])]) },
		);
		const result = await payload(fixture.root, fixture.archive, ["--binary", binary]);
		expect(result.exitCode).toBe(2);
		expect(result.report.findings.some(finding => finding.rule === "embedded-wasm-module" && finding.input === path.relative(fixture.root, binary))).toBe(true);
	}, 240_000);
});

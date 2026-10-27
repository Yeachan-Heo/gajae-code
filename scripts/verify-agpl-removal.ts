#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	readPackageTarballMembers,
	RELEASE_TARBALL_LIMITS,
	type PackageTarballMember,
	type TarballLimits,
} from "./release-evidence";

interface TokenRule {
	id: string;
	value: string;
	reason: string;
}

interface AllowRule {
	type: "file" | "glob" | "heading";
	pattern: string;
	heading?: string;
	reason: string;
}

interface PatternFile {
	schemaVersion: 1;
	tokens: TokenRule[];
	signatures: { npmPackageIntegrity: string; embeddedWasmSha256: string };
	allowlist: AllowRule[];
}

interface CliOptions {
	mode: "active-refs" | "payload";
	root: string;
	patternFile?: string;
	tarball?: string;
	binaries: string[];
	addons: string[];
	proseRoot?: string;
	tarballLimits?: Partial<TarballLimits>;
}

interface ProseSource {
	path: string;
	text: string;
	sha256: string;
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
	schemaVersion: 1;
	mode: CliOptions["mode"];
	status: "PASS" | "FAIL";
	findings: Finding[];
}

const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MANIFEST_DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"bundleDependencies",
] as const;
const BINARY_EXTENSIONS = new Set([
	".7z",
	".aac",
	".aiff",
	".apng",
	".ar",
	".avif",
	".bmp",
	".bz2",
	".eot",
	".exr",
	".flac",
	".gif",
	".gz",
	".heic",
	".heif",
	".hdr",
	".ico",
	".icns",
	".jar",
	".jng",
	".jp2",
	".jpeg",
	".jpg",
	".jxl",
	".m4a",
	".m4v",
	".mkv",
	".mov",
	".mp3",
	".mp4",
	".mpeg",
	".mpg",
	".node",
	".ogg",
	".otf",
	".pdf",
	".png",
	".psd",
	".rar",
	".raw",
	".svgz",
	".tar",
	".tgz",
	".tif",
	".tiff",
	".ttf",
	".wav",
	".webm",
	".webp",
	".woff",
	".woff2",
	".wasm",
	".xz",
	".zip",
]);

function fail(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePatterns(value: unknown): PatternFile {
	if (!isRecord(value) || value.schemaVersion !== 1) fail("pattern file must use schemaVersion 1");
	if (!Array.isArray(value.tokens) || value.tokens.length === 0) fail("pattern file must define token rules");
	const tokens = value.tokens.map((entry, index): TokenRule => {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			typeof entry.value !== "string" ||
			!/^[\x21-\x7e]+$/u.test(entry.value) ||
			typeof entry.reason !== "string" ||
			entry.reason.trim() === ""
		) {
			fail(`token rule ${index} is malformed`);
		}
		return { id: entry.id, value: entry.value, reason: entry.reason };
	});
	if (new Set(tokens.map(rule => rule.id)).size !== tokens.length) fail("token rule ids must be unique");
	if (!isRecord(value.signatures)) fail("pattern file must define signature rules");
	const integrity = value.signatures.npmPackageIntegrity;
	const wasmSha256 = value.signatures.embeddedWasmSha256;
	if (typeof integrity !== "string" || integrity === "" || typeof wasmSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(wasmSha256)) {
		fail("signature rules are malformed");
	}
	if (!Array.isArray(value.allowlist)) fail("pattern file must define an allowlist");
	const allowlist = value.allowlist.map((entry, index): AllowRule => {
		if (
			!isRecord(entry) ||
			(entry.type !== "file" && entry.type !== "glob" && entry.type !== "heading") ||
			typeof entry.pattern !== "string" ||
			typeof entry.reason !== "string" ||
			entry.reason.trim() === "" ||
			(entry.type === "heading" && typeof entry.heading !== "string")
		) {
			fail(`allowlist rule ${index} is malformed`);
		}
		return {
			type: entry.type,
			pattern: entry.pattern,
			...(typeof entry.heading === "string" ? { heading: entry.heading } : {}),
			reason: entry.reason,
		};
	});
	return { schemaVersion: 1, tokens, signatures: { npmPackageIntegrity: integrity, embeddedWasmSha256: wasmSha256 }, allowlist };
}

function parseLimits(value: unknown): Partial<TarballLimits> {
	if (!isRecord(value)) fail("tarball limits must be a JSON object");
	const fields = new Set(["maxCompressedBytes", "maxUnpackedBytes", "maxEntryBytes", "maxFileCount"]);
	const limits: Partial<TarballLimits> = {};
	for (const [name, size] of Object.entries(value)) {
		if (!fields.has(name) || !Number.isSafeInteger(size) || (size as number) <= 0) fail(`invalid tarball limit ${name}`);
		limits[name as keyof TarballLimits] = size as number;
	}
	return limits;
}

function parseCli(argv: string[], root: string): CliOptions {
	const modeArg = argv[0];
	if (modeArg !== "--active-refs" && modeArg !== "--payload") fail("use --active-refs or --payload");
	const options: CliOptions = { mode: modeArg.slice(2) as CliOptions["mode"], root, binaries: [], addons: [] };
	for (let index = 1; index < argv.length; index += 1) {
		const flag = argv[index]!;
		const next = argv[index + 1];
		if (["--root", "--pattern-file", "--tarball", "--prose-root", "--tarball-limits-json"].includes(flag)) {
			if (!next || next.startsWith("--")) fail(`${flag} requires a value`);
			if (flag === "--root") options.root = path.resolve(next);
			else if (flag === "--pattern-file") options.patternFile = path.resolve(next);
			else if (flag === "--tarball") {
				if (options.tarball) fail("--tarball may be supplied once");
				options.tarball = next;
			} else if (flag === "--prose-root") options.proseRoot = next;
			else options.tarballLimits = parseLimits(JSON.parse(next));
			index += 1;
			continue;
		}
		if (flag === "--binary" || flag === "--addon") {
			const values: string[] = [];
			while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) values.push(argv[++index]!);
			if (values.length === 0) fail(`${flag} requires at least one path`);
			(flag === "--binary" ? options.binaries : options.addons).push(...values);
			continue;
		}
		fail(`unknown argument ${flag}`);
	}
	if (options.mode === "payload") {
		if (!options.tarball || !options.proseRoot || options.binaries.length + options.addons.length === 0) {
			fail("--payload requires --tarball, --prose-root, and at least one --binary or --addon");
		}
	}
	return options;
}

function posixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		if (pattern[index] === "*" && pattern[index + 1] === "*") {
			source += ".*";
			index += 1;
		} else if (pattern[index] === "*") source += "[^/]*";
		else source += escapeRegExp(pattern[index]!);
	}
	return new RegExp(`${source}$`, "u");
}

function matchingAllowRules(patterns: PatternFile, file: string): AllowRule[] {
	return patterns.allowlist.filter(rule => rule.type === "glob" ? globRegExp(rule.pattern).test(file) : rule.pattern === file);
}

function findMatches(value: string, token: string): number[] {
	const lower = value.toLowerCase();
	const needle = token.toLowerCase();
	const positions: number[] = [];
	let cursor = 0;
	while (cursor <= lower.length - needle.length) {
		const offset = lower.indexOf(needle, cursor);
		if (offset < 0) break;
		positions.push(offset);
		cursor = offset + 1;
	}
	return positions;
}

function findByteMatches(bytes: Buffer, token: string, encoding: "utf8" | "utf16le"): number[] {
	const needle = Buffer.from(token.toLowerCase(), encoding);
	const stride = encoding === "utf16le" ? 2 : 1;
	const firstLower = needle[0]!;
	const firstUpper = firstLower >= 97 && firstLower <= 122 ? firstLower - 32 : firstLower;
	const firstBytes = firstLower === firstUpper ? [firstLower] : [firstLower, firstUpper];
	const offsets: number[] = [];
	let cursor = 0;
	while (cursor + needle.length <= bytes.length) {
		let offset = -1;
		for (const first of firstBytes) {
			const candidate = bytes.indexOf(first, cursor);
			if (candidate >= 0 && (offset < 0 || candidate < offset)) offset = candidate;
		}
		if (offset < 0) break;
		if (encoding === "utf16le" && ((offset & 1) !== 0 || bytes[offset + 1] !== 0)) {
			cursor = offset + 1;
			continue;
		}
		let index = 0;
		for (; index < needle.length; index += 1) {
			const actual = bytes[offset + index]!;
			const expected = needle[index]!;
			const lowByte = encoding !== "utf16le" || index % 2 === 0;
			if (lowByte && actual >= 65 && actual <= 90 ? actual + 32 !== expected : actual !== expected) break;
		}
		if (index === needle.length) offsets.push(offset);
		cursor = offset + stride;
	}
	return offsets;
}

function findingsForText(input: string, file: string, content: string, patterns: PatternFile): Finding[] {
	const findings: Finding[] = [];
	for (const rule of patterns.tokens) {
		for (const offset of findMatches(file, rule.value)) {
			findings.push({ input, offset, rule: `${rule.id}:path`, verdict: "FAIL", reason: rule.reason });
		}
		for (const offset of findMatches(content, rule.value)) {
			findings.push({ input, offset, rule: rule.id, verdict: "FAIL", reason: rule.reason });
		}
	}
	return findings;
}

function tokenReferenceScope(file: string, patterns: PatternFile): "allowlisted" | "package-manifest" | "lock" | "test-specifiers" | "patch-additions" | "full" | undefined {
	if (matchingAllowRules(patterns, file).length > 0) return "allowlisted";
	if (file === "package.json" || /^packages\/[^/]+\/package\.json$/u.test(file)) return "package-manifest";
	if (file === "bun.lock") return "lock";
	if (/^packages\/[^/]+\/test\/manifests\//u.test(file)) return "full";
	if (/^packages\/[^/]+\/test\//u.test(file)) return "test-specifiers";
	if (/^packages\/[^/]+\/(?:src|scripts)\//u.test(file)) return "full";
	if (file === "packages/coding-agent/vendor/markit-ai.patch") return "patch-additions";
	if (
		/^packages\/coding-agent\/vendor\/markit-ai\/dist\//u.test(file) ||
		/^packages\/coding-agent\/vendor\/markit-ai\/(?:package\.json|MANIFEST\.json)$/u.test(file) ||
		file === "Dockerfile" || /^scripts\//u.test(file) || /^\.github\/(?:workflows|actions)\//u.test(file) ||
		/^scripts\/install-tests\/[^/]+\.dockerfile$/u.test(file)
	) return "full";
	return undefined;
}

function activeContent(file: string, scope: ReturnType<typeof tokenReferenceScope>, source: string): string {
	if (scope === "package-manifest") {
		const manifest = JSON.parse(source) as Record<string, unknown>;
		const selected: Record<string, unknown> = {};
		for (const field of MANIFEST_DEPENDENCY_FIELDS) if (manifest[field] !== undefined) selected[field] = manifest[field];
		if (file === "package.json" && isRecord(manifest.workspaces) && manifest.workspaces.catalog !== undefined) {
			selected.workspaceCatalog = manifest.workspaces.catalog;
		}
		return JSON.stringify(selected);
	}
	if (scope === "lock") {
		const lock = Bun.JSONC.parse(source) as Record<string, unknown>;
		return JSON.stringify(lock.packages ?? {});
	}
	if (scope === "patch-additions") {
		return source.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\n");
	}
	if (scope === "test-specifiers") {
		return source.split("\n").filter(line => /\b(?:import|require)\b|Bun\.resolveSync|--external/u.test(line)).join("\n");
	}
	return source;
}

function outsideHeadingSection(source: string, heading: string): string {
	const outside: string[] = [];
	let inSection = false;
	for (const line of source.split("\n")) {
		if (line.trim() === heading) {
			inSection = true;
			continue;
		}
		if (inSection && /^#{1,6}\s/u.test(line)) inSection = false;
		if (!inSection) outside.push(line);
	}
	return outside.join("\n");
}

async function trackedFiles(root: string): Promise<string[]> {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) fail(`git ls-files failed: ${result.stderr.toString("utf8")}`);
	return result.stdout.toString("utf8").split("\0").filter(Boolean).map(posixPath).sort();
}

async function scanActiveReferences(root: string, patterns: PatternFile): Promise<Finding[]> {
	const findings: Finding[] = [];
	for (const file of await trackedFiles(root)) {
		const scope = tokenReferenceScope(file, patterns);
		if (!scope) continue;
		const bytes = await fs.readFile(path.join(root, file)).catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!bytes) continue;
		const source = bytes.toString("utf8");
		if (scope === "allowlisted") {
			const headingRule = matchingAllowRules(patterns, file).find(rule => rule.type === "heading");
			if (headingRule?.heading) findings.push(...findingsForText(file, file, outsideHeadingSection(source, headingRule.heading), patterns));
			continue;
		}
		findings.push(...findingsForText(file, file, "", patterns));
		try {
			findings.push(...findingsForText(file, "", activeContent(file, scope, source), patterns));
		} catch (error) {
			findings.push({ input: file, offset: 0, rule: "active-reference-parser", verdict: "FAIL", reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return findings;
}

function parseWasmLength(bytes: Buffer, start: number): number | undefined {
	if (!bytes.subarray(start, start + WASM_HEADER.length).equals(WASM_HEADER)) return undefined;
	let offset = start + WASM_HEADER.length;
	while (offset < bytes.length) {
		const section = bytes[offset]!;
		if (section > 12) return offset - start;
		let length = 0;
		let shift = 0;
		let size: number | undefined;
		for (let part = 0; part < 5; part += 1) {
			if (offset + 1 >= bytes.length) return undefined;
			const byte = bytes[++offset]!;
			length |= (byte & 0x7f) << shift;
			if (!(byte & 0x80)) {
				size = length >>> 0;
				break;
			}
			shift += 7;
		}
		if (size === undefined || offset + 1 + size > bytes.length) return undefined;
		offset += 1 + size;
	}
	return offset - start;
}

function findWasmModules(bytes: Buffer): Array<{ offset: number; bytes: Buffer }> {
	const modules: Array<{ offset: number; bytes: Buffer }> = [];
	let cursor = 0;
	while (cursor <= bytes.length - WASM_HEADER.length) {
		const offset = bytes.indexOf(WASM_HEADER, cursor);
		if (offset < 0) break;
		const size = parseWasmLength(bytes, offset);
		if (size !== undefined) modules.push({ offset, bytes: bytes.subarray(offset, offset + size) });
		cursor = offset + 1;
	}
	return modules;
}

function signatureFindings(input: string, member: string | undefined, bytes: Buffer, patterns: PatternFile): Finding[] {
	const findings: Finding[] = [];
	for (const [rule, token] of [
		["npm-package-integrity", patterns.signatures.npmPackageIntegrity],
		["embedded-wasm-sha256-text", patterns.signatures.embeddedWasmSha256],
	] as const) {
		for (const encoding of ["utf8", "utf16le"] as const) {
			for (const offset of findByteMatches(bytes, token, encoding)) findings.push({ input, ...(member ? { member } : {}), offset, rule, verdict: "FAIL" });
		}
	}
	for (const module of findWasmModules(bytes)) {
		if (createHash("sha256").update(module.bytes).digest("hex") === patterns.signatures.embeddedWasmSha256) {
			findings.push({ input, ...(member ? { member } : {}), offset: module.offset, rule: "embedded-wasm-module", verdict: "FAIL" });
		}
	}
	return findings;
}

function tokenByteFindings(
	input: string,
	member: string | undefined,
	bytes: Buffer,
	patterns: PatternFile,
	encodings: readonly ("utf8" | "utf16le")[],
): Finding[] {
	const findings: Finding[] = [];
	for (const rule of patterns.tokens) {
		for (const encoding of encodings) {
			for (const offset of findByteMatches(bytes, rule.value, encoding)) {
				findings.push({ input, ...(member ? { member } : {}), offset, rule: rule.id, verdict: "FAIL", reason: rule.reason });
			}
		}
	}
	return findings;
}

function validUtf8(bytes: Buffer): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}



function unescapeText(value: string): string {
	return value
		.replace(/\\([nrt"'`\\/])/gu, (_, character: string) => ({ n: "\n", r: "\r", t: "\t" })[character] ?? character)
		.replace(/\\x([0-9a-f]{2})/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/\\u\{([0-9a-f]+)\}/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function attributeContext(
	bytes: Buffer,
	tokenOffset: number,
	encoding: "utf8" | "utf16le",
	rule: TokenRule,
	sources: readonly ProseSource[],
): ProseSource | undefined {
	const alignment = encoding === "utf16le" ? 2 : 1;
	const start = Math.max(0, Math.floor((tokenOffset - 1024) / alignment) * alignment);
	const end = Math.min(bytes.length, tokenOffset + Buffer.byteLength(rule.value, encoding) + 1024);
	const artifact = unescapeText(bytes.subarray(start, end).toString(encoding));
	const prefix = unescapeText(bytes.subarray(start, tokenOffset).toString(encoding));
	const tokenStart = prefix.length;
	if (artifact.slice(tokenStart, tokenStart + rule.value.length).toLowerCase() !== rule.value.toLowerCase()) return undefined;
	const tokenEnd = tokenStart + rule.value.length;
	for (const source of sources) {
		for (const sourceStart of findMatches(source.text, rule.value)) {
			const sourceEnd = sourceStart + rule.value.length;
			const left = Math.min(48, sourceStart);
			const right = Math.min(48, source.text.length - sourceEnd);
			if (tokenStart < left || tokenEnd + right > artifact.length) continue;
			if (
				artifact.slice(tokenStart - left, tokenStart) === source.text.slice(sourceStart - left, sourceStart) &&
				artifact.slice(tokenEnd, tokenEnd + right) === source.text.slice(sourceEnd, sourceEnd + right)
			) return source;
		}
	}
	return undefined;
}

async function walkMarkdown(root: string, relative = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(error => {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	});
	const files: string[] = [];
	for (const entry of entries) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...await walkMarkdown(root, child));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
	}
	return files;
}

async function proseSources(root: string): Promise<ProseSource[]> {
	const files = ["packages/coding-agent/CHANGELOG.md", ...(await walkMarkdown(path.join(root, "docs"))).map(name => `docs/${name}`)];
	const result: ProseSource[] = [];
	for (const file of [...new Set(files)].sort()) {
		const bytes = await fs.readFile(path.join(root, file)).catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (bytes) result.push({ path: posixPath(file), text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	return result;
}

function isChangelogMember(file: string): boolean {
	return /^package\/(?:CHANGELOG\.md|changelog\.d\/.+\.md)$/iu.test(file);
}

function manifestFindings(input: string, member: PackageTarballMember, patterns: PatternFile): Finding[] {
	if (path.posix.basename(member.path) !== "package.json") return [];
	const findings: Finding[] = [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(member.data.toString("utf8"));
	} catch (error) {
		return [{ input, member: member.path, offset: 0, rule: "package-manifest-json", verdict: "FAIL", reason: error instanceof Error ? error.message : String(error) }];
	}
	if (!isRecord(manifest)) return [{ input, member: member.path, offset: 0, rule: "package-manifest-json", verdict: "FAIL", reason: "manifest must be an object" }];
	for (const field of MANIFEST_DEPENDENCY_FIELDS) {
		const dependencies = manifest[field];
		if (dependencies === undefined) continue;
		let references: string[];
		if (field === "bundleDependencies" && Array.isArray(dependencies)) {
			references = dependencies.filter((name): name is string => typeof name === "string");
		} else if (isRecord(dependencies)) {
			references = Object.entries(dependencies).map(([name, value]) => `${name}:${String(value)}`);
		} else {
			findings.push({
				input,
				member: member.path,
				offset: 0,
				rule: `manifest-${field}`,
				verdict: "FAIL",
				reason: `${field} must be an object${field === "bundleDependencies" ? " or array" : ""}`,
			});
			continue;
		}
		for (const reference of references) {
			for (const rule of patterns.tokens) {
				if (reference.toLowerCase().includes(rule.value.toLowerCase())) {
					findings.push({ input, member: member.path, offset: 0, rule: `manifest-${field}:${rule.id}`, verdict: "FAIL", reason: rule.reason });
				}
			}
		}
	}
	return findings;
}

function textMember(member: PackageTarballMember): boolean {
	return !BINARY_EXTENSIONS.has(path.posix.extname(member.path).toLowerCase()) && validUtf8(member.data) !== undefined;
}

async function scanPackageTarball(
	root: string,
	archive: string,
	patterns: PatternFile,
	sources: readonly ProseSource[],
	limits?: Partial<TarballLimits>,
): Promise<Finding[]> {
	const input = posixPath(path.relative(root, archive)) || archive;
	let members: PackageTarballMember[];
	try {
		members = readPackageTarballMembers(await fs.readFile(archive), { ...RELEASE_TARBALL_LIMITS, ...limits });
	} catch (error) {
		return [{ input, offset: 0, rule: "tarball-reader", verdict: "FAIL", reason: error instanceof Error ? error.message : String(error) }];
	}
	const findings: Finding[] = [];
	for (const member of members) {
		findings.push(...signatureFindings(input, member.path, member.data, patterns));
		findings.push(...manifestFindings(input, member, patterns));
		if (!textMember(member)) {
			findings.push(...tokenByteFindings(input, member.path, member.data, patterns, ["utf8", "utf16le"]));
			continue;
		}
		if (isChangelogMember(member.path)) {
			for (const rule of patterns.tokens) {
				for (const offset of findByteMatches(member.data, rule.value, "utf8")) {
					findings.push({ input, member: member.path, offset, rule: rule.id, verdict: "PASS", reason: "changelog prose exemption" });
				}
			}
			continue;
		}
		if (member.path === "package/src/internal-urls/docs-index.generated.ts") {
			for (const rule of patterns.tokens) {
				for (const byteOffset of findByteMatches(member.data, rule.value, "utf8")) {
					const source = attributeContext(member.data, byteOffset, "utf8", rule, sources.filter(candidate => candidate.path.startsWith("docs/")));
					findings.push({
						input,
						member: member.path,
						offset: byteOffset,
						rule: rule.id,
						verdict: source ? "PASS" : "FAIL",
						reason: source ? "verbatim documentation attribution" : rule.reason,
						...(source ? { attributedTo: { path: source.path, sha256: source.sha256 } } : {}),
					});
				}
			}
			continue;
		}
		findings.push(...tokenByteFindings(input, member.path, member.data, patterns, ["utf8"]));
	}
	return findings;
}

async function scanExternal(
	root: string,
	kind: "binary" | "addon",
	file: string,
	patterns: PatternFile,
	sources: readonly ProseSource[],
): Promise<Finding[]> {
	const absolute = path.resolve(root, file);
	const input = posixPath(path.relative(root, absolute)) || file;
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(absolute);
	} catch (error) {
		return [{ input, offset: 0, rule: "artifact-read", verdict: "FAIL", reason: error instanceof Error ? error.message : String(error) }];
	}
	const findings = signatureFindings(input, undefined, bytes, patterns);
	for (const rule of patterns.tokens) {
		for (const encoding of ["utf8", "utf16le"] as const) {
			for (const offset of findByteMatches(bytes, rule.value, encoding)) {
				const source = kind === "binary" ? attributeContext(bytes, offset, encoding, rule, sources) : undefined;
				findings.push({
					input,
					offset,
					rule: rule.id,
					verdict: source ? "PASS" : "FAIL",
					reason: source ? "attributed embedded prose" : rule.reason,
					...(source ? { attributedTo: { path: source.path, sha256: source.sha256 } } : {}),
				});
			}
		}
	}
	return findings;
}

async function run(options: CliOptions): Promise<AuditReport> {
	const patternPath = options.patternFile ?? path.join(options.root, "scripts/agpl-removal-patterns.json");
	const patterns = parsePatterns(JSON.parse(await fs.readFile(patternPath, "utf8")));
	const findings = options.mode === "active-refs"
		? await scanActiveReferences(options.root, patterns)
		: await (async () => {
				const root = path.resolve(options.root, options.proseRoot!);
				const sources = await proseSources(root);
				const result = await scanPackageTarball(options.root, path.resolve(options.root, options.tarball!), patterns, sources, options.tarballLimits);
				for (const binary of options.binaries) result.push(...await scanExternal(options.root, "binary", binary, patterns, sources));
				for (const addon of options.addons) result.push(...await scanExternal(options.root, "addon", addon, patterns, sources));
				return result;
			})();
	return { schemaVersion: 1, mode: options.mode, status: findings.some(entry => entry.verdict === "FAIL") ? "FAIL" : "PASS", findings };
}

async function main(): Promise<void> {
	const root = path.resolve(import.meta.dir, "..");
	const options = parseCli(process.argv.slice(2), root);
	const report = await run(options);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.status === "FAIL") process.exitCode = 2;
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	});
}

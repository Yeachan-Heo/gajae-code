import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES } from "../test/fixtures/tui/status-line-custom-editor-showcase";
import { ansiToHtml } from "./capture-sticky-viewport-showcase";

const CAPTURE_TOOL_VERSION = "status-line-custom-editor-showcase-v1";
const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-status-line-custom-editor-showcase.ts --out .gjc/qa/status-line-custom-editor-<run>";
const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

function expectedWrappingPolicy(columns: number): string {
	return columns < 64 ? "two-row-warning" : "single-row-when-fits";
}

interface ManifestFile {
	tool: string;
	entries: Array<{
		key: string;
		stateId: string;
		viewport: { columns: number; rows: number };
		renderMode: string;
		files: Array<{ path: string; sha256: string; byte_length: number }>;
	}>;
	independentReview?: {
		reviewer: string;
		verdict: "approved" | "rejected";
		evidence: string;
		manifestSha256?: string;
		sourceHash?: string;
	};
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function expectedKey(entry: (typeof STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES)[number]): string {
	return `${entry.stateId}/${entry.columns}x${entry.rows}/${entry.renderMode}`;
}

function parseArgs(args: string[]): { root: string; requireIndependentReview: boolean } {
	let root = "";
	let requireIndependentReview = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--root") root = args[++i] ?? "";
		else if (arg === "--require-independent-review") requireIndependentReview = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!root) {
		throw new Error(
			"Usage: bun packages/coding-agent/scripts/verify-status-line-custom-editor-showcase.ts --root <dir> [--require-independent-review]",
		);
	}
	return { root, requireIndependentReview };
}

async function readText(root: string, relativePath: string): Promise<string> {
	const fullPath = path.resolve(root, relativePath);
	const resolvedRoot = path.resolve(root);
	if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Artifact escapes root: ${relativePath}`);
	return await Bun.file(fullPath).text();
}

async function tryReadReview(root: string): Promise<ManifestFile["independentReview"] | undefined> {
	const reviewPath = path.join(root, "independent-review.json");
	if (!(await Bun.file(reviewPath).exists())) return undefined;
	return JSON.parse(await Bun.file(reviewPath).text()) as ManifestFile["independentReview"];
}

async function collectRelativeFiles(root: string, dir = ""): Promise<string[]> {
	const fullDir = path.join(root, dir);
	const entries = await fs.readdir(fullDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await collectRelativeFiles(root, relative)));
		} else if (entry.isFile()) {
			files.push(relative);
		}
	}
	return files;
}

function requireWitness(entry: ManifestFile["entries"][number], plain: string): void {
	if (entry.stateId === "exit-restored" || entry.stateId === "confirm-persisted") {
		if (!plain.includes("Status Line")) throw new Error(`${entry.key}: missing returned settings witness`);
		return;
	}
	const baseWitnesses = [
		"Status Line Custom Editor",
		"Simulated statusbar",
		"Hidden segment palette",
		"Visible choices",
	];
	for (const witness of baseWitnesses) {
		if (!plain.includes(witness)) throw new Error(`${entry.key}: missing witness ${witness}`);
	}
	if (entry.stateId.includes("choice-focused") && !plain.includes("Choices:")) {
		throw new Error(`${entry.key}: missing choice panel witness`);
	}
	if (
		entry.stateId === "picked-origin-slot" &&
		(!plain.includes("Selected:") || plain.includes("Floating ghost") || plain.includes("Origin "))
	) {
		throw new Error(`${entry.key}: missing selected witness or stale ghost/origin text present`);
	}
	if (entry.stateId.includes("overflow") && !plain.includes("Warning: statusbar wrapped to 2 rows")) {
		throw new Error(`${entry.key}: missing overflow warning`);
	}
	if (entry.stateId === "narrow-cjk" && !/[\u3131-\uD7A3\u3040-\u30FF\u3400-\u9FFF]/.test(plain)) {
		throw new Error(`${entry.key}: missing CJK width witness`);
	}
	if (plain.includes("Move left:") || plain.includes("Move right:") || plain.includes("Segment: gajae")) {
		throw new Error(`${entry.key}: legacy row witness present`);
	}
}

async function main(): Promise<void> {
	const { root, requireIndependentReview } = parseArgs(process.argv.slice(2));
	const manifestText = await Bun.file(path.join(root, "manifest.json")).text();
	const manifest = JSON.parse(manifestText) as ManifestFile;
	const manifestSha256 = sha256(manifestText);
	if (manifest.tool !== CAPTURE_TOOL_VERSION) throw new Error(`Unexpected tool version: ${manifest.tool}`);
	const expectedKeys = new Set(STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES.map(expectedKey));
	const actualKeys = new Set(manifest.entries.map(entry => entry.key));
	if (manifest.entries.length !== actualKeys.size) throw new Error("Duplicate showcase entries found");
	if (manifest.entries.length !== expectedKeys.size) throw new Error("Unexpected showcase entry count");
	for (const key of expectedKeys) if (!actualKeys.has(key)) throw new Error(`Missing showcase key: ${key}`);
	if (requireIndependentReview) {
		const review = manifest.independentReview ?? (await tryReadReview(root));
		if (
			review?.verdict !== "approved" ||
			!review.evidence ||
			review.manifestSha256 !== manifestSha256 ||
			!review.sourceHash?.startsWith("sha256:")
		) {
			throw new Error("Missing approved independent review in manifest");
		}
	}
	const artifactPaths = new Set<string>();
	const expectedRootFiles = new Set(["manifest.json"]);
	if (await Bun.file(path.join(root, "independent-review.json")).exists())
		expectedRootFiles.add("independent-review.json");
	for (const entry of manifest.entries) {
		if (entry.key !== `${entry.stateId}/${entry.viewport.columns}x${entry.viewport.rows}/${entry.renderMode}`) {
			throw new Error(`${entry.key}: key does not match manifest fields`);
		}
		const expectedDirectory = entry.key.replace(/[^a-zA-Z0-9._/-]/g, "_");
		const names = new Set(entry.files.map(file => path.basename(file.path)));
		if (names.size !== 4 || entry.files.length !== 4)
			throw new Error(`${entry.key}: artifact membership is not exact`);
		for (const required of ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"]) {
			if (!names.has(required)) throw new Error(`${entry.key}: missing ${required}`);
		}
		for (const file of entry.files) {
			if (!file.path.startsWith(`${expectedDirectory}/`)) {
				throw new Error(`${entry.key}: artifact path is not bound to canonical entry directory`);
			}
			if (artifactPaths.has(file.path)) throw new Error(`${entry.key}: duplicate artifact path ${file.path}`);
			artifactPaths.add(file.path);
			const content = await readText(root, file.path);
			if (sha256(content) !== file.sha256) throw new Error(`${entry.key}: sha mismatch for ${file.path}`);
			if (Buffer.byteLength(content) !== file.byte_length) {
				throw new Error(`${entry.key}: byte length mismatch for ${file.path}`);
			}
		}
		const plainPath = entry.files.find(file => path.basename(file.path) === "terminal.txt")?.path;
		const ansiPath = entry.files.find(file => path.basename(file.path) === "terminal-ansi.txt")?.path;
		const htmlPath = entry.files.find(file => path.basename(file.path) === "terminal.html")?.path;
		const metadataPath = entry.files.find(file => path.basename(file.path) === "metadata.json")?.path;
		if (!plainPath || !ansiPath || !htmlPath || !metadataPath) throw new Error(`${entry.key}: incomplete file list`);
		const plain = await readText(root, plainPath);
		const ansi = await readText(root, ansiPath);
		const html = await readText(root, htmlPath);
		if (Bun.stripANSI(ansi) !== plain) throw new Error(`${entry.key}: stripped ANSI differs from plain text`);
		if (html !== ansiToHtml(ansi)) throw new Error(`${entry.key}: HTML artifact is not canonical ANSI conversion`);
		if (plain.split("\n").length > entry.viewport.rows) {
			throw new Error(`${entry.key}: terminal row count exceeds declared viewport`);
		}
		for (const line of plain.split("\n")) {
			if (Bun.stringWidth(line) > entry.viewport.columns) {
				throw new Error(`${entry.key}: terminal line exceeds declared viewport width`);
			}
		}
		if (entry.renderMode === "ascii-no-color") {
			if (/\x1b\[[0-9;]*m/.test(ansi)) throw new Error(`${entry.key}: ascii-no-color artifact contains ANSI`);
			if (/[^\x09\x0a\x0d\x20-\x7e]/.test(plain)) {
				throw new Error(`${entry.key}: ascii-no-color artifact contains non-ASCII glyphs`);
			}
		}
		const metadata = JSON.parse(await readText(root, metadataPath)) as {
			tool?: string;
			command?: string;
			stateId?: string;
			viewport?: { columns?: number; rows?: number };
			renderMode?: string;
			fixedClock?: string;
			wrappingPolicy?: string;
		};
		if (
			metadata.tool !== CAPTURE_TOOL_VERSION ||
			metadata.command !== CANONICAL_COMMAND ||
			metadata.stateId !== entry.stateId ||
			metadata.viewport?.columns !== entry.viewport.columns ||
			metadata.viewport?.rows !== entry.viewport.rows ||
			metadata.renderMode !== entry.renderMode ||
			metadata.fixedClock !== FIXED_CLOCK ||
			metadata.wrappingPolicy !== expectedWrappingPolicy(entry.viewport.columns)
		) {
			throw new Error(`${entry.key}: metadata does not match manifest`);
		}
		requireWitness(entry, plain);
		if (entry.stateId === "palette-exact-insert" && (plain.includes("Selected:") || plain.includes("{gajae}"))) {
			throw new Error(`${entry.key}: exact insertion state still has floating/hidden segment evidence`);
		}
		if (entry.stateId === "palette-exact-insert" && !plain.includes("left model / path /")) {
			throw new Error(`${entry.key}: exact insertion state missing ordered layout witness`);
		}
		if (
			entry.stateId === "exit-restored" &&
			!plain.includes("left=model,path,git right=session_name,jobs separator=slash")
		) {
			throw new Error(`${entry.key}: exit-restored state missing exact restored preview witness`);
		}
		if (
			entry.stateId === "confirm-persisted" &&
			!plain.includes("left=path,git right=session_name,jobs separator=slash")
		) {
			throw new Error(`${entry.key}: confirm-persisted state missing exact persisted preview witness`);
		}
		if (entry.stateId === "separator-choice-applied" && !plain.includes("[Pipe]")) {
			throw new Error(`${entry.key}: separator applied state missing Pipe witness`);
		}
		if (entry.stateId === "option-choice-applied" && !plain.includes("[40]")) {
			throw new Error(`${entry.key}: option applied state missing numeric option witness`);
		}
		if (entry.stateId.includes("narrow") && !plain.includes("Focused target:")) {
			throw new Error(`${entry.key}: narrow state missing focused target witness`);
		}
	}
	for (const filePath of await collectRelativeFiles(root)) {
		if (expectedRootFiles.has(filePath)) continue;
		if (!artifactPaths.has(filePath)) throw new Error(`Unmanifested artifact file: ${filePath}`);
	}
	process.stdout.write(`Verified ${manifest.entries.length} status-line custom editor showcase entries at ${root}\n`);
}

void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});

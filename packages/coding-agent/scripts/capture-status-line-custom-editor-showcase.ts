import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	renderStatusLineCustomEditorShowcase,
	STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES,
	type StatusLineCustomEditorShowcaseEntry,
} from "../test/fixtures/tui/status-line-custom-editor-showcase";
import { ansiToHtml } from "./capture-sticky-viewport-showcase";

const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-status-line-custom-editor-showcase.ts --out .gjc/qa/status-line-custom-editor-<run>";
const CAPTURE_TOOL_VERSION = "status-line-custom-editor-showcase-v1";

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ManifestEntry {
	key: string;
	stateId: string;
	viewport: { columns: number; rows: number };
	renderMode: string;
	files: ArtifactFile[];
}

function usage(): never {
	throw new Error(`Usage: ${CANONICAL_COMMAND}`);
}

function outputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) usage();
	return args[1];
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function entryKey(entry: StatusLineCustomEditorShowcaseEntry): string {
	return `${entry.stateId}/${entry.columns}x${entry.rows}/${entry.renderMode}`;
}

function clipRows(text: string, rows: number): string {
	return text.split("\n").slice(0, rows).join("\n");
}

async function writeArtifact(root: string, relativePath: string, content: string): Promise<ArtifactFile> {
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });
	await Bun.write(fullPath, content);
	return { path: relativePath, sha256: sha256(content), byte_length: Buffer.byteLength(content) };
}

async function main(): Promise<void> {
	const root = outputPath(process.argv.slice(2));
	const independentReviewPath = path.join(root, "independent-review.json");
	const existingIndependentReview = (await Bun.file(independentReviewPath).exists())
		? await Bun.file(independentReviewPath).text()
		: undefined;
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });
	if (existingIndependentReview !== undefined) {
		await Bun.write(independentReviewPath, existingIndependentReview);
	}
	const entries: ManifestEntry[] = [];
	for (const entry of STATUS_LINE_CUSTOM_EDITOR_SHOWCASE_ENTRIES) {
		const key = entryKey(entry);
		const dir = key.replace(/[^a-zA-Z0-9._/-]/g, "_");
		const terminalAnsi = clipRows(await renderStatusLineCustomEditorShowcase(entry), entry.rows);
		const terminalPlain = Bun.stripANSI(terminalAnsi);
		const html = ansiToHtml(terminalAnsi);
		const metadata = json({
			tool: CAPTURE_TOOL_VERSION,
			command: CANONICAL_COMMAND,
			stateId: entry.stateId,
			viewport: { columns: entry.columns, rows: entry.rows },
			renderMode: entry.renderMode,
			fixedClock: "2026-01-01T00:00:00.000Z",
			wrappingPolicy: entry.columns < 64 ? "two-row-warning" : "single-row-when-fits",
		});
		const files = [
			await writeArtifact(root, `${dir}/terminal.txt`, terminalPlain),
			await writeArtifact(root, `${dir}/terminal-ansi.txt`, terminalAnsi),
			await writeArtifact(root, `${dir}/terminal.html`, html),
			await writeArtifact(root, `${dir}/metadata.json`, metadata),
		];
		entries.push({
			key,
			stateId: entry.stateId,
			viewport: { columns: entry.columns, rows: entry.rows },
			renderMode: entry.renderMode,
			files,
		});
	}
	await writeArtifact(root, "manifest.json", json({ tool: CAPTURE_TOOL_VERSION, entries }));
	process.stdout.write(`Captured ${entries.length} status-line custom editor showcase entries at ${root}\n`);
}

void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { EditTool, getFileReadCache } from "@gajae-code/coding-agent/edit";
import { computeLineHash } from "@gajae-code/coding-agent/hashline/hash";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import * as scrapers from "@gajae-code/coding-agent/web/scrapers/types";

// Bun `mock.module` is process-global and sibling receipt tests replace the
// natives module. Re-register only the native exports used by ReadTool from a
// direct loader import, so this harness's structural-summary fixture always uses
// the actual native implementation rather than another test's wrapper.
const nativeIndexUrl = import.meta.resolve("@gajae-code/natives");
const nativeLoaderUrl = new URL("./loader-state.js?read-goldens-real-loader", nativeIndexUrl).href;
const realNatives = (await import(nativeLoaderUrl)).loadNative();
function installRealNativesMock(): void {
	mock.module("@gajae-code/natives", () => realNatives);
}

installRealNativesMock();

// Keep the same delegation shape as the read receipt tests. The harness owns only
// the deterministic markit fixture; all other calls use the real implementations.
const markitContents = new Map<string, string>();
const realMarkit = await import("@gajae-code/coding-agent/utils/markit");

mock.module("@gajae-code/coding-agent/utils/markit", () => ({
	...realMarkit,
	convertFileWithMarkit: async (filePath: string, signal?: AbortSignal) => {
		const content = markitContents.get(filePath);
		return content === undefined ? realMarkit.convertFileWithMarkit(filePath, signal) : { ok: true, content };
	},
}));
// Load a fresh ReadTool graph after installing the real natives mock; Bun caches
// the ordinary module URL even when a sibling test imported it under another mock.
const readModuleUrl = new URL("../../src/tools/read.ts", import.meta.url);
readModuleUrl.search = "read-goldens";
const { ReadTool } = await import(readModuleUrl.href);

const MANIFEST_PATH = path.join(import.meta.dir, "../fixtures/read-goldens/manifest.json");
const GOLDEN_ROOT = path.dirname(MANIFEST_PATH);
const UPDATE = process.env.GJC_UPDATE_READ_GOLDENS === "1";
const SEED_INVARIANT = process.env.GJC_SEED_READ_GOLDENS === "1";
const SEED_SURFACE = process.env.GJC_SEED_READ_SURFACE_GOLDENS === "1";
const FORCE_TRUNCATION = process.env.GJC_FORCE_READ_TRUNCATION as "head" | "last" | "both" | undefined;
const GOLDEN_BUCKETS_TO_CHECK: readonly Bucket[] =
	FORCE_TRUNCATION === "head" ? ["invariant"] : ["invariant", "changed", "surface"];

type Bucket = "invariant" | "changed" | "surface";
type Variant = "hl" | "plain";

const EXPECTED_MANIFEST_COUNTS: Record<Bucket, number> = {
	invariant: 29,
	changed: 8,
	surface: 4,
};
const EXPECTED_MANIFEST_NAMES: Record<Bucket, readonly string[]> = {
	invariant: [
		"summary-ts",
		"range-50-200",
		"range-50-plus-150",
		"raw-small",
		"raw-range",
		"multi-range",
		"conflicts-index",
		"out-of-bounds",
		"local-bare-head",
		"url-page",
		"dir-local",
		"dir-archive",
		"markit-bare",
		"markit-ranged",
		"notebook-bare",
		"notebook-ranged",
		"internal-artifact",
		"internal-artifact-ranged",
		"sqlite-list",
		"sqlite-schema",
		"sqlite-row",
		"sqlite-query",
		"sqlite-raw",
		"archive-member-ranged",
		"archive-large-ranged",
		"archive-bytes-ranged",
		"archive-dir-nested",
		"empty-file",
		"single-line-no-newline",
	],
	changed: [
		"local-bare-tail",
		"archive-member-bare-tail",
		"acp-bare-parity",
		"local-bare-notice-owner",
		"giant-single-line",
		"local-bare-both",
		"giant-last-partial",
		"range-tail",
	],
	surface: ["prompt-read-default", "prompt-read-head", "docs-read-flow-line", "cli-read-help"],
};
const EXPECTED_PHASE_ZERO_GOLDEN_FILES = 58;
type Request = { path: string; [key: string]: unknown };
type Entry = {
	bucket: Bucket;
	phase: 0 | 1;
	name: string;
	request: Request;
	capturedAs?: Request;
	settings?: Record<string, unknown>;
	hashLines: boolean[];
	reason?: string;
};
type Captured = {
	text: string;
	displayContent: unknown;
	truncation: unknown;
	meta: unknown;
};
type FixtureState = {
	root: string;
	artifactDir: string;
};

type ReadResult = {
	content: Array<{ type: string; text?: string }>;
	details?: {
		displayContent?: unknown;
		truncation?: unknown;
		meta?: unknown;
	};
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Entry[];
let fixture: FixtureState;
let contextManager: SessionManager;
let urlPageSpy: ReturnType<typeof vi.spyOn> | undefined;
let artifactCounter = 0;

function variantFor(hashLines: boolean): Variant {
	return hashLines ? "hl" : "plain";
}

function goldenPath(bucket: Bucket, name: string, variant: Variant): string {
	return path.join(GOLDEN_ROOT, bucket, `${name}.${variant}.json`);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function deepEqual(left: unknown, right: unknown): boolean {
	return stableJson(left) === stableJson(right);
}

function writeGolden(bucket: Bucket, name: string, variant: Variant, value: Captured): void {
	if (bucket !== "changed") {
		throw new Error(
			`refusing to write ${bucket}/${name}: update mode may only write changed/. Drift here is an implementation bug, not a golden bug.`,
		);
	}
	if (!UPDATE) throw new Error("writeGolden called without GJC_UPDATE_READ_GOLDENS=1");
	fs.mkdirSync(path.join(GOLDEN_ROOT, bucket), { recursive: true });
	fs.writeFileSync(goldenPath(bucket, name, variant), `${stableJson(value)}\n`);
}

function seedGolden(bucket: Bucket, name: string, variant: Variant, value: Captured): void {
	if (bucket === "changed") throw new Error(`seeding is not allowed for changed/${name}`);
	if (!SEED_INVARIANT) throw new Error("seedGolden called without GJC_SEED_READ_GOLDENS=1");
	const target = goldenPath(bucket, name, variant);
	if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing ${bucket}/${name}.${variant}.json`);
	fs.mkdirSync(path.join(GOLDEN_ROOT, bucket), { recursive: true });
	fs.writeFileSync(target, `${stableJson(value)}\n`);
}

function seedSurfaceGolden(name: string, variant: Variant, value: Captured): void {
	if (!SEED_SURFACE) throw new Error("seedSurfaceGolden called without GJC_SEED_READ_SURFACE_GOLDENS=1");
	const target = goldenPath("surface", name, variant);
	if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing surface/${name}.${variant}.json`);
	fs.mkdirSync(path.join(GOLDEN_ROOT, "surface"), { recursive: true });
	fs.writeFileSync(target, `${stableJson(value)}\n`);
}

function compareGolden(
	entry: Entry,
	variant: Variant,
	value: Captured,
	currentPhase: 0 | 1,
): "compared" | "seeded" | "updated" | "skipped" {
	const target = goldenPath(entry.bucket, entry.name, variant);
	const exists = fs.existsSync(target);
	if (!exists && entry.phase === 1 && currentPhase === 0) return "skipped";
	if (!exists) {
		if (entry.bucket === "surface" && SEED_SURFACE) {
			seedSurfaceGolden(entry.name, variant, value);
			return "seeded";
		}
		if (entry.bucket !== "changed" && SEED_INVARIANT) {
			seedGolden(entry.bucket, entry.name, variant, value);
			return "seeded";
		}
		if (entry.bucket === "changed" && UPDATE) {
			writeGolden(entry.bucket, entry.name, variant, value);
			return "updated";
		}
		throw new Error(`missing golden ${entry.bucket}/${entry.name}.${variant}.json`);
	}

	const expected = JSON.parse(fs.readFileSync(target, "utf8")) as Captured;
	if (!deepEqual(expected, value)) {
		if (entry.bucket === "changed" && UPDATE) {
			writeGolden(entry.bucket, entry.name, variant, value);
			return "updated";
		}
		throw new Error(`golden drift in ${entry.bucket}/${entry.name}.${variant}.json`);
	}
	return "compared";
}

// Normalize only artifact references, not arbitrary fixture text. Generated IDs are
// nondeterministic in artifactId fields and in artifact:// URLs or filesystem paths.
function normalizeValue(value: unknown, key?: string): unknown {
	if (typeof value === "string") {
		const normalized = value.replaceAll(fixture.root, "{TMP}");
		if (key === "artifactId") return "{ARTIFACT}";
		return normalized.replace(/(artifact:\/\/|[/\\])artifact-\d+/g, "$1{ARTIFACT}");
	}
	if (Array.isArray(value)) return value.map(child => normalizeValue(child));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [childKey, normalizeValue(child, childKey)]),
		);
	}
	return value;
}

function textOf(result: ReadResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

type HashlineAnchor = { line: number; hash: string; content: string };

function parseHashlineAnchors(text: string): HashlineAnchor[] {
	return text
		.split("\n")
		.map(line => /^(\d+)([a-z]{2})\|(.*)$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map(match => ({ line: Number(match[1]), hash: match[2], content: match[3] }));
}

function createSession(cwd: string, settings: Settings, artifactDir: string, bridgeText?: string): ToolSession {
	const sessionDir = path.join(cwd, "session-output");
	return {
		cwd,
		hasUI: false,
		hasEditTool: true,
		getSessionFile: () => path.join(cwd, "read-goldens-session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
		...(bridgeText === undefined
			? {}
			: {
					getClientBridge: () => ({
						capabilities: { readTextFile: true },
						readTextFile: async () => bridgeText,
					}),
				}),
	} as unknown as ToolSession;
}

function createContext(settings: Settings): AgentToolContext {
	return {
		sessionManager: contextManager,
		settings,
		toolNames: ["read"],
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function substituteFixture(value: string): string {
	return value.replaceAll("{FIXTURE}", fixture.root);
}

function materializeRequest(request: Request): Request {
	return Object.fromEntries(
		Object.entries(request).map(([key, value]) => [
			key,
			typeof value === "string" ? substituteFixture(value) : value,
		]),
	) as Request;
}

function capture(result: ReadResult): Captured {
	return normalizeValue({
		text: textOf(result),
		displayContent: result.details?.displayContent ?? null,
		truncation: result.details?.truncation ?? null,
		meta: result.details?.meta ?? null,
	}) as Captured;
}

function assertRunnable(entry: Entry, currentPhase: 0 | 1): void {
	if (entry.phase > currentPhase) {
		throw new Error(`phase-${entry.phase} entry ${entry.name} cannot run in phase-${currentPhase}`);
	}
}

type GoldenPhase = 0 | 1;

function expectedGoldenFiles(currentPhase: GoldenPhase): Map<Bucket, Set<string>> {
	const expected = new Map<Bucket, Set<string>>([
		["invariant", new Set<string>()],
		["changed", new Set<string>()],
		["surface", new Set<string>()],
	]);
	for (const entry of manifest.filter(candidate => candidate.phase <= currentPhase)) {
		const files = expected.get(entry.bucket)!;
		for (const hashLines of entry.hashLines) files.add(`${entry.name}.${variantFor(hashLines)}.json`);
	}
	return expected;
}

function phaseOneGoldensReady(): boolean {
	return manifest
		.filter(entry => entry.phase === 1)
		.every(entry =>
			entry.hashLines.every(hashLines => fs.existsSync(goldenPath(entry.bucket, entry.name, variantFor(hashLines)))),
		);
}
const REQUESTED_PHASE = process.env.GJC_READ_GOLDENS_PHASE;
const CURRENT_PHASE: GoldenPhase =
	REQUESTED_PHASE === undefined ? (phaseOneGoldensReady() ? 1 : 0) : REQUESTED_PHASE === "1" ? 1 : 0;

function actualGoldenFiles(bucket: Bucket): Set<string> {
	const directory = path.join(GOLDEN_ROOT, bucket);
	if (!fs.existsSync(directory)) return new Set();
	return new Set(fs.readdirSync(directory).filter(file => file.endsWith(".json")));
}

async function createFixtures(root: string): Promise<FixtureState> {
	const proseLines = Array.from(
		{ length: 320 },
		(_, index) => `prose-${String(index + 1).padStart(3, "0")} ${"stable fixture text ".repeat(4).trim()}`,
	);
	fs.writeFileSync(path.join(root, "prose.txt"), proseLines.join("\n"));
	const rangeTailLines = Array.from(
		{ length: 120 },
		(_, index) => `range-tail-${String(index + 1).padStart(3, "0")} ${"x".repeat(600)}`,
	);
	fs.writeFileSync(path.join(root, "range-tail.txt"), rangeTailLines.join("\n"));
	const summaryLines = [
		"export function readGoldensSummaryFixture(input: string): string {",
		"\tconst values: string[] = [];",
		...Array.from({ length: 80 }, (_, index) => `\tvalues.push(input + "-${index}");`),
		'\treturn values.join("\\n");',
		"}",
	];
	fs.writeFileSync(path.join(root, "summary.ts"), summaryLines.join("\n"));
	fs.writeFileSync(path.join(root, "raw-small.txt"), "raw small α\nsecond 😀\nthird");
	fs.writeFileSync(
		path.join(root, "conflicts.txt"),
		[
			"intro",
			"<<<<<<< ours",
			"ours line 1",
			"=======",
			"theirs line 1",
			">>>>>>> theirs",
			"middle",
			"<<<<<<< ours",
			"ours line 2",
			"=======",
			"theirs line 2",
			">>>>>>> theirs",
			"outro",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(root, "ten-lines.txt"),
		Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n"),
	);
	fs.writeFileSync(path.join(root, "empty.txt"), "");
	fs.writeFileSync(path.join(root, "single-line.txt"), "single line without a trailing newline");
	fs.writeFileSync(path.join(root, "giant-single-line.txt"), "😀".repeat(6_000));

	const localTree = path.join(root, "local-tree");
	fs.mkdirSync(path.join(localTree, "nested"), { recursive: true });
	fs.writeFileSync(path.join(localTree, "alpha.txt"), "alpha");
	fs.writeFileSync(path.join(localTree, "nested", "beta.txt"), "beta");
	const fixedMtime = new Date("2099-01-01T00:00:00.000Z");
	for (const localPath of [
		localTree,
		path.join(localTree, "nested"),
		path.join(localTree, "alpha.txt"),
		path.join(localTree, "nested", "beta.txt"),
	]) {
		fs.utimesSync(localPath, fixedMtime, fixedMtime);
	}

	// Keep explicit archive ranges above both line and byte budgets so the
	// invariant captures archive truncation without depending on bare-read direction.
	const archiveLargeLines = Array.from(
		{ length: 3_200 },
		(_, index) => `large-${String(index + 1).padStart(4, "0")}`,
	).join("\n");
	const archiveByteLines = Array.from(
		{ length: 120 },
		(_, index) => `bytes-${String(index + 1).padStart(3, "0")} ${"x".repeat(502)}`,
	).join("\n");
	const archiveEntries = {
		"docs/poem.txt": Array.from({ length: 8 }, (_, index) => `poem-${index + 1}`).join("\n"),
		"docs/large-lines.txt": archiveLargeLines,
		"docs/bytes.txt": archiveByteLines,
		"nested/alpha.txt": "archive alpha",
		"nested/deeper/beta.txt": "archive beta",
		"root.txt": "archive root",
	};
	const archivePath = path.join(root, "bundle.tar.gz");
	await Bun.write(archivePath, await new Bun.Archive(archiveEntries, { compress: "gzip" }).bytes());

	const markitPath = path.join(root, "markit.pdf");
	fs.writeFileSync(markitPath, "deterministic markit placeholder");
	markitContents.set(markitPath, Array.from({ length: 80 }, (_, index) => `markit-${index + 1}`).join("\n"));

	const notebookPath = path.join(root, "notebook.ipynb");
	fs.writeFileSync(
		notebookPath,
		JSON.stringify(
			{
				cells: [
					{ cell_type: "markdown", metadata: {}, source: ["# Read goldens\n", "Notebook fixture"] },
					{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["x = 1\n", "x + 1"] },
					{ cell_type: "raw", metadata: {}, source: ["raw notebook cell"] },
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			},
			null,
			2,
		),
	);

	const dbPath = path.join(root, "app.sqlite");
	const db = new Database(dbPath);
	try {
		db.run(
			"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL)",
		);
		for (const [id, name, status] of [
			[1, "Alice", "active"],
			[2, "Bob", "inactive"],
			[3, "Carol", "active"],
			[4, "Dave", "inactive"],
		] as const) {
			db.prepare("INSERT INTO users (id, name, email, status) VALUES (?, ?, ?, ?)").run(
				id,
				name,
				`${name.toLowerCase()}@example.test`,
				status,
			);
		}
	} finally {
		db.close();
	}

	const artifactDir = path.join(root, "artifacts");
	fs.mkdirSync(artifactDir, { recursive: true });
	fs.writeFileSync(
		path.join(artifactDir, "0.read.log"),
		Array.from({ length: 12 }, (_, i) =>
			i === 0 ? "artifact fixture line 1" : `artifact fixture line ${i + 1}`,
		).join("\n"),
	);
	return { root, artifactDir };
}

function surfaceCaptured(text: string): Captured {
	return { text, displayContent: null, truncation: null, meta: null };
}

async function captureSurface(entry: Entry, tool: { description: string }): Promise<Captured> {
	switch (entry.name) {
		case "prompt-read-default":
		case "prompt-read-head":
			return surfaceCaptured(tool.description);
		case "docs-read-flow-line": {
			const repoRoot = path.resolve(import.meta.dir, "../../../..");
			const lines = fs.readFileSync(path.join(repoRoot, "docs/tools/read.md"), "utf8").split("\n");
			return surfaceCaptured(lines.slice(65, 68).join("\n"));
		}
		case "cli-read-help": {
			const codingAgentRoot = path.resolve(import.meta.dir, "../..");
			const process = Bun.spawn(["bun", "src/cli.ts", "read", "--help"], {
				cwd: codingAgentRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const text = await new Response(process.stdout).text();
			const error = await new Response(process.stderr).text();
			await process.exited;
			if (process.exitCode !== 0) throw new Error(`gjc read --help failed: ${error}`);
			return surfaceCaptured(text);
		}
		default:
			throw new Error(`unknown surface golden ${entry.name}`);
	}
}

async function runPhase(currentPhase: GoldenPhase): Promise<number> {
	let skipped = 0;
	for (const entry of manifest) {
		if (entry.phase > currentPhase) {
			skipped++;
			continue;
		}
		assertRunnable(entry, currentPhase);
		for (const hashLines of entry.hashLines) {
			const variant = variantFor(hashLines);
			const settings = Settings.isolated({
				...(entry.settings ?? {}),
				...(FORCE_TRUNCATION === undefined ? {} : { "read.truncation": FORCE_TRUNCATION }),
				readHashLines: hashLines,
			});
			const bridgeText =
				entry.name === "acp-bare-parity"
					? fs.readFileSync(path.join(fixture.root, "prose.txt"), "utf8")
					: undefined;
			const session = createSession(fixture.root, settings, fixture.artifactDir, bridgeText);
			const tool = wrapToolWithMetaNotice(new ReadTool(session));
			const value =
				entry.bucket === "surface"
					? await captureSurface(entry, new ReadTool(session))
					: capture(
							(await tool.execute(
								`read-golden-${entry.name}-${variant}`,
								materializeRequest(entry.capturedAs ?? entry.request) as Parameters<
									InstanceType<typeof ReadTool>["execute"]
								>[1],
								undefined,
								undefined,
								createContext(settings),
							)) as ReadResult,
						);
			compareGolden(entry, variant, value, currentPhase);
		}
	}
	return skipped;
}

describe("read truncation golden harness", () => {
	beforeAll(async () => {
		installRealNativesMock();
		fixture = await createFixtures(fs.mkdtempSync(path.join(os.tmpdir(), "read-goldens-")));

		contextManager = SessionManager.inMemory(fixture.root);
		urlPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== "https://8.8.8.8/read-goldens") {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}
			return {
				ok: true,
				status: 200,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "url fixture line 1\nurl fixture line 2\nurl fixture line 3",
			};
		});
	});

	afterAll(async () => {
		urlPageSpy?.mockRestore();
		await contextManager?.close();
		fs.rmSync(fixture.root, { recursive: true, force: true });
	});

	it("runs the active golden phase and skips later entries", async () => {
		const skipped = await runPhase(CURRENT_PHASE);
		expect(skipped).toBe(manifest.filter(entry => entry.phase > CURRENT_PHASE).length);
	});

	it("keeps the active manifest phase set exactly equal to on-disk golden files by bucket", () => {
		const expected = expectedGoldenFiles(CURRENT_PHASE);
		for (const bucket of GOLDEN_BUCKETS_TO_CHECK) {
			const sorted = (files: Set<string>) => [...files].sort();
			expect(sorted(actualGoldenFiles(bucket))).toEqual(sorted(expected.get(bucket) ?? new Set()));
		}
	});

	it("pins the manifest inventory and phase-0 golden budget independently", () => {
		for (const bucket of ["invariant", "changed", "surface"] as const) {
			const entries = manifest.filter(entry => entry.bucket === bucket);
			const names = entries.map(entry => entry.name);
			expect(entries).toHaveLength(EXPECTED_MANIFEST_COUNTS[bucket]);
			expect(new Set(names).size).toBe(EXPECTED_MANIFEST_COUNTS[bucket]);
			expect([...names].sort()).toEqual([...EXPECTED_MANIFEST_NAMES[bucket]].sort());
		}

		expect(manifest).toHaveLength(41);
		const phaseZeroGoldenFiles = manifest
			.filter(entry => entry.phase === 0)
			.reduce((total, entry) => total + entry.hashLines.length, 0);
		expect(phaseZeroGoldenFiles).toBe(EXPECTED_PHASE_ZERO_GOLDEN_FILES);
		expect(actualGoldenFiles("invariant").size).toBe(EXPECTED_PHASE_ZERO_GOLDEN_FILES);
	});

	it("keeps hashline golden variants anchored and distinct from plain variants", () => {
		const hashline = JSON.parse(fs.readFileSync(goldenPath("changed", "local-bare-tail", "hl"), "utf8")) as Captured;
		const plain = JSON.parse(fs.readFileSync(goldenPath("changed", "local-bare-tail", "plain"), "utf8")) as Captured;
		expect(hashline.text).toMatch(/(?:^|\n)\d+[a-z]{2}\|/);
		expect(plain.text).not.toMatch(/(?:^|\n)\d+[a-z]{2}\|/);
		expect(hashline.text).not.toBe(plain.text);
	});

	it("keeps archive range fixtures above line and byte budgets", () => {
		for (const variant of ["hl", "plain"] as const) {
			const large = JSON.parse(
				fs.readFileSync(goldenPath("invariant", "archive-large-ranged", variant), "utf8"),
			) as Captured;
			const bytes = JSON.parse(
				fs.readFileSync(goldenPath("invariant", "archive-bytes-ranged", variant), "utf8"),
			) as Captured;
			expect(large.text.length).toBeGreaterThan(0);
			expect((large.truncation as { totalLines: number }).totalLines).toBe(3_200);
			expect(bytes.text.length).toBeGreaterThan(0);
			expect((bytes.truncation as { totalBytes: number }).totalBytes).toBeGreaterThanOrEqual(60 * 1024);
		}
	});

	it("round-trips tail hashline anchors through ReadTool, cache, and EditTool", async () => {
		const relativePath = "anchor-roundtrip.txt";
		const absolutePath = path.join(fixture.root, relativePath);
		const sourceLines = Array.from({ length: 20 }, () => "duplicate");
		fs.writeFileSync(absolutePath, sourceLines.join("\n"));

		const settings = Settings.isolated({
			"read.summarize.enabled": false,
			"read.receiptBudgetLines": 6,
			"read.receiptBudgetBytes": 1024,
			readHashLines: true,
			readLineNumbers: false,
		});
		const session = createSession(fixture.root, settings, fixture.artifactDir);
		session.enableLsp = false;
		const previousPiVariant = Bun.env.PI_EDIT_VARIANT;
		const previousGjcVariant = Bun.env.GJC_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "hashline";
		Bun.env.GJC_EDIT_VARIANT = "hashline";

		try {
			const readResult = (await new ReadTool(session).execute("anchor-roundtrip-read", {
				path: relativePath,
			})) as ReadResult;
			const anchors = parseHashlineAnchors(textOf(readResult));
			expect(anchors.map(anchor => anchor.line)).toEqual([15, 16, 17, 18, 19, 20]);
			expect(anchors.every(anchor => anchor.content === "duplicate")).toBe(true);
			expect(anchors.every(anchor => computeLineHash(anchor.line, anchor.content) === anchor.hash)).toBe(true);

			const snapshot = getFileReadCache(session).get(absolutePath);
			expect(snapshot).not.toBeNull();
			expect([...snapshot!.lines.entries()]).toEqual(anchors.map(anchor => [anchor.line, anchor.content]));

			await Settings.init({ inMemory: true, cwd: fixture.root });

			const editTool = new EditTool(session);
			const targets = [anchors[0]!, anchors[2]!, anchors.at(-1)!];
			const expectedChanges = new Map<number, string>();
			for (const target of targets) {
				const replacement = `edited-${target.line}`;
				expectedChanges.set(target.line, replacement);
				await editTool.execute("anchor-roundtrip-edit", {
					input: [`§${relativePath}`, `≔${target.line}${target.hash}`, replacement].join("\n"),
				});

				const diskLines = fs.readFileSync(absolutePath, "utf8").split("\n");
				expect(diskLines[target.line - 1]).toBe(replacement);
				for (const [lineNumber, line] of diskLines.entries()) {
					expect(line).toBe(expectedChanges.get(lineNumber + 1) ?? "duplicate");
				}
			}
		} finally {
			if (previousPiVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
			else Bun.env.PI_EDIT_VARIANT = previousPiVariant;
			if (previousGjcVariant === undefined) delete Bun.env.GJC_EDIT_VARIANT;
			else Bun.env.GJC_EDIT_VARIANT = previousGjcVariant;
		}
	});

	it("rejects phase-1 entries when a phase-0 runner attempts to execute them", () => {
		const phaseOne = manifest.find(entry => entry.phase === 1);
		expect(phaseOne).toBeDefined();
		expect(() => assertRunnable(phaseOne!, 0)).toThrow(/phase-1 entry/);
	});

	it("keeps writeGolden restricted to changed/ and update mode", () => {
		expect(() => writeGolden("invariant", "guard", "hl", {} as Captured)).toThrow(
			/refusing to write invariant\/guard/,
		);
		expect(() => writeGolden("surface", "guard", "plain", {} as Captured)).toThrow(
			/refusing to write surface\/guard/,
		);
	});
});

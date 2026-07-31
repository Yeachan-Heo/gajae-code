import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import {
	ansiToHtml,
	captureProvenance,
	committedBlobSha256,
	PROVENANCE_DIFF_SCOPE,
	REPOSITORY_ROOT,
	resolveRepositoryPath,
	xterm256Color,
} from "../scripts/capture-sticky-viewport-showcase";
import {
	stickyViewportFrameTextDigest,
	verifyStickyViewportShowcase,
} from "../scripts/verify-sticky-viewport-showcase";
import {
	SEMANTIC_ANCHOR_DOMAIN,
	STICKY_VIEWPORT_FRAME_TEXT_WITNESS,
	STICKY_VIEWPORT_SHOWCASE_COVERAGE,
	semanticAnchorDigest,
} from "./fixtures/tui/sticky-viewport-showcase";

const roots: string[] = [];
const restoreEnvironment = (name: string, value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};
async function capture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-"));
	roots.push(root);
	const result = Bun.spawn(
		["bun", "packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts", "--out", root],
		{
			cwd: REPOSITORY_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if ((await result.exited) !== 0) throw new Error(await new Response(result.stderr).text());
	return root;
}
async function captureWithEnv(overrides: Record<string, string>, drop: readonly string[] = []): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-env-"));
	roots.push(root);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	for (const key of drop) delete env[key];
	const result = Bun.spawn(
		["bun", "packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts", "--out", root],
		{
			cwd: REPOSITORY_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...env, ...overrides },
		},
	);
	if ((await result.exited) !== 0) throw new Error(await new Response(result.stderr).text());
	return root;
}
async function rehash(root: string, key: string, name: string): Promise<void> {
	const manifestPath = path.join(root, "manifest.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	const content = await fs.readFile(path.join(root, key, name), "utf8");
	const file = manifest.entries
		.find((entry: { key: string }) => entry.key === key)
		.files.find((entry: { path: string }) => entry.path.endsWith(`/${name}`));
	file.sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
	file.byte_length = Buffer.byteLength(content);
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceAnsiColor(root: string, key: string, replacement: string): Promise<void> {
	const ansiPath = path.join(root, key, "terminal-ansi.txt");
	const ansi = await fs.readFile(ansiPath, "utf8");
	const rewritten = ansi.replace(/\x1b\[[0-9;]*m/, replacement);
	if (rewritten === ansi) throw new Error(`expected a replaceable ANSI color in ${key}`);
	await Bun.write(ansiPath, rewritten);
	await Bun.write(path.join(root, key, "terminal.html"), ansiToHtml(rewritten));
	await rehash(root, key, "terminal-ansi.txt");
	await rehash(root, key, "terminal.html");
}

async function rebindReviewInput(root: string): Promise<void> {
	const manifest = await fs.readFile(path.join(root, "manifest.json"), "utf8");
	const reviewPath = path.join(root, "review-input.json");
	const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
	review.manifest_sha256 = new Bun.CryptoHasher("sha256").update(manifest).digest("hex");
	await Bun.write(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
}

// Re-stamp every persisted provenance block to the values the verifier computes
// live, then rebind every digest that depends on them. `git_diff_binary_sha256`
// is recomputed at verify time over the render-dependency closure, so a bundle
// captured seconds earlier goes stale the moment anything in that closure is
// written. The staleness guard then rejects BEFORE the guard a corruption case
// targets, and the case silently proves nothing. Re-stamping models an attacker
// who controls the entire bundle — they ran the capture themselves, so the
// provenance stamp is theirs too — which is strictly stronger than one who
// cannot. The staleness guard keeps its own dedicated coverage below.
async function restampProvenance(root: string): Promise<void> {
	const manifestPath = path.join(root, "manifest.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	const current = await captureProvenance();
	for (const key of manifest.ordered_keys as string[]) {
		const metadataPath = path.join(root, key, "metadata.json");
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
		metadata.provenance = { ...metadata.provenance, ...current };
		const content = `${JSON.stringify(metadata, null, 2)}\n`;
		await Bun.write(metadataPath, content);
		const file = manifest.entries
			.find((entry: { key: string }) => entry.key === key)
			.files.find((entry: { path: string }) => entry.path.endsWith("/metadata.json"));
		file.sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
		file.byte_length = Buffer.byteLength(content);
	}
	manifest.provenance = { ...manifest.provenance, ...current };
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	await Bun.write(manifestPath, manifestText);
	const reviewPath = path.join(root, "review-input.json");
	const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
	review.provenance = { ...review.provenance, ...current };
	review.manifest_sha256 = new Bun.CryptoHasher("sha256").update(manifestText).digest("hex");
	await Bun.write(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
}
// The owner's exploit rehashed `metadata.json`, the manifest entry, AND the review
// input together, so the bundle stayed internally consistent and only the anchor
// guard could reject it. Every anchor corruption case below performs that same
// coordinated rehash — otherwise it would fail on an earlier digest check and
// prove nothing about the guard.
async function writeMetadataCoordinated(root: string, key: string, metadata: unknown): Promise<void> {
	await Bun.write(path.join(root, key, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	await restampProvenance(root);
}
// Mutable view of a persisted entry. Only the fields the corruption cases below
// actually reach into are named; the rest stays opaque so a schema addition does
// not force a change here.
type SemanticAnchorEvidence = {
	domain: string;
	id: string;
	namespace: string;
	grapheme_start: number;
	grapheme_end: number;
	cell_start: number;
	cell_end: number;
	frame_start_row: number;
	row_text_sha256: string;
	frame_sha256: string;
	frame_text_sha256: string;
};
type MetadataEvidence = {
	state: {
		semantic_anchor: SemanticAnchorEvidence | null;
		cursor: { frame_sha256: string };
		visible_empty_irc_frame: { text: string };
		resize_probes: Array<{ frame: { text: string } }>;
	} & Record<string, unknown>;
} & Record<string, unknown>;
async function readMetadata(root: string, key: string): Promise<MetadataEvidence> {
	return JSON.parse(await fs.readFile(path.join(root, key, "metadata.json"), "utf8")) as MetadataEvidence;
}
// Recompute a VALID anchor for an already-mutated frame. The anchor guard runs
// before the downstream metadata checks, so a case that mutates the painted frame
// to exercise one of those later checks must carry an anchor that is honest about
// the new paint — otherwise the guard rejects first and the case stops proving
// what it was written to prove.
async function recomputeAnchor(root: string, key: string): Promise<void> {
	const metadata = await readMetadata(root, key);
	const anchor = metadata.state.semantic_anchor;
	if (anchor === null) return;
	const ansi = await fs.readFile(path.join(root, key, "terminal-ansi.txt"), "utf8");
	const rowText = (await fs.readFile(path.join(root, key, "terminal.txt"), "utf8")).split("\n")[
		anchor.frame_start_row
	]!;
	const frameSha256 = new Bun.CryptoHasher("sha256").update(ansi).digest("hex");
	const frameTextSha256 = new Bun.CryptoHasher("sha256").update(Bun.stripANSI(ansi)).digest("hex");
	anchor.frame_sha256 = frameSha256;
	anchor.frame_text_sha256 = frameTextSha256;
	anchor.row_text_sha256 = new Bun.CryptoHasher("sha256").update(rowText).digest("hex");
	anchor.id = `${anchor.namespace}:${semanticAnchorDigest({
		entryKey: key,
		namespace: anchor.namespace,
		rowText,
		graphemeStart: anchor.grapheme_start,
		graphemeEnd: anchor.grapheme_end,
		cellStart: anchor.cell_start,
		cellEnd: anchor.cell_end,
		frameRow: anchor.frame_start_row,
		frameTextSha256,
	})}`;
	await writeMetadataCoordinated(root, key, metadata);
}

async function validIndependentReview(root: string): Promise<Record<string, unknown>> {
	const manifestText = await fs.readFile(path.join(root, "manifest.json"), "utf8");
	const keys: string[] = JSON.parse(manifestText).ordered_keys;
	return {
		schema_version: 2,
		manifest_sha256: new Bun.CryptoHasher("sha256").update(manifestText).digest("hex"),
		reviewer_identity: "independent-terminal-reviewer",
		reviewer_role: "independent-terminal-reviewer",
		fixture_revision: "sticky-viewport-showcase-v2",
		expected_entry_count: 20,
		observed_entry_count: 20,
		final: "accept",
		checked_keys: keys,
		defects: [],
		artifact_decision: "accept",
		cjk_semantic_line_breaks: "accept",
		host_matrix: "accept",
		per_key_results: keys.map(key => ({
			key,
			result: "accept",
			notes: "All required artifacts match the stage-03 contract.",
			artifact_checks: {
				terminal_txt: true,
				terminal_ansi_txt: true,
				terminal_html: true,
				metadata_json: true,
			},
		})),
	};
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
describe("sticky viewport production evidence verifier", () => {
	it("derives IRC resize coverage from the production split renderer", () => {
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.irc).toEqual(["empty", "streaming", "long"]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.todo).toEqual([
			"empty",
			"populated",
			"long",
			"multi-phase",
			"collapsed",
			"expanded",
		]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.widths).toEqual([64, 65, 80, 120, 160, 120, 80, 65, 64]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.heights).toEqual(["short", "standard"]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.viewport).toEqual(["manual", "follow", "resize-grow", "resize-shrink"]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.chrome).toEqual([
			"pending",
			"statusContainer",
			"btw",
			"statusLine",
			"hooks",
			"editor",
			"pet",
		]);
		expect(STICKY_VIEWPORT_SHOWCASE_COVERAGE.evidence).toEqual([
			"overlap",
			"width-overflow",
			"hidden-cursor-focus",
			"anchor-loss",
			"cjk-semantic-break",
		]);
	});
	it("captures authoritative production probe frames and semantic root IDs", async () => {
		const root = await capture();
		const metadata = JSON.parse(
			await fs.readFile(path.join(root, "multiline-editor-hooks-pet/80x24/unicode-color", "metadata.json"), "utf8"),
		);
		expect(metadata.state.root_order).toEqual([
			"irc-split",
			"pending-messages",
			"status-container",
			"todos",
			"btw",
			"status-line",
			"hooks-above",
			"editor-container",
			"pet-floor",
			"hooks-below",
		]);
		expect(metadata.state.pin_boundary.component).toBe("status-line");
		expect(metadata.state.pin_boundary.index).toBe(5);
		expect(metadata.state.focused_component).toBe("editor");
		expect(metadata.state.cursor.blink).toBe(true);
		expect(metadata.state.resize_probes.map((probe: { columns: number }) => probe.columns)).toEqual([
			64, 65, 80, 120, 160, 120, 80, 65, 64,
		]);
		expect(metadata.state.resize_probes[0]).toMatchObject({
			effective_lane: "transcript",
			irc_records: 0,
			todo_rows: 0,
		});
		expect(metadata.state.resize_probes[1]).toMatchObject({
			effective_lane: "split",
			separator_width: 3,
			irc_records: 1,
			todo_rows: 1,
			todo_expanded: false,
		});
		expect(metadata.state.resize_probes[2]).toMatchObject({ todo_expanded: true });
		expect(metadata.state.visible_empty_irc_frame.text).not.toContain("worker → you");
		expect(metadata.state.resize_probes[3].frame.text).toContain("worker → you");
	}, 120_000);
	it("renders inverse ANSI as effective colors and closes spans across resets", () => {
		const html = ansiToHtml("\x1b[31;44;7mX\x1b[27mY\x1b[0mZ");
		expect(html).toContain("color:#3465a4;background-color:#cc0000");
		expect(html).not.toContain("filter:invert");
		expect(html).toContain("</span><span");
	});
	it("normalizes xterm cube and grayscale foreground/background colors identically", () => {
		expect(xterm256Color(196)).toBe("rgb(255,0,0)");
		expect(xterm256Color(51)).toBe("rgb(0,255,255)");
		expect(xterm256Color(232)).toBe("rgb(8,8,8)");
		expect(xterm256Color(255)).toBe("rgb(238,238,238)");
		expect(ansiToHtml("\x1b[38;5;196;48;5;51mC\x1b[0m")).toContain(
			"color:rgb(255,0,0);background-color:rgb(0,255,255)",
		);
		expect(ansiToHtml("\x1b[38;5;232;48;5;255mG\x1b[0m")).toContain(
			"color:rgb(8,8,8);background-color:rgb(238,238,238)",
		);
	});
	it("rejects artifact mutation even when the manifest digest is rebound", async () => {
		const root = await capture();
		const cubeKey = "manual-new-output/80x24/unicode-color";
		await replaceAnsiColor(root, cubeKey, "\x1b[38;5;196;48;5;51m");
		// Give the mutated frame an honest anchor, so the anchor guard has nothing to
		// object to and `cursor.frame_sha256` remains the sole falsified digest. This
		// keeps the case pointed at the runtime observation check it was written for.
		await recomputeAnchor(root, cubeKey);
		await rebindReviewInput(root);
		await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("runtime observation mismatch");
	}, 120_000);
	it("requires terminal HTML to be the exact canonical ANSI conversion", async () => {
		const root = await capture();
		const key = "manual-new-output/80x24/unicode-color";
		const htmlPath = path.join(root, key, "terminal.html");
		await Bun.write(
			htmlPath,
			(await fs.readFile(htmlPath, "utf8")).replace("</style>", "pre{visibility:hidden}</style>"),
		);
		await rehash(root, key, "terminal.html");
		await expect(verifyStickyViewportShowcase(root)).rejects.toThrow(
			"HTML artifact is not canonical ANSI conversion",
		);
	}, 120_000);
	it("round-trips xterm strikethrough and production-only SGR attributes", async () => {
		const terminal = new VirtualTerminal(20, 1);
		terminal.write("\x1b[5;8;9;53mX\x1b[25;28;29;55mY");
		await terminal.flush();
		expect(terminal.getViewportAnsi()).toContain("\x1b[0m\x1b[5;8;9;53mX\x1b[0mY");
		const html = ansiToHtml("\x1b[5;8;9;53mX\x1b[25;28;29;55mY");
		expect(html).toContain("animation:blink 1s step-end infinite");
		expect(html).toContain("visibility:hidden");
		expect(html).toContain("text-decoration:line-through overline");
	});
	it("captures and accepts the immutable production 20-key matrix", async () => {
		await verifyStickyViewportShowcase(await capture());
	}, 120_000);
	it("binds every semantic anchor id to its own entry, content, geometry, and frame", async () => {
		const root = await capture();
		const keys: string[] = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")).ordered_keys;
		const seen = new Map<string, string>();
		let anchored = 0;
		for (const key of keys) {
			const metadata = await readMetadata(root, key);
			const anchor = metadata.state.semantic_anchor;
			if (anchor === null) continue;
			anchored += 1;
			expect(anchor.domain).toBe(SEMANTIC_ANCHOR_DOMAIN);
			expect(anchor.namespace).toBe("user:entry");
			// Full-length digest: the previous 8-hex suffix was brute-forceable, and a
			// chosen-input search found a colliding geometry pair in ~26k attempts.
			expect(anchor.id).toMatch(/^user:entry:[0-9a-f]{64}$/);
			// Every digest input is persisted, so a third party can recompute the id
			// without re-running the capture.
			const text = await fs.readFile(path.join(root, key, "terminal.txt"), "utf8");
			const rowText = text.split("\n")[anchor.frame_start_row]!;
			expect(anchor.row_text_sha256).toBe(new Bun.CryptoHasher("sha256").update(rowText).digest("hex"));
			expect(anchor.frame_sha256).toBe(
				new Bun.CryptoHasher("sha256")
					.update(await fs.readFile(path.join(root, key, "terminal-ansi.txt"), "utf8"))
					.digest("hex"),
			);
			expect(anchor.id).toBe(
				`user:entry:${semanticAnchorDigest({
					entryKey: key,
					namespace: "user:entry",
					rowText,
					graphemeStart: anchor.grapheme_start,
					graphemeEnd: anchor.grapheme_end,
					cellStart: anchor.cell_start,
					cellEnd: anchor.cell_end,
					frameRow: anchor.frame_start_row,
					frameTextSha256: anchor.frame_text_sha256,
				})}`,
			);
			// No silent aliasing: the geometry-only digest collapsed 17 anchors onto 6
			// ids, one of which claimed six entries with different painted frames.
			expect(seen.has(anchor.id)).toBe(false);
			seen.set(anchor.id, key);
		}
		expect(anchored).toBe(17);
		expect(seen.size).toBe(17);
		await verifyStickyViewportShowcase(root);
	}, 120_000);
	it("rejects rehashed semantic anchor forgery, transplant, geometry, content, and truncation", async () => {
		const base = await capture();
		const cloneBase = async () => {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-anchor-"));
			roots.push(clone);
			await fs.cp(base, clone, { recursive: true });
			return clone;
		};
		const key = "manual-new-output/80x24/unicode-color";
		const otherKey = "manual-history/80x24/unicode-color";
		// Every case below asserts on a non-null anchor, so narrow once here rather
		// than repeating a non-null assertion at each mutation site.
		const anchorOf = (metadata: MetadataEvidence): SemanticAnchorEvidence => {
			const anchor = metadata.state.semantic_anchor;
			if (anchor === null) throw new Error(`expected a semantic anchor for ${key}`);
			return anchor;
		};

		// 1. Arbitrary id. This is the exact `deadbeef`-style substitution the owner
		// pushed through the official verifier.
		const arbitrary = await cloneBase();
		const arbitraryMetadata = await readMetadata(arbitrary, key);
		anchorOf(arbitraryMetadata).id = "user:entry:deadbeef";
		await writeMetadataCoordinated(arbitrary, key, arbitraryMetadata);
		await expect(verifyStickyViewportShowcase(arbitrary)).rejects.toThrow("semantic anchor guard");

		// 2. Cross-entry transplant. Previously accepted, because ids were not bound
		// to the entry they describe.
		const swapped = await cloneBase();
		const donor = await readMetadata(swapped, otherKey);
		const swappedMetadata = await readMetadata(swapped, key);
		expect(anchorOf(donor).id).not.toBe(anchorOf(swappedMetadata).id);
		anchorOf(swappedMetadata).id = anchorOf(donor).id;
		await writeMetadataCoordinated(swapped, key, swappedMetadata);
		await expect(verifyStickyViewportShowcase(swapped)).rejects.toThrow("semantic anchor guard");

		// 3. Two distinct anchor geometries under one id. `grapheme_end`/`cell_end`
		// were not even persisted before, so neither was recomputable.
		for (const field of ["grapheme_end", "cell_end"] as const) {
			const geometry = await cloneBase();
			const geometryMetadata = await readMetadata(geometry, key);
			anchorOf(geometryMetadata)[field] = anchorOf(geometryMetadata)[field] + 1;
			await writeMetadataCoordinated(geometry, key, geometryMetadata);
			await expect(verifyStickyViewportShowcase(geometry)).rejects.toThrow("semantic anchor guard");
		}

		// 4. Content mutation with UNCHANGED geometry. Every other digest in the
		// bundle is coordinately recomputed — including the row and frame digests the
		// guard itself reads — so only the id-to-content binding can reject this.
		const content = await cloneBase();
		const contentMetadata = await readMetadata(content, key);
		const frameRow = anchorOf(contentMetadata).frame_start_row;
		const ansiPath = path.join(content, key, "terminal-ansi.txt");
		const ansiRows = (await fs.readFile(ansiPath, "utf8")).split("\n");
		// Same cell width, so the geometry the guard recomputes against is identical.
		expect(ansiRows[frameRow]).toContain("selectable");
		ansiRows[frameRow] = ansiRows[frameRow]!.replace("selectable", "selectabIe");
		const mutatedAnsi = ansiRows.join("\n");
		await Bun.write(ansiPath, mutatedAnsi);
		await Bun.write(path.join(content, key, "terminal.txt"), Bun.stripANSI(mutatedAnsi));
		await Bun.write(path.join(content, key, "terminal.html"), ansiToHtml(mutatedAnsi));
		const mutatedFrameSha = new Bun.CryptoHasher("sha256").update(mutatedAnsi).digest("hex");
		contentMetadata.state.cursor.frame_sha256 = mutatedFrameSha;
		anchorOf(contentMetadata).frame_sha256 = mutatedFrameSha;
		anchorOf(contentMetadata).row_text_sha256 = new Bun.CryptoHasher("sha256")
			.update(Bun.stripANSI(mutatedAnsi).split("\n")[frameRow]!)
			.digest("hex");
		for (const name of ["terminal-ansi.txt", "terminal.txt", "terminal.html"] as const)
			await rehash(content, key, name);
		await writeMetadataCoordinated(content, key, contentMetadata);
		await expect(verifyStickyViewportShowcase(content)).rejects.toThrow("semantic anchor guard");

		// 5. Truncated-prefix collision. The owner found two distinct geometry tuples
		// colliding on prefix `f2dc8fc6` in 26,084 attempts, so a truncated id must
		// never be accepted as equivalent to its own full digest.
		const truncated = await cloneBase();
		const truncatedMetadata = await readMetadata(truncated, key);
		const fullId = anchorOf(truncatedMetadata).id;
		anchorOf(truncatedMetadata).id = `user:entry:${fullId.split(":")[2]!.slice(0, 8)}`;
		await writeMetadataCoordinated(truncated, key, truncatedMetadata);
		await expect(verifyStickyViewportShowcase(truncated)).rejects.toThrow("semantic anchor guard");

		// 6. Fully coordinated relocation + geometry transplant. Every digest the
		// producer controls is recomputed — row text digest, frame digests, the full
		// 64-hex id, metadata digest, manifest, review-input binding, and scoped
		// provenance — so the bundle is internally consistent by construction. Digest
		// consistency therefore cannot reject it; only the source-side immutable
		// expectation can, because the verifier's own bytes are inside
		// `source_sha256` and a bundle producer cannot rewrite them.
		const relocated = await cloneBase();
		const transplantMetadata = await readMetadata(relocated, "manual-history/80x24/unicode-color");
		const transplant = anchorOf(transplantMetadata);
		const relocatedMetadata = await readMetadata(relocated, key);
		const victim = anchorOf(relocatedMetadata);
		victim.grapheme_start = transplant.grapheme_start;
		victim.grapheme_end = transplant.grapheme_end;
		victim.cell_start = transplant.cell_start;
		victim.cell_end = transplant.cell_end;
		victim.frame_start_row = victim.frame_start_row + 1;
		await writeMetadataCoordinated(relocated, key, relocatedMetadata);
		await recomputeAnchor(relocated, key);
		await expect(verifyStickyViewportShowcase(relocated)).rejects.toThrow(
			"anchor row or geometry does not match its immutable expectation",
		);
	}, 300_000);
	it("fails closed for semantic evidence and provenance corruption", async () => {
		// `capture()` spawns a ~2.2s subprocess. Capture once and clone the
		// deterministic output so each corruption case stays isolated without
		// paying that cost seven times, which overruns the timeout budget.
		const base = await capture();
		const cloneBase = async () => {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-semantic-"));
			roots.push(clone);
			await fs.cp(base, clone, { recursive: true });
			return clone;
		};
		const root = await cloneBase();
		const key = "manual-new-output/80x24/unicode-color";
		await fs.writeFile(path.join(root, key, "terminal.txt"), "forged\n");
		await rehash(root, key, "terminal.txt");
		await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("semantic evidence");
		const provenanceRoot = await cloneBase();
		const metadataPath = path.join(provenanceRoot, key, "metadata.json");
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
		metadata.provenance.capture_mode = "fixture";
		await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
		await rehash(provenanceRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(provenanceRoot)).rejects.toThrow("metadata schema");
		const noticeRoot = await cloneBase();
		const noticeMetadataPath = path.join(noticeRoot, key, "metadata.json");
		const noticeMetadata = JSON.parse(await fs.readFile(noticeMetadataPath, "utf8"));
		noticeMetadata.output_revision = "0";
		await Bun.write(noticeMetadataPath, `${JSON.stringify(noticeMetadata, null, 2)}\n`);
		await rehash(noticeRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(noticeRoot)).rejects.toThrow("renderer-owned viewport state mismatch");
		const falseManualRoot = await cloneBase();
		const falseManualPath = path.join(falseManualRoot, key, "metadata.json");
		const falseManual = JSON.parse(await fs.readFile(falseManualPath, "utf8"));
		falseManual.state.manual = false;
		await Bun.write(falseManualPath, `${JSON.stringify(falseManual, null, 2)}\n`);
		await rehash(falseManualRoot, key, "metadata.json");
		await rebindReviewInput(falseManualRoot);
		await expect(verifyStickyViewportShowcase(falseManualRoot)).rejects.toThrow(
			"renderer-owned viewport state mismatch",
		);

		const extraNoticeRoot = await cloneBase();
		const extraNoticeKey = "manual-history/80x24/unicode-color";
		const extraNoticePath = path.join(extraNoticeRoot, extraNoticeKey, "metadata.json");
		const extraNotice = JSON.parse(await fs.readFile(extraNoticePath, "utf8"));
		extraNotice.state.notice = true;
		await Bun.write(extraNoticePath, `${JSON.stringify(extraNotice, null, 2)}\n`);
		await rehash(extraNoticeRoot, extraNoticeKey, "metadata.json");
		await rebindReviewInput(extraNoticeRoot);
		await expect(verifyStickyViewportShowcase(extraNoticeRoot)).rejects.toThrow(
			"renderer-owned viewport state mismatch",
		);

		const staleRevisionRoot = await cloneBase();
		const staleRevisionPath = path.join(staleRevisionRoot, key, "metadata.json");
		const staleRevision = JSON.parse(await fs.readFile(staleRevisionPath, "utf8"));
		staleRevision.state.observed_output_revision = "0";
		await Bun.write(staleRevisionPath, `${JSON.stringify(staleRevision, null, 2)}\n`);
		await rehash(staleRevisionRoot, key, "metadata.json");
		await rebindReviewInput(staleRevisionRoot);
		await expect(verifyStickyViewportShowcase(staleRevisionRoot)).rejects.toThrow(
			"renderer-owned viewport state mismatch",
		);
		const crossBoundaryRoot = await cloneBase();
		const crossBoundaryKey = "selection-boundary/80x24/unicode-color";
		const crossBoundaryPath = path.join(crossBoundaryRoot, crossBoundaryKey, "metadata.json");
		const crossBoundary = JSON.parse(await fs.readFile(crossBoundaryPath, "utf8"));
		crossBoundary.state.selection.end.row = crossBoundary.state.transcript_capacity;
		await Bun.write(crossBoundaryPath, `${JSON.stringify(crossBoundary, null, 2)}\n`);
		await rehash(crossBoundaryRoot, crossBoundaryKey, "metadata.json");
		await rebindReviewInput(crossBoundaryRoot);
		await expect(verifyStickyViewportShowcase(crossBoundaryRoot)).rejects.toThrow(
			"selection boundary evidence missing",
		);

		const capacityRoot = await cloneBase();
		const capacityKey = "capacity-one/80x24/unicode-color";
		const capacityMetadataPath = path.join(capacityRoot, capacityKey, "metadata.json");
		const capacityMetadata = JSON.parse(await fs.readFile(capacityMetadataPath, "utf8"));
		capacityMetadata.state.transcript_capacity = 2;
		await Bun.write(capacityMetadataPath, `${JSON.stringify(capacityMetadata, null, 2)}\n`);
		await rehash(capacityRoot, capacityKey, "metadata.json");
		// The frame-derived capacity oracle rejects this before the downstream
		// observation check, because the painted status row contradicts the claim.
		await expect(verifyStickyViewportShowcase(capacityRoot)).rejects.toThrow("capacity metadata/frame mismatch");

		// `pin_boundary.row` is assigned from the same renderer local as
		// `transcript_capacity`, so mutating it alone is only detectable against the
		// committed paint. This case fails if that assertion ever becomes tautological.
		const pinRoot = await cloneBase();
		const pinKey = "capacity-one/80x24/unicode-color";
		const pinMetadataPath = path.join(pinRoot, pinKey, "metadata.json");
		const pinMetadata = JSON.parse(await fs.readFile(pinMetadataPath, "utf8"));
		pinMetadata.state.pin_boundary.row = (pinMetadata.state.pin_boundary.row as number) + 1;
		pinMetadata.state.transcript_capacity = pinMetadata.state.pin_boundary.row;
		await Bun.write(pinMetadataPath, `${JSON.stringify(pinMetadata, null, 2)}\n`);
		await rehash(pinRoot, pinKey, "metadata.json");
		await expect(verifyStickyViewportShowcase(pinRoot)).rejects.toThrow("capacity metadata/frame mismatch");

		const cjkRoot = await cloneBase();
		const cjkKey = "narrow-cjk/48x10/unicode-color";
		for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
			const artifactPath = path.join(cjkRoot, cjkKey, name);
			await Bun.write(
				artifactPath,
				(await fs.readFile(artifactPath, "utf8")).replace("意味のある文の境界", "missing CJK proof"),
			);
			await rehash(cjkRoot, cjkKey, name);
		}
		const cjkMetadataPath = path.join(cjkRoot, cjkKey, "metadata.json");
		const cjkMetadata = JSON.parse(await fs.readFile(cjkMetadataPath, "utf8"));
		cjkMetadata.cjk_phrase_boundaries = [];
		cjkMetadata.state.cursor.frame_sha256 = new Bun.CryptoHasher("sha256")
			.update(await fs.readFile(path.join(cjkRoot, cjkKey, "terminal-ansi.txt"), "utf8"))
			.digest("hex");
		await Bun.write(cjkMetadataPath, `${JSON.stringify(cjkMetadata, null, 2)}\n`);
		await rehash(cjkRoot, cjkKey, "metadata.json");
		// The mutated CJK paint moves the anchor row, so re-derive the anchor from it.
		// The guard then has no objection and the narrow-CJK boundary check stays the
		// assertion under test.
		await recomputeAnchor(cjkRoot, cjkKey);
		await expect(verifyStickyViewportShowcase(cjkRoot)).rejects.toThrow("narrow CJK boundaries");

		const evidenceRoot = await cloneBase();
		const evidencePath = path.join(evidenceRoot, key, "metadata.json");
		const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
		evidence.state.visible_empty_irc_frame.text = "forged populated IRC";
		await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
		await rehash(evidenceRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(evidenceRoot)).rejects.toThrow("runtime observation");

		const nonNarrowCjkRoot = await cloneBase();
		const nonNarrowMetadataPath = path.join(nonNarrowCjkRoot, key, "metadata.json");
		const nonNarrowMetadata = JSON.parse(await fs.readFile(nonNarrowMetadataPath, "utf8"));
		nonNarrowMetadata.cjk_phrase_boundaries = ["意味のある文の境界"];
		await Bun.write(nonNarrowMetadataPath, `${JSON.stringify(nonNarrowMetadata, null, 2)}\n`);
		await rehash(nonNarrowCjkRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(nonNarrowCjkRoot)).rejects.toThrow("non-narrow CJK boundaries");
	}, 180_000);
	// The corruption cases above re-stamp provenance so they isolate the guard they
	// target. That is only safe if the staleness guard is independently proven to
	// still reject a genuinely stale bundle — otherwise re-stamping could mask its
	// removal. These cases carry an internally consistent bundle whose ONLY defect
	// is provenance, at each of the three sites the verifier checks.
	it("fails closed for stale and scope-narrowed capture provenance", async () => {
		const base = await capture();
		const cloneBase = async () => {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-stale-"));
			roots.push(clone);
			await fs.cp(base, clone, { recursive: true });
			return clone;
		};
		const key = "manual-new-output/80x24/unicode-color";
		// `git_diff_binary_sha256` covers the render-dependency closure, NOT the whole
		// worktree. Editing an out-of-scope file cannot change the paint, so it must
		// not invalidate a bundle; this pins that the test file itself is out of scope
		// and the renderer sources are in it.
		expect(PROVENANCE_DIFF_SCOPE).toContain("packages/tui/src");
		expect(PROVENANCE_DIFF_SCOPE).toContain("packages/coding-agent/src");
		expect(PROVENANCE_DIFF_SCOPE).not.toContain("packages/coding-agent/test/sticky-viewport-showcase.test.ts");

		// Re-stamping an otherwise untouched bundle must still verify. This is what
		// makes the re-stamped corruption cases above trustworthy: a rejection there
		// is the injected defect, never the re-stamp.
		const restamped = await cloneBase();
		await restampProvenance(restamped);
		await verifyStickyViewportShowcase(restamped);

		// Rebind the review input in both manifest cases, so the ONLY remaining defect
		// is provenance and the rejection cannot be attributed to a digest mismatch.
		const staleManifest = await cloneBase();
		const staleManifestPath = path.join(staleManifest, "manifest.json");
		const staleManifestJson = JSON.parse(await fs.readFile(staleManifestPath, "utf8"));
		staleManifestJson.provenance.git_diff_binary_sha256 = "0".repeat(64);
		await Bun.write(staleManifestPath, `${JSON.stringify(staleManifestJson, null, 2)}\n`);
		await rebindReviewInput(staleManifest);
		await expect(verifyStickyViewportShowcase(staleManifest)).rejects.toThrow("manifest capture provenance is stale");

		// A bundle must not be able to shrink the covered surface to dodge the digest.
		const narrowedScope = await cloneBase();
		const narrowedPath = path.join(narrowedScope, "manifest.json");
		const narrowed = JSON.parse(await fs.readFile(narrowedPath, "utf8"));
		narrowed.provenance.git_diff_scope = ["packages/tui/src/tui.ts"];
		await Bun.write(narrowedPath, `${JSON.stringify(narrowed, null, 2)}\n`);
		await rebindReviewInput(narrowedScope);
		await expect(verifyStickyViewportShowcase(narrowedScope)).rejects.toThrow("manifest capture provenance is stale");

		const staleMetadata = await cloneBase();
		const staleMetadataPath = path.join(staleMetadata, key, "metadata.json");
		const staleMetadataJson = JSON.parse(await fs.readFile(staleMetadataPath, "utf8"));
		staleMetadataJson.provenance.git_diff_binary_sha256 = "0".repeat(64);
		await Bun.write(staleMetadataPath, `${JSON.stringify(staleMetadataJson, null, 2)}\n`);
		await rehash(staleMetadata, key, "metadata.json");
		await rebindReviewInput(staleMetadata);
		await expect(verifyStickyViewportShowcase(staleMetadata)).rejects.toThrow("metadata schema mismatch");

		const staleReview = await cloneBase();
		const staleReviewPath = path.join(staleReview, "review-input.json");
		const staleReviewJson = JSON.parse(await fs.readFile(staleReviewPath, "utf8"));
		staleReviewJson.provenance.git_diff_binary_sha256 = "0".repeat(64);
		await Bun.write(staleReviewPath, `${JSON.stringify(staleReviewJson, null, 2)}\n`);
		await expect(verifyStickyViewportShowcase(staleReview)).rejects.toThrow(
			"review input capture provenance is stale",
		);
	}, 180_000);
	it("rejects table-driven manifest, metadata, and review-input corruption", async () => {
		const base = await capture();
		const fresh = async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-case-"));
			roots.push(root);
			await fs.cp(base, root, { recursive: true });
			return root;
		};
		const key = "manual-new-output/80x24/unicode-color";
		const cases: Array<[string, (root: string) => Promise<void>]> = [
			[
				"19 entries",
				async root => {
					const manifestPath = path.join(root, "manifest.json");
					const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
					manifest.entries.pop();
					manifest.entry_count = 19;
					manifest.expected_entry_count = 19;
					await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				},
			],
			[
				"21 entries",
				async root => {
					const manifestPath = path.join(root, "manifest.json");
					const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
					manifest.entries.push(structuredClone(manifest.entries[0]));
					manifest.entry_count = 21;
					await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				},
			],
			["missing payload", async root => fs.rm(path.join(root, key, "terminal.html"))],
			["extra payload", async root => void (await Bun.write(path.join(root, key, "extra.txt"), "extra"))],
			[
				"digest corruption",
				async root => {
					const manifestPath = path.join(root, "manifest.json");
					const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
					manifest.entries.find((entry: { key: string }) => entry.key === key).files[0].sha256 = "0".repeat(64);
					await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				},
			],
			[
				"byte-length corruption",
				async root => {
					const manifestPath = path.join(root, "manifest.json");
					const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
					manifest.entries.find((entry: { key: string }) => entry.key === key).files[0].byte_length = 0;
					await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
				},
			],
			[
				"missing variant metadata",
				async root => {
					const metadataPath = path.join(root, key, "metadata.json");
					const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
					delete metadata.render_mode;
					await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
					await rehash(root, key, "metadata.json");
				},
			],
			[
				"extra variant metadata",
				async root => {
					const metadataPath = path.join(root, key, "metadata.json");
					const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
					metadata.variant = "unexpected";
					await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
					await rehash(root, key, "metadata.json");
				},
			],
			[
				"invalid variant metadata",
				async root => {
					const metadataPath = path.join(root, key, "metadata.json");
					const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
					metadata.ansi_mode = "yes";
					await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
					await rehash(root, key, "metadata.json");
				},
			],
			...(["font_rendering_assumptions", "wrapping_truncation_policy"] as const).flatMap(
				field =>
					[
						[
							`missing ${field}`,
							async (root: string) => {
								const p = path.join(root, key, "metadata.json");
								const m = JSON.parse(await fs.readFile(p, "utf8"));
								delete m.terminal[field];
								await Bun.write(p, `${JSON.stringify(m, null, 2)}\n`);
								await rehash(root, key, "metadata.json");
							},
						],
						[
							`invalid ${field}`,
							async (root: string) => {
								const p = path.join(root, key, "metadata.json");
								const m = JSON.parse(await fs.readFile(p, "utf8"));
								m.terminal[field] = 1;
								await Bun.write(p, `${JSON.stringify(m, null, 2)}\n`);
								await rehash(root, key, "metadata.json");
							},
						],
					] as Array<[string, (root: string) => Promise<void>]>,
			),
			...(["acceptance_version", "design_version", "host_matrix"] as const).map(
				field =>
					[
						`invalid review input ${field}`,
						async (root: string) => {
							const p = path.join(root, "review-input.json");
							const review = JSON.parse(await fs.readFile(p, "utf8"));
							review[field] = "invalid";
							await Bun.write(p, `${JSON.stringify(review, null, 2)}\n`);
						},
					] as [string, (root: string) => Promise<void>],
			),
		];
		for (const [, mutate] of cases) {
			const root = await fresh();
			await mutate(root);
			await expect(verifyStickyViewportShowcase(root)).rejects.toThrow();
		}
	}, 180_000);
	it("fails closed for every independent-review attestation field", async () => {
		const root = await capture();
		const review = await validIndependentReview(root);
		await Bun.write(path.join(root, "independent-review.json"), JSON.stringify(review));
		await verifyStickyViewportShowcase(root, true);
		const cases: Array<[string, (candidate: Record<string, unknown>) => void]> = [
			["reviewer identity", candidate => (candidate.reviewer_identity = " capture-sticky-viewport-showcase ")],
			["reviewer role", candidate => (candidate.reviewer_role = "author")],
			["fixture revision", candidate => (candidate.fixture_revision = "wrong")],
			["expected count", candidate => (candidate.expected_entry_count = 19)],
			["observed count", candidate => (candidate.observed_entry_count = 21)],
			["artifact decision", candidate => (candidate.artifact_decision = "reject")],
			["CJK decision", candidate => (candidate.cjk_semantic_line_breaks = "reject")],
			["host decision", candidate => (candidate.host_matrix = "reject")],
			["per-key count", candidate => (candidate.per_key_results as unknown[]).pop()],
			[
				"per-key key",
				candidate => ((candidate.per_key_results as Array<Record<string, unknown>>)[0]!.key = "wrong"),
			],
			[
				"per-key result",
				candidate => ((candidate.per_key_results as Array<Record<string, unknown>>)[0]!.result = "reject"),
			],
			["per-key notes", candidate => ((candidate.per_key_results as Array<Record<string, unknown>>)[0]!.notes = "")],
			[
				"per-key artifact checks",
				candidate =>
					((
						(candidate.per_key_results as Array<Record<string, unknown>>)[0]!.artifact_checks as Record<
							string,
							unknown
						>
					).terminal_html = false),
			],
			["extra review root key", candidate => (candidate.unexpected = true)],
			[
				"extra per-key result key",
				candidate => ((candidate.per_key_results as Array<Record<string, unknown>>)[0]!.unexpected = true),
			],
			[
				"extra artifact check key",
				candidate =>
					((
						(candidate.per_key_results as Array<Record<string, unknown>>)[0]!.artifact_checks as Record<
							string,
							unknown
						>
					).unexpected = true),
			],
			[
				"extra defect key",
				candidate => (candidate.defects = [{ description: "Verified defect", accepted: true, unexpected: true }]),
			],
			["blank defect description", candidate => (candidate.defects = [{ description: "   ", accepted: true }])],
			[
				"noncanonical defect description",
				candidate => (candidate.defects = [{ description: " Verified defect ", accepted: true }]),
			],
		];
		for (const [, mutate] of cases) {
			const candidate = structuredClone(review);
			mutate(candidate);
			await Bun.write(path.join(root, "independent-review.json"), JSON.stringify(candidate));
			await expect(verifyStickyViewportShowcase(root, true)).rejects.toThrow("independent review");
		}
	}, 180_000);
	it("keeps required metadata escape-free, repo-independent, and reproducible within and across hosts", async () => {
		// `metadata.json` is a required manifest artifact, so host-negotiated color
		// there makes the whole bundle host-dependent even when the three top-level
		// payloads are canonical. `detectColorMode()` picks indexed `38;5;n` when
		// TERM is dumb/empty/linux and truecolor `38;2;r;g;b` when COLORTERM says so,
		// which is exactly the pair this asserts away.
		const asciiKeys = ["manual-new-output/80x24/ascii-no-color", "capacity-zero/48x10/ascii-no-color"] as const;
		const dumb = await captureWithEnv({ TERM: "dumb" }, ["COLORTERM"]);
		const truecolor = await captureWithEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" });
		// Same host, same worktree, same merge state, back-to-back. This is the axis
		// the `detached` vs `detached +8` defect broke: the status line resolved repo
		// state through an async `git status --porcelain` whose completion raced the
		// capture, so one run painted the staged count and the next did not.
		const dumbRepeat = await captureWithEnv({ TERM: "dumb" }, ["COLORTERM"]);
		for (const key of asciiKeys) {
			const dumbMetadata = await fs.readFile(path.join(dumb, key, "metadata.json"), "utf8");
			const truecolorMetadata = await fs.readFile(path.join(truecolor, key, "metadata.json"), "utf8");
			const repeatMetadata = await fs.readFile(path.join(dumbRepeat, key, "metadata.json"), "utf8");
			expect(dumbMetadata).not.toContain("\u001b[");
			expect(truecolorMetadata).not.toContain("\u001b[");
			expect(dumbMetadata).toEqual(truecolorMetadata);
			expect(dumbMetadata).toEqual(repeatMetadata);
			expect(new Bun.CryptoHasher("sha256").update(dumbMetadata).digest("hex")).toBe(
				new Bun.CryptoHasher("sha256").update(truecolorMetadata).digest("hex"),
			);
		}
		// Repository state must not reach ANY required frame, on either color axis.
		// The git segment paints the branch plus `*n`/`+n`/`?n` porcelain counts at
		// >=120 columns, and the path segment paints the cwd basename — both are host
		// state, and the capture now pins a preset that excludes them outright.
		const keys: string[] = JSON.parse(await fs.readFile(path.join(dumb, "manifest.json"), "utf8")).ordered_keys;
		for (const root of [dumb, truecolor, dumbRepeat]) {
			for (const key of keys) {
				const metadata = await readMetadata(root, key);
				const frames = [
					metadata.state.visible_empty_irc_frame.text as string,
					...(metadata.state.resize_probes as Array<{ frame: { text: string } }>).map(probe => probe.frame.text),
				];
				for (const frame of frames) {
					expect(frame).toContain("⬢");
					// No branch name, no porcelain counts, no cwd basename.
					expect(frame).not.toContain("detached");
					expect(frame).not.toContain("⑂");
					expect(frame).not.toContain("🗑");
					expect(frame).not.toMatch(/[*+?]\d+\s/);
				}
			}
			// Unicode entries legitimately differ in SGR form across hosts, but their
			// semantic payload must not: stripping color has to leave identical bytes.
			for (const key of keys) {
				const stripped = Bun.stripANSI(await fs.readFile(path.join(root, key, "terminal.txt"), "utf8"));
				const reference = Bun.stripANSI(await fs.readFile(path.join(dumb, key, "terminal.txt"), "utf8"));
				expect(stripped).toEqual(reference);
			}
		}
		await verifyStickyViewportShowcase(dumb);
		await verifyStickyViewportShowcase(truecolor);
		await verifyStickyViewportShowcase(dumbRepeat);
		// Semantic anchor identity must name WHAT is anchored, not how the host
		// negotiated color. The first digest bound the ANSI frame sha256, so 16 of 17
		// anchors changed id between an indexed-color and a truecolor host while the
		// stripped paint was byte-identical — an evidence field that moves for a
		// reason unrelated to its meaning. The preimage now binds the stripped-text
		// digest, and `frame_sha256` stays persisted only as artifact binding.
		let comparedAnchors = 0;
		for (const key of keys) {
			const dumbAnchor = (await readMetadata(dumb, key)).state.semantic_anchor;
			const truecolorAnchor = (await readMetadata(truecolor, key)).state.semantic_anchor;
			if (dumbAnchor === null || truecolorAnchor === null) {
				expect(dumbAnchor).toBe(truecolorAnchor);
				continue;
			}
			expect(dumbAnchor.id).toBe(truecolorAnchor.id);
			expect(dumbAnchor.frame_text_sha256).toBe(truecolorAnchor.frame_text_sha256);
			expect(dumbAnchor.row_text_sha256).toBe(truecolorAnchor.row_text_sha256);
			expect(dumbAnchor.frame_start_row).toBe(truecolorAnchor.frame_start_row);
			comparedAnchors += 1;
		}
		expect(comparedAnchors).toBe(17);
	}, 600_000);

	it("rejects escape bytes in required ascii-no-color metadata frames", async () => {
		const base = await capture();
		const key = "manual-new-output/80x24/ascii-no-color";
		const cloneBase = async () => {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-ascii-"));
			roots.push(clone);
			await fs.cp(base, clone, { recursive: true });
			return clone;
		};
		const forge = (value: string) => {
			const forged = `\u001b[31m${value}`;
			return {
				ansi: forged,
				text: Bun.stripANSI(forged),
				sha256: new Bun.CryptoHasher("sha256").update(forged).digest("hex"),
			};
		};
		// The pre-existing text/digest checks are satisfied on purpose, so only the
		// no-color guard can reject these.
		const emptyRoot = await cloneBase();
		const emptyPath = path.join(emptyRoot, key, "metadata.json");
		const emptyMetadata = JSON.parse(await fs.readFile(emptyPath, "utf8"));
		emptyMetadata.state.visible_empty_irc_frame = forge(emptyMetadata.state.visible_empty_irc_frame.ansi);
		await Bun.write(emptyPath, `${JSON.stringify(emptyMetadata, null, 2)}\n`);
		await rehash(emptyRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(emptyRoot)).rejects.toThrow("runtime observation mismatch");

		const probeRoot = await cloneBase();
		const probePath = path.join(probeRoot, key, "metadata.json");
		const probeMetadata = JSON.parse(await fs.readFile(probePath, "utf8"));
		probeMetadata.state.resize_probes[0].frame = forge(probeMetadata.state.resize_probes[0].frame.ansi);
		await Bun.write(probePath, `${JSON.stringify(probeMetadata, null, 2)}\n`);
		await rehash(probeRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(probeRoot)).rejects.toThrow("runtime observation mismatch");
	}, 300_000);
	it("rejects a mutated verifier oracle expectation even when every provenance field is restamped", async () => {
		// The expectation table is immutable only if its digest comes from somewhere
		// the bundle cannot reach. `captureProvenance()` hashes the WORKTREE file, so
		// an author who edits the table and restamps provenance keeps the bundle
		// internally consistent, and that was accepted. The committed blob at the
		// recorded `git_head` is outside that reach: changing it requires a commit,
		// which changes `git_head` itself. This must reject BEFORE semantic-anchor
		// validation, because a mutated table would otherwise define what "valid"
		// means for every anchor downstream.
		const root = await capture();
		const oraclePath = resolveRepositoryPath("packages/coding-agent/scripts/verify-sticky-viewport-showcase.ts");
		const original = await fs.readFile(oraclePath, "utf8");
		try {
			const mutated = original.replace(/("manual-new-output\/80x24\/unicode-color":\s*\{\s*frameRow:\s*)0/, "$11");
			expect(mutated).not.toBe(original);
			await Bun.write(oraclePath, mutated);
			// Restamp exactly as the oracle did: metadata, manifest, review input, and
			// every provenance block recomputed against the mutated worktree.
			await restampProvenance(root);
			await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("oracle integrity");
		} finally {
			await Bun.write(oraclePath, original);
		}
		// Restoring the committed bytes makes the same bundle valid again, which
		// proves the rejection was the oracle mutation and not incidental staleness.
		await restampProvenance(root);
		await verifyStickyViewportShowcase(root);
	}, 300_000);
	it("rejects oracle bytes authorized only by an unrelated local or remote-tracking ref", async () => {
		// `--all` reachability proves a commit exists somewhere, not that it is the
		// commit under review. Committing malicious oracle bytes on any side ref must
		// not authorize them, with or without an explicit trusted authority.
		const root = await capture();
		const oracle = "packages/coding-agent/scripts/verify-sticky-viewport-showcase.ts";
		const original = await fs.readFile(resolveRepositoryPath(oracle), "utf8");
		const index = path.join(os.tmpdir(), `gjc-attacker-index-${Date.now()}`);
		const refSuffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
		const refs = [`refs/heads/gjc-test-attacker-${refSuffix}`, `refs/remotes/origin/gjc-test-attacker-${refSuffix}`];
		const originalOracleCommit = process.env.GJC_STICKY_VIEWPORT_ORACLE_COMMIT;
		const git = async (args: string[], stdin?: string) => {
			const proc = Bun.spawn(["git", ...args], {
				cwd: REPOSITORY_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
				// CI runners have no git identity, and `commit-tree` requires one. Supply it
				// through env so the test never mutates repository or global git config.
				env: {
					...process.env,
					GIT_INDEX_FILE: index,
					GIT_AUTHOR_NAME: "gjc-test",
					GIT_AUTHOR_EMAIL: "gjc-test@example.invalid",
					GIT_COMMITTER_NAME: "gjc-test",
					GIT_COMMITTER_EMAIL: "gjc-test@example.invalid",
					GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
					GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
					TZ: "UTC",
				},
			});
			const out = await new Response(proc.stdout).text();
			if ((await proc.exited) !== 0) throw new Error(`git ${args[0]}: ${await new Response(proc.stderr).text()}`);
			return out.trim();
		};
		try {
			const malicious = `${original}\n// attacker-authorized bytes\n`;
			const blob = await git(["hash-object", "-w", "--stdin"], malicious);
			await git(["read-tree", "HEAD"]);
			await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${oracle}`]);
			const tree = await git(["write-tree"]);
			const commit = await git(["commit-tree", tree, "-p", "HEAD", "-m", "attacker oracle"]);
			for (const ref of refs) await git(["update-ref", ref, commit]);
			// The malicious bytes are now reachable from two side refs and are what the
			// verifier would actually execute.
			await Bun.write(resolveRepositoryPath(oracle), malicious);
			await restampProvenance(root);
			await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("oracle integrity");
			// The operator may have declared an authority for the whole run (that is how
			// an uncommitted staged oracle is reviewed). Save and restore it rather than
			// deleting, or this case silently unpins every later case in the file.
			process.env.GJC_STICKY_VIEWPORT_ORACLE_COMMIT = await git(["rev-parse", "HEAD"]);
			try {
				await restampProvenance(root);
				await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("oracle integrity");
			} finally {
				restoreEnvironment("GJC_STICKY_VIEWPORT_ORACLE_COMMIT", originalOracleCommit);
			}
		} finally {
			restoreEnvironment("GJC_STICKY_VIEWPORT_ORACLE_COMMIT", originalOracleCommit);
			await Bun.write(resolveRepositoryPath(oracle), original);
			for (const ref of refs) {
				Bun.spawnSync(["git", "update-ref", "-d", ref], {
					cwd: REPOSITORY_ROOT,
					stdout: "ignore",
					stderr: "ignore",
				});
			}
			await fs.rm(index, { force: true });
		}
	}, 300_000);
	it("rejects an older declared oracle authority that lacks the running verifier bytes", async () => {
		const oracle = "packages/coding-agent/scripts/verify-sticky-viewport-showcase.ts";
		const oraclePath = resolveRepositoryPath(oracle);
		const runningBytes = await fs.readFile(oraclePath);
		const running = new Bun.CryptoHasher("sha256").update(runningBytes).digest("hex");
		const original = new TextDecoder().decode(runningBytes);
		const older = original.replace("Authority is exactly one commit.", "Authority is one explicitly trusted commit.");
		expect(older).not.toBe(original);

		const temporaryGitDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-older-oracle-"));
		const index = path.join(temporaryGitDirectory, "index");
		const originalOracleCommit = process.env.GJC_STICKY_VIEWPORT_ORACLE_COMMIT;
		const git = async (args: string[], stdin?: string): Promise<string> => {
			const proc = Bun.spawn(["git", ...args], {
				cwd: REPOSITORY_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
				env: {
					...process.env,
					GIT_INDEX_FILE: index,
					GIT_AUTHOR_NAME: "gjc-sticky-viewport-test",
					GIT_AUTHOR_EMAIL: "gjc-sticky-viewport-test@example.invalid",
					GIT_COMMITTER_NAME: "gjc-sticky-viewport-test",
					GIT_COMMITTER_EMAIL: "gjc-sticky-viewport-test@example.invalid",
					GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
					GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
					TZ: "UTC",
				},
			});
			const out = await new Response(proc.stdout).text();
			if ((await proc.exited) !== 0) throw new Error(`git ${args[0]}: ${await new Response(proc.stderr).text()}`);
			return out.trim();
		};

		try {
			const olderBlob = await git(["hash-object", "-w", "--stdin"], older);
			await git(["read-tree", "HEAD"]);
			await git(["update-index", "--add", "--cacheinfo", `100644,${olderBlob},${oracle}`]);
			const tree = await git(["write-tree"]);
			const authority = await git(["commit-tree", tree, "-p", "HEAD", "-m", "older trusted oracle"]);
			expect(authority).toMatch(/^[0-9a-f]{40}$/);
			expect(await committedBlobSha256(authority, oracle)).not.toBe(running);

			process.env.GJC_STICKY_VIEWPORT_ORACLE_COMMIT = authority;
			const root = await capture();
			await restampProvenance(root);
			await expect(verifyStickyViewportShowcase(root)).rejects.toThrow(
				`oracle integrity: ${oracle} differs from its committed blob at ${authority}`,
			);

			restoreEnvironment("GJC_STICKY_VIEWPORT_ORACLE_COMMIT", originalOracleCommit);
			await restampProvenance(root);
			await verifyStickyViewportShowcase(root);
		} finally {
			restoreEnvironment("GJC_STICKY_VIEWPORT_ORACLE_COMMIT", originalOracleCommit);
			await fs.rm(temporaryGitDirectory, { recursive: true, force: true });
		}
	}, 300_000);
	// Rewrite one painted row and perform the FULL coordinated rehash the bundle
	// producer controls: all three artifacts, their manifest digests, the cursor
	// frame digest, the anchor (optionally reminted so it is honest about the new
	// paint), every provenance block, and the review-input binding. The result is
	// internally consistent by construction, so no digest-consistency check can
	// reject it.
	async function forgeRow(
		root: string,
		key: string,
		row: number,
		mutate: (rowText: string) => string,
		remintAnchor: boolean,
	): Promise<string> {
		const ansiPath = path.join(root, key, "terminal-ansi.txt");
		const ansiRows = (await fs.readFile(ansiPath, "utf8")).split("\n");
		const before = ansiRows[row]!;
		ansiRows[row] = mutate(before);
		if (ansiRows[row] === before) throw new Error(`row ${row} of ${key} was not mutated`);
		const mutatedAnsi = ansiRows.join("\n");
		const mutatedText = Bun.stripANSI(mutatedAnsi);
		await Bun.write(ansiPath, mutatedAnsi);
		await Bun.write(path.join(root, key, "terminal.txt"), mutatedText);
		await Bun.write(path.join(root, key, "terminal.html"), ansiToHtml(mutatedAnsi));
		for (const name of ["terminal-ansi.txt", "terminal.txt", "terminal.html"] as const) await rehash(root, key, name);
		const metadata = await readMetadata(root, key);
		metadata.state.cursor.frame_sha256 = new Bun.CryptoHasher("sha256").update(mutatedAnsi).digest("hex");
		await writeMetadataCoordinated(root, key, metadata);
		if (remintAnchor) await recomputeAnchor(root, key);
		await rebindReviewInput(root);
		return mutatedText;
	}
	const rejectionMessage = async (root: string): Promise<string> => {
		try {
			await verifyStickyViewportShowcase(root);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error("expected the verifier to reject this bundle");
	};
	it("rejects a coordinated non-anchor row forgery the anchor guard cannot see", async () => {
		// Measured defect: the semantic anchor pins exactly ONE painted row, and
		// `anchor.frame_sha256` is recomputed from the bundle's own artifact. Mutating
		// `selectable` to `selectabIe` on a NON-anchor transcript row under a full
		// coordinated rehash was ACCEPTED — in an 80x24 frame 13 rows carry content and
		// only one was pinned, so ~10 rows, including the transcript rows carrying the
		// bundle's own evidence text, took arbitrary content.
		const root = await capture();
		const key = "manual-new-output/80x24/unicode-color";
		const anchorRow = (await readMetadata(root, key)).state.semantic_anchor!.frame_start_row;
		const rows = (await fs.readFile(path.join(root, key, "terminal.txt"), "utf8")).split("\n");
		// A row carrying the same token as the anchor row but which the anchor does
		// not cover, so the mutation is provably outside the anchor's reach. The
		// replacement is the same cell width, so no geometry check can notice.
		const targetRow = rows.findIndex((text, index) => index !== anchorRow && text.includes("selectable"));
		expect(targetRow).toBeGreaterThanOrEqual(0);
		expect(targetRow).not.toBe(anchorRow);
		const mutatedText = await forgeRow(root, key, targetRow, text => text.replace("selectable", "selectabIe"), true);
		const observed = stickyViewportFrameTextDigest(mutatedText);
		const expected = STICKY_VIEWPORT_FRAME_TEXT_WITNESS[key];
		expect(observed).not.toBe(expected);
		const message = await rejectionMessage(root);
		expect(message).toBe(
			`Sticky viewport evidence invalid: frame content guard: ${key} painted frame digest is ${observed} but the committed witness pins ${expected}`,
		);
		// Proves the rejection is the new whole-frame pin and not an earlier check
		// that happened to fire: no anchor guard, no digest, no provenance staleness.
		expect(message).not.toContain("semantic anchor guard");
		expect(message).not.toContain("hash or byte length mismatch");
		expect(message).not.toContain("capture provenance is stale");
	}, 300_000);
	it("pins the capacity-zero frames whose semantic anchor is null", async () => {
		// The three capacity-zero entries carry `semantic_anchor: null`, so before the
		// frame witness their paint had no immutable expectation at all: every row was
		// rewritable under the same coordinated rehash.
		const root = await capture();
		for (const key of [
			"capacity-zero/80x24/unicode-color",
			"capacity-zero/120x36/unicode-color",
			"capacity-zero/48x10/ascii-no-color",
		] as const) {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-frame-zero-"));
			roots.push(clone);
			await fs.cp(root, clone, { recursive: true });
			expect((await readMetadata(clone, key)).state.semantic_anchor).toBeNull();
			const rows = (await fs.readFile(path.join(clone, key, "terminal.txt"), "utf8")).split("\n");
			const targetRow = rows.findIndex(text => text.includes("reserved suffix row 1 "));
			expect(targetRow).toBeGreaterThanOrEqual(0);
			// Same width, and it touches none of the ordered suffix markers, so only the
			// frame witness can object.
			const mutatedText = await forgeRow(
				clone,
				key,
				targetRow,
				text => text.replace("reserved suffix row 1 ", "reserved suffix row I "),
				true,
			);
			const observed = stickyViewportFrameTextDigest(mutatedText);
			expect(await rejectionMessage(clone)).toBe(
				`Sticky viewport evidence invalid: frame content guard: ${key} painted frame digest is ${observed} but the committed witness pins ${STICKY_VIEWPORT_FRAME_TEXT_WITNESS[key]}`,
			);
		}
	}, 300_000);
	it("keeps anchor-row mutation attributed to the semantic anchor guard", async () => {
		// The frame witness must not steal attribution. An anchor-row mutation is
		// still the anchor guard's case, so the new guard is positioned after it and
		// this asserts the narrower message survives.
		const root = await capture();
		const key = "manual-new-output/80x24/unicode-color";
		const anchorRow = (await readMetadata(root, key)).state.semantic_anchor!.frame_start_row;
		const rows = (await fs.readFile(path.join(root, key, "terminal.txt"), "utf8")).split("\n");
		expect(rows[anchorRow]).toContain("selectable");
		// `remintAnchor: false`: every artifact and provenance digest is coordinately
		// rehashed, but the anchor id and row digest still describe the old paint.
		await forgeRow(root, key, anchorRow, text => text.replace("selectable", "selectabIe"), false);
		const message = await rejectionMessage(root);
		expect(message).toContain("semantic anchor guard");
		expect(message).not.toContain("frame content guard");
	}, 300_000);
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import {
	ansiToHtml,
	captureProvenance,
	PROVENANCE_DIFF_SCOPE,
	xterm256Color,
} from "../scripts/capture-sticky-viewport-showcase";
import { verifyStickyViewportShowcase } from "../scripts/verify-sticky-viewport-showcase";
import {
	SEMANTIC_ANCHOR_DOMAIN,
	STICKY_VIEWPORT_ANCHOR_WITNESS,
	STICKY_VIEWPORT_SHOWCASE_COVERAGE,
	type StickyViewportShowcaseKey,
	semanticAnchorDigest,
	semanticAnchorRowExcerpt,
} from "./fixtures/tui/sticky-viewport-showcase";

const roots: string[] = [];
async function capture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-"));
	roots.push(root);
	const result = Bun.spawn(
		["bun", "packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts", "--out", root],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
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
			cwd: path.resolve(import.meta.dir, "../../.."),
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
// Recompute a VALID anchor for an already-mutated frame, and route the write
// through the coordinated rehash. This is the attacker's own move: it produces an
// anchor whose id, row digest, and frame digest are all HONEST about the mutated
// paint, so every self-referential check in the verifier passes. The coordinated
// forgery test relies on that to prove the committed witness — not the
// recomputation — is what rejects a self-consistent lie.
async function recomputeAnchor(root: string, key: string): Promise<void> {
	const metadata = await readMetadata(root, key);
	const anchor = metadata.state.semantic_anchor;
	if (anchor === null) return;
	const ansi = await fs.readFile(path.join(root, key, "terminal-ansi.txt"), "utf8");
	const rowText = (await fs.readFile(path.join(root, key, "terminal.txt"), "utf8")).split("\n")[
		anchor.frame_start_row
	]!;
	const frameSha256 = new Bun.CryptoHasher("sha256").update(ansi).digest("hex");
	anchor.frame_sha256 = frameSha256;
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
		frameSha256,
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
			if (anchor === null) {
				// A null anchor is legitimate ONLY where committed source pins null.
				expect(STICKY_VIEWPORT_ANCHOR_WITNESS[key as StickyViewportShowcaseKey]).toBeNull();
				continue;
			}
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
			// Committed-source agreement. A fresh capture must reproduce the intended
			// semantic row and the complete geometry pinned in git history. If a
			// legitimate renderer change moves an anchor, this fails until the witness is
			// updated in the same commit — which makes the intended row a reviewed source
			// change instead of a silent regeneration.
			const witness = STICKY_VIEWPORT_ANCHOR_WITNESS[key as StickyViewportShowcaseKey];
			if (!witness) throw new Error(`${key} has no committed anchor witness`);
			expect(anchor.frame_start_row).toBe(witness.frameRow);
			expect(anchor.grapheme_start).toBe(witness.graphemeStart);
			expect(anchor.grapheme_end).toBe(witness.graphemeEnd);
			expect(anchor.cell_start).toBe(witness.cellStart);
			expect(anchor.cell_end).toBe(witness.cellEnd);
			expect(anchor.namespace).toBe(witness.namespace);
			expect(anchor.row_text_sha256).toBe(witness.rowTextSha256);
			expect(semanticAnchorRowExcerpt(rowText)).toBe(witness.rowExcerpt);
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
					frameSha256: anchor.frame_sha256,
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
	}, 300_000);
	// Review-2 P1-A. Every case in the test above corrupts the anchor id itself, so
	// recomputing the digest from the persisted inputs is enough to reject it. A
	// COORDINATED forgery cannot be rejected that way, and no amount of hardening
	// the digest can change that: the attacker ran the capture, so they rewrite the
	// paint and then HONESTLY recompute the id, the row digest, the frame digest,
	// `metadata.json`, the manifest entry, and the review-input binding. Every
	// self-referential check then passes by construction, because each one compares
	// attacker-supplied bytes against other attacker-supplied bytes.
	//
	// Three such forgeries were accepted by the digest-only guard: fabricated
	// geometry, anchor-row content mutation, and anchor-row relocation (#3547).
	// They are rejected only by comparison against `STICKY_VIEWPORT_ANCHOR_WITNESS`,
	// which is committed source the attacker did not write. Each case below asserts
	// the shipped anchor IS the honest digest of its own inputs before verifying, so
	// a rejection can never be attributed to a stale digest it forgot to update.
	it("rejects coordinated anchor forgery that honestly recomputes every dependent digest", async () => {
		const base = await capture();
		const cloneBase = async () => {
			const clone = await fs.mkdtemp(path.join(os.tmpdir(), "sticky-viewport-showcase-coordinated-"));
			roots.push(clone);
			await fs.cp(base, clone, { recursive: true });
			return clone;
		};
		const key = "manual-new-output/80x24/unicode-color";
		const anchorOf = (metadata: MetadataEvidence): SemanticAnchorEvidence => {
			const anchor = metadata.state.semantic_anchor;
			if (anchor === null) throw new Error("expected a semantic anchor");
			return anchor;
		};
		// Proof that the forgery is self-consistent. If any of these fail, the case
		// would be rejected by the recomputation guard rather than by the witness, and
		// would prove nothing about coordinated forgery.
		const expectSelfConsistent = async (root: string, entryKey: string) => {
			const metadata = await readMetadata(root, entryKey);
			const anchor = anchorOf(metadata);
			const text = await fs.readFile(path.join(root, entryKey, "terminal.txt"), "utf8");
			const ansi = await fs.readFile(path.join(root, entryKey, "terminal-ansi.txt"), "utf8");
			const rowText = text.split("\n")[anchor.frame_start_row]!;
			const frameSha256 = new Bun.CryptoHasher("sha256").update(ansi).digest("hex");
			expect(anchor.frame_sha256).toBe(frameSha256);
			expect(anchor.row_text_sha256).toBe(new Bun.CryptoHasher("sha256").update(rowText).digest("hex"));
			expect(anchor.id).toBe(
				`${anchor.namespace}:${semanticAnchorDigest({
					entryKey,
					namespace: anchor.namespace,
					rowText,
					graphemeStart: anchor.grapheme_start,
					graphemeEnd: anchor.grapheme_end,
					cellStart: anchor.cell_start,
					cellEnd: anchor.cell_end,
					frameRow: anchor.frame_start_row,
					frameSha256,
				})}`,
			);
		};
		// Apply a mutation, then rebind everything that depends on it: `recomputeAnchor`
		// recomputes the anchor honestly for the mutated paint and routes the write
		// through `writeMetadataCoordinated`, which re-stamps the manifest entry and the
		// review-input binding.
		const forge = async (
			entryKey: string,
			mutate: (metadata: MetadataEvidence, root: string) => Promise<void> | void,
		) => {
			const root = await cloneBase();
			const metadata = await readMetadata(root, entryKey);
			await mutate(metadata, root);
			await Bun.write(path.join(root, entryKey, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
			await recomputeAnchor(root, entryKey);
			await expectSelfConsistent(root, entryKey);
			return root;
		};

		// 1. Fabricated geometry. The span is widened to a value that is still a
		// nonnegative, non-inverted integer range, so every structural check accepts
		// it; the witness pins the exact end offsets.
		const fabricated = await forge(key, metadata => {
			anchorOf(metadata).grapheme_end += 4096;
			anchorOf(metadata).cell_end += 4096;
		});
		await expect(verifyStickyViewportShowcase(fabricated)).rejects.toThrow(
			`semantic anchor guard: ${key} grapheme_end`,
		);

		// 2. Anchor-row content mutation. `selectable` becomes `selectabIe` at equal
		// cell width, so no geometry or layout check notices, and the row and frame
		// digests are recomputed to agree with the forged paint.
		const mutated = await forge(key, async (metadata, root) => {
			const frameRow = anchorOf(metadata).frame_start_row;
			const ansiPath = path.join(root, key, "terminal-ansi.txt");
			const rows = (await fs.readFile(ansiPath, "utf8")).split("\n");
			expect(rows[frameRow]).toContain("selectable");
			rows[frameRow] = rows[frameRow]!.replace("selectable", "selectabIe");
			const forged = rows.join("\n");
			await Bun.write(ansiPath, forged);
			await Bun.write(path.join(root, key, "terminal.txt"), Bun.stripANSI(forged));
			await Bun.write(path.join(root, key, "terminal.html"), ansiToHtml(forged));
			metadata.state.cursor.frame_sha256 = new Bun.CryptoHasher("sha256").update(forged).digest("hex");
			for (const name of ["terminal-ansi.txt", "terminal.txt", "terminal.html"] as const)
				await rehash(root, key, name);
		});
		await expect(verifyStickyViewportShowcase(mutated)).rejects.toThrow(
			`semantic anchor guard: ${key} painted anchor row content contradicts the committed witness`,
		);

		// 3. Anchor-row relocation — the #3547 attack. The evidence still points at a
		// real painted row, just not the intended one, and every digest agrees with the
		// relocation. Nothing inside the bundle contradicts it.
		const relocated = await forge(key, async (metadata, root) => {
			const rows = (await fs.readFile(path.join(root, key, "terminal.txt"), "utf8")).split("\n").slice(0, -1);
			const from = anchorOf(metadata).frame_start_row;
			const to = rows.findIndex((row, index) => index !== from && row.trim().length > 0);
			expect(to).toBeGreaterThanOrEqual(0);
			expect(to).not.toBe(from);
			anchorOf(metadata).frame_start_row = to;
		});
		await expect(verifyStickyViewportShowcase(relocated)).rejects.toThrow(
			`semantic anchor guard: ${key} frame_start_row`,
		);

		// 4. The narrow-CJK anchor row rewritten across every painted artifact, with
		// the anchor honestly recomputed. Unlike cases 1-3 this was NOT accepted before
		// the witness — the narrow-CJK cell oracle already rejected it, with a message
		// about the missing canonical phrase. It is kept here because this exact
		// mutation used to live in the semantic-evidence test, where it was written to
		// exercise a LATER check and therefore had to carry an honest anchor. The
		// witness now rejects it earlier, so the case moves here rather than being
		// deleted, and it pins which guard owns it.
		const cjkKey = "narrow-cjk/48x10/unicode-color";
		const cjkForged = await forge(cjkKey, async (metadata, root) => {
			for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
				const artifactPath = path.join(root, cjkKey, name);
				const rewritten = (await fs.readFile(artifactPath, "utf8")).replace(
					"意味のある文の境界",
					"missing CJK proof",
				);
				await Bun.write(artifactPath, rewritten);
				await rehash(root, cjkKey, name);
			}
			metadata.state.cursor.frame_sha256 = new Bun.CryptoHasher("sha256")
				.update(await fs.readFile(path.join(root, cjkKey, "terminal-ansi.txt"), "utf8"))
				.digest("hex");
		});
		await expect(verifyStickyViewportShowcase(cjkForged)).rejects.toThrow(
			`semantic anchor guard: ${cjkKey} painted anchor row content contradicts the committed witness`,
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

		// Metadata-only mutation. The `cjk_phrase_boundaries` matrix check runs ahead
		// of the narrow-CJK frame-evidence check, so clearing the field is enough to
		// exercise it. The painted artifacts are deliberately left intact: the CJK
		// phrase sits on the committed anchor row, so rewriting it contradicts the
		// committed anchor witness and is rejected by the semantic anchor guard first.
		// That rewrite is retained as an explicit witness case in the coordinated
		// forgery test, so the coverage moves rather than disappears.
		const cjkRoot = await cloneBase();
		const cjkKey = "narrow-cjk/48x10/unicode-color";
		const cjkMetadataPath = path.join(cjkRoot, cjkKey, "metadata.json");
		const cjkMetadata = JSON.parse(await fs.readFile(cjkMetadataPath, "utf8"));
		cjkMetadata.cjk_phrase_boundaries = [];
		await Bun.write(cjkMetadataPath, `${JSON.stringify(cjkMetadata, null, 2)}\n`);
		await rehash(cjkRoot, cjkKey, "metadata.json");
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
});

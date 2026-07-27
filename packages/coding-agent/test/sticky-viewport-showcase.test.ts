import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ansiToHtml, xterm256Color } from "../scripts/capture-sticky-viewport-showcase";
import { verifyStickyViewportShowcase } from "../scripts/verify-sticky-viewport-showcase";

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
	it("round-trips xterm cube and grayscale artifacts and rejects ANSI color corruption", async () => {
		const root = await capture();
		const cubeKey = "manual-new-output/80x24/unicode-color";
		const grayscaleKey = "manual-new-output/120x36/unicode-color";
		await replaceAnsiColor(root, cubeKey, "\x1b[38;5;196;48;5;51m");
		await replaceAnsiColor(root, grayscaleKey, "\x1b[38;5;232;48;5;255m");
		await rebindReviewInput(root);
		await verifyStickyViewportShowcase(root);

		const ansiPath = path.join(root, cubeKey, "terminal-ansi.txt");
		const ansi = await fs.readFile(ansiPath, "utf8");
		const corrupted = ansi.replace("\x1b[38;5;196;48;5;51m", "\x1b[38;5;46;48;5;21m");
		if (corrupted === ansi) throw new Error("expected injected xterm SGR sequence");
		await Bun.write(ansiPath, corrupted);
		await rehash(root, cubeKey, "terminal-ansi.txt");
		await expect(verifyStickyViewportShowcase(root)).rejects.toThrow(
			"HTML artifact is not canonical ANSI conversion",
		);
	}, 15_000);
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
	}, 15_000);
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
	});
	it("fails closed for semantic evidence and provenance corruption", async () => {
		const root = await capture();
		const key = "manual-new-output/80x24/unicode-color";
		await fs.writeFile(path.join(root, key, "terminal.txt"), "forged\n");
		await rehash(root, key, "terminal.txt");
		await expect(verifyStickyViewportShowcase(root)).rejects.toThrow("semantic evidence");
		const provenanceRoot = await capture();
		const metadataPath = path.join(provenanceRoot, key, "metadata.json");
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
		metadata.provenance.capture_mode = "fixture";
		await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
		await rehash(provenanceRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(provenanceRoot)).rejects.toThrow("metadata schema");
		const noticeRoot = await capture();
		const noticeMetadataPath = path.join(noticeRoot, key, "metadata.json");
		const noticeMetadata = JSON.parse(await fs.readFile(noticeMetadataPath, "utf8"));
		noticeMetadata.output_revision = "0";
		await Bun.write(noticeMetadataPath, `${JSON.stringify(noticeMetadata, null, 2)}\n`);
		await rehash(noticeRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(noticeRoot)).rejects.toThrow("manual notice invariant");

		const capacityRoot = await capture();
		const capacityKey = "capacity-one/80x24/unicode-color";
		const capacityMetadataPath = path.join(capacityRoot, capacityKey, "metadata.json");
		const capacityMetadata = JSON.parse(await fs.readFile(capacityMetadataPath, "utf8"));
		capacityMetadata.state.transcript_capacity = 2;
		await Bun.write(capacityMetadataPath, `${JSON.stringify(capacityMetadata, null, 2)}\n`);
		await rehash(capacityRoot, capacityKey, "metadata.json");
		await expect(verifyStickyViewportShowcase(capacityRoot)).rejects.toThrow("capacity metadata/frame mismatch");

		const cjkRoot = await capture();
		const cjkKey = "narrow-cjk/48x10/unicode-color";
		for (const name of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
			const artifactPath = path.join(cjkRoot, cjkKey, name);
			await Bun.write(
				artifactPath,
				(await fs.readFile(artifactPath, "utf8")).replace("意味のある文の境界", "missing CJK proof"),
			);
			await rehash(cjkRoot, cjkKey, name);
		}
		await expect(verifyStickyViewportShowcase(cjkRoot)).rejects.toThrow(
			"narrow CJK visible terminal evidence missing",
		);

		const evidenceRoot = await capture();
		const evidencePath = path.join(evidenceRoot, key, "metadata.json");
		const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
		evidence.state.manual_historical_rows = [];
		await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
		await rehash(evidenceRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(evidenceRoot)).rejects.toThrow("manual historical transcript evidence");

		const nonNarrowCjkRoot = await capture();
		const nonNarrowMetadataPath = path.join(nonNarrowCjkRoot, key, "metadata.json");
		const nonNarrowMetadata = JSON.parse(await fs.readFile(nonNarrowMetadataPath, "utf8"));
		nonNarrowMetadata.cjk_phrase_boundaries = ["意味のある文の境界"];
		await Bun.write(nonNarrowMetadataPath, `${JSON.stringify(nonNarrowMetadata, null, 2)}\n`);
		await rehash(nonNarrowCjkRoot, key, "metadata.json");
		await expect(verifyStickyViewportShowcase(nonNarrowCjkRoot)).rejects.toThrow("non-narrow CJK boundaries");
	}, 15_000);
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
	}, 30_000);
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
	});
});

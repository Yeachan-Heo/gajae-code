import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { auditDocumentSourcePaths } from "./verify-doc-source-paths";

/**
 * Build a throwaway repo root with the given files so the audit resolves citations
 * against real paths rather than a mocked filesystem.
 */
async function withRepoRoot(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "doc-source-paths-"));
	try {
		for (const [relativePath, content] of Object.entries(files)) {
			const absolute = path.join(root, relativePath);
			await fs.mkdir(path.dirname(absolute), { recursive: true });
			await Bun.write(absolute, content);
		}
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function audit(root: string, file: string, content: string) {
	return auditDocumentSourcePaths(root, [{ file, content }], []);
}

describe("doc source-path verifier", () => {
	test("passes when a cited source path exists", async () => {
		await withRepoRoot({ "packages/alpha/src/present.ts": "export {};\n" }, async root => {
			const report = audit(root, "docs/guide.md", "See `packages/alpha/src/present.ts` for the entry point.\n");
			expect(report.citations).toHaveLength(1);
			expect(report.unresolved).toEqual([]);
		});
	});

	test("fails closed when a cited source path does not exist", async () => {
		await withRepoRoot({ "packages/alpha/src/present.ts": "export {};\n" }, async root => {
			const report = audit(root, "docs/guide.md", "See `packages/alpha/src/absent.ts` for the entry point.\n");
			expect(report.unresolved.map(citation => citation.target)).toEqual(["packages/alpha/src/absent.ts"]);
			expect(report.unresolved[0]!.file).toBe("docs/guide.md");
			expect(report.unresolved[0]!.line).toBe(1);
		});
	});

	test("reports the real line for a citation far into the document", async () => {
		await withRepoRoot({}, async root => {
			const content = ["# Title", "", "Intro.", "", "See `scripts/absent.ts`.", ""].join("\n");
			const report = audit(root, "docs/guide.md", content);
			expect(report.unresolved[0]!.line).toBe(5);
		});
	});

	test("ignores a pinned citation that describes another revision", async () => {
		await withRepoRoot({}, async root => {
			const report = audit(root, "docs/inventory.md", "| row | `crates/pi-natives/src/block.rs@a85bd5228d9f0f619deade1db78fa49420a721e1` |\n");
			expect(report.unresolved).toEqual([]);
		});
	});

	test("treats a sibling pin in the same table cell as governing the cell", async () => {
		await withRepoRoot({}, async root => {
			const content = "| B-TOKENS | `crates/pi-natives/src/tokens.rs`, `crates/pi-natives/src/utok/@a85bd5228d9f0f619deade1db78fa49420a721e1` |\n";
			const report = audit(root, "docs/inventory.md", content);
			expect(report.unresolved).toEqual([]);
		});
	});

	test("does not let a pin in one table cell excuse a citation in another cell", async () => {
		await withRepoRoot({}, async root => {
			// The upstream column carries the pin; the local-target column must still be
			// checked, which is exactly where real drift hides. `crates/pi-vcs` is a
			// directory claim, so the source-file citation below it is what proves the
			// cell boundary is respected.
			const content = "| A-PI-VCS | crate | `crates/pi-vcs@a85bd5228d9f0f619deade1db78fa49420a721e1` | `crates/pi-natives/src/vcs.rs` |\n";
			const report = audit(root, "docs/inventory.md", content);
			expect(report.unresolved.map(citation => citation.target)).toEqual(["crates/pi-natives/src/vcs.rs"]);
		});
	});

	test("ignores a citation asserted not to exist by positional attachment", async () => {
		await withRepoRoot({}, async root => {
			const forms: Array<[string, string]> = [
				["prefix", "> Note: there is no `crates/pi-natives/src/ghost.rs`; work lives elsewhere.\n"],
				["subject-of-deletion", "The file `crates/pi-natives/src/ghost.rs` was deleted in 2.7.\n"],
				["absence", "`crates/pi-natives/src/ghost.rs` is absent from this checkout.\n"],
				["never-shipped", "`crates/pi-natives/src/ghost.rs` never shipped.\n"],
			];
			for (const [label, content] of forms) {
				const report = audit(root, "docs/media.md", content);
				expect(report.unresolved, `${label} form must be exempt`).toEqual([]);
			}
		});
	});

	test("does not exempt a removed path whose claim lives only in an appositive", async () => {
		await withRepoRoot(
			{ "packages/coding-agent/src/sdk/bus/lifecycle-commands.ts": "export {};\n" },
			async root => {
				// A parenthetical's subject cannot be settled from text: the same shape can
				// describe the adjacent path or something else entirely. Such a doc is
				// covered by a reasoned allowlist entry, not by a heuristic, so the gate
				// must report it here rather than guess.
				const content =
					"- `packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts` (planned name, never created; landed as `packages/coding-agent/src/sdk/bus/lifecycle-commands.ts`)\n";
				const report = audit(root, "docs/handoff.md", content);
				expect(report.unresolved.map(citation => citation.target)).toEqual([
					"packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts",
				]);
			},
		);
	});

	test("does not exempt a citation via a marker on another line or in another span", async () => {
		await withRepoRoot({}, async root => {
			// The marker must attach to the citation itself: a marker on the previous line
			// or inside a different backtick span describes something else.
			const previousLine = audit(root, "docs/guide.md", "removed\n`packages/a/src/ghost.ts`\n");
			expect(previousLine.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
			const otherSpan = audit(root, "docs/guide.md", "Use `not` then `packages/a/src/ghost.ts`.\n");
			expect(otherSpan.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
		});
	});

	test("exempts an appositive claim only via a reasoned allowlist entry", async () => {
		await withRepoRoot({}, async root => {
			const content = "- `packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts` (planned name, never created)\n";
			const allowlist = [
				{
					file: "docs/handoff.md",
					path: "packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts",
					reason: "Pre-refactor handoff record; planned name that was never created.",
				},
			];
			const report = auditDocumentSourcePaths(
				root,
				[{ file: "docs/handoff.md", content }],
				allowlist,
			);
			expect(report.unresolved).toEqual([]);
		});
	});

	test("still flags a live citation whose path merely ends in a dotted extension", async () => {
		await withRepoRoot({}, async root => {
			// Guards the negation fix: a period inside the path must not truncate the
			// sentence, and an unnegated sentence must still fail closed.
			const report = audit(root, "docs/media.md", "See `crates/pi-natives/src/ghost.rs` for profiling.\n");
			expect(report.unresolved.map(citation => citation.target)).toEqual(["crates/pi-natives/src/ghost.rs"]);
		});
	});

	test("does not exempt a citation via a parenthesis that is not about it", async () => {
		await withRepoRoot({ "packages/a/src/live.ts": "export {};\n" }, async root => {
			// The parenthesis contains a marker word but discusses something else, so it
			// says nothing about the cited path and must not rescue a stale citation.
			const unrelated = audit(root, "docs/guide.md", "See `packages/a/src/ghost.ts` (the old guide is gone now).\n");
			expect(unrelated.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
			// A parenthesis carrying a provenance verb but about something else must not
			// exempt either — word lists alone cannot decide the subject.
			const beside = audit(root, "docs/guide.md", "Read `packages/a/src/ghost.ts` (the URL was renamed upstream).\n");
			expect(beside.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
			// A parenthesis that negates something else while naming a live path must not
			// exempt the citation: only a provenance idiom naming the replacement counts.
			const thirdOrder = audit(
				root,
				"docs/guide.md",
				"Read `packages/a/src/ghost.ts` (unrelated note; see `packages/a/src/live.ts` which was removed).\n",
			);
			expect(thirdOrder.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
			// A provenance idiom whose subject is something else must not exempt either:
			// the claim has to be bound to the cited path, not merely name a live one.
			const otherSubject = audit(
				root,
				"docs/guide.md",
				"Use `packages/a/src/ghost.ts` (the setting was renamed to `packages/a/src/live.ts`).\n",
			);
			expect(otherSubject.unresolved.map(citation => citation.target)).toEqual(["packages/a/src/ghost.ts"]);
		});
	});

	test("scopes an allowlist entry to its own document", async () => {
		await withRepoRoot({}, async root => {
			const allowlist = [
				{ file: "docs/inventory.md", path: "crates/pi-natives/src/tokens.rs", reason: "Upstream-only row." },
			];
			const exempt = auditDocumentSourcePaths(
				root,
				[{ file: "docs/inventory.md", content: "| `crates/pi-natives/src/tokens.rs` |\n" }],
				allowlist,
			);
			const otherDoc = auditDocumentSourcePaths(
				root,
				[{ file: "docs/other.md", content: "| `crates/pi-natives/src/tokens.rs` |\n" }],
				allowlist,
			);
			expect(exempt.unresolved).toEqual([]);
			// The same path in a different doc must still be reported.
			expect(otherDoc.unresolved.map(citation => citation.target)).toEqual(["crates/pi-natives/src/tokens.rs"]);
		});
	});

	test("does not treat prose or symbolic labels as citations", async () => {
		await withRepoRoot({}, async root => {
			const content = [
				"Use `src/foo.ts` relative to a package.",
				"An npm package: `@gajae-code/utils`.",
				"A glob: `packages/*/src/**`.",
				"A non-source label: `checkpoint.enabled`.",
			].join("\n");
			const report = audit(root, "docs/guide.md", content);
			expect(report.citations).toEqual([]);
		});
	});

	test("reports every stale citation in the real docs tree as resolved", async () => {
		// The gate is wired into check:ts, so this guards the whole tree stays clean.
		const repoRoot = path.join(import.meta.dir, "..");
		const docsRoot = path.join(repoRoot, "docs");
		const glob = new Bun.Glob("**/*.md");
		const documents: Array<{ file: string; content: string }> = [];
		for await (const relative of glob.scan(docsRoot)) {
			const absolute = path.join(docsRoot, relative);
			documents.push({
				file: path.relative(repoRoot, absolute),
				content: await Bun.file(absolute).text(),
			});
		}
		const report = auditDocumentSourcePaths(repoRoot, documents);
		expect(report.unresolved).toEqual([]);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type EditMode, EditTool } from "@gajae-code/coding-agent/edit";
import { computeLineHash } from "@gajae-code/coding-agent/hashline";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { WriteTool } from "@gajae-code/coding-agent/tools/write";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

let savedGjcVariant: string | undefined;
let savedPiVariant: string | undefined;

beforeEach(() => {
	savedGjcVariant = Bun.env.GJC_EDIT_VARIANT;
	savedPiVariant = Bun.env.PI_EDIT_VARIANT;
	delete Bun.env.GJC_EDIT_VARIANT;
	delete Bun.env.PI_EDIT_VARIANT;
});

afterEach(() => {
	if (savedGjcVariant === undefined) delete Bun.env.GJC_EDIT_VARIANT;
	else Bun.env.GJC_EDIT_VARIANT = savedGjcVariant;
	if (savedPiVariant === undefined) delete Bun.env.PI_EDIT_VARIANT;
	else Bun.env.PI_EDIT_VARIANT = savedPiVariant;
});

describe("edit matcher hooks", () => {
	// Ported from oh-my-pi crates/pi-edit/src/modes/patch.rs
	// `inspect_digest_strips_create_prefixes`: a create body digests to the same
	// text whether or not its lines carry `+` prefixes.
	test("inspect_digest_strips_create_prefixes (oh-my-pi parity)", () => {
		const tool = new EditTool(makeSession(), "patch");
		const inspect = (diff: string) => tool.matcherEntries({ path: "a.txt", edits: [{ op: "create", diff }] });
		expect(inspect("+one\n+two")).toEqual([{ path: "a.txt", digest: "one\ntwo" }]);
		expect(inspect("one\ntwo")).toEqual([{ path: "a.txt", digest: "one\ntwo" }]);
	});

	test("patch create with mixed prefixed and plain lines digests the content the writer persists", () => {
		const tool = new EditTool(makeSession(), "patch");
		// Not every line carries `+`, so the writer keeps the body verbatim.
		const diff = "+1;\nconsole.log('guarded');";
		expect(tool.matcherEntries({ path: "a.ts", edits: [{ op: "create", diff }] })).toEqual([
			{ path: "a.ts", digest: diff },
		]);
	});

	// Ported from oh-my-pi crates/pi-edit/src/modes/hashline/mod.rs
	// `inspect_extracts_paths_and_added_lines_from_partial_input`. Upstream input
	// `[*** Update File: src/a.ts#ABCD]\nPUT 1.=1:\n+new\n[src/b.ts]\nCUT 2.=2` is
	// omp's hashline grammar; this is the same payload in gajae's grammar: an
	// insertion into src/a.ts followed by a src/b.ts section whose deletion op is
	// still streaming. Expected entries are identical to upstream.
	test("inspect_extracts_paths_and_added_lines_from_partial_input (oh-my-pi parity)", () => {
		const tool = new EditTool(makeSession(), "hashline");
		const anchor = computeLineHash(1, "existing");
		for (const tail of ["≔2", "≔", ""]) {
			const input = `§src/a.ts\n»1${anchor}\nnew\n§src/b.ts\n${tail}`;
			expect(tool.matcherEntries({ input })).toEqual([{ path: "src/a.ts", digest: "new" }]);
		}
	});

	test("replace projects new_text from each edit, never old_text or the argument encoding", () => {
		const tool = new EditTool(makeSession(), "replace");
		const args = {
			path: "src/a.ts",
			edits: [
				{ old_text: "removed()", new_text: 'const value = "new";\nnext();' },
				{ old_text: "alsoRemoved()", new_text: "last();" },
			],
		};
		expect(tool.matcherEntries(args)).toEqual([
			{ path: "src/a.ts", digest: 'const value = "new";\nnext();\nlast();' },
		]);
		expect(tool.matcherDigest(args)).toBe('const value = "new";\nnext();\nlast();');
	});

	test("replace accepts a partial edit when its replacement is already available", () => {
		const tool = new EditTool(makeSession(), "replace");
		expect(tool.matcherEntries({ path: "a.ts", edits: [{ new_text: "introduced()" }] })).toEqual([
			{ path: "a.ts", digest: "introduced()" },
		]);
		expect(tool.matcherEntries({ path: "a.ts", edits: [{ old_text: "removed()" }] })).toBeUndefined();
		expect(tool.matcherDigest({ path: "a.ts", edits: [{ old_text: "removed()", new_text: "" }] })).toBeUndefined();
	});

	test("patch strips headers, context, and removed lines, and uses rename destinations", () => {
		const tool = new EditTool(makeSession(), "patch");
		const args = {
			path: "old.ts",
			edits: [
				{
					rename: "new.ts",
					diff: "--- old.ts\n+++ new.ts\n@@\n context()\n-removed()\n+added()\n+next()",
				},
			],
		};
		expect(tool.matcherEntries(args)).toEqual([{ path: "new.ts", digest: "added()\nnext()" }]);
		expect(tool.matcherDigest(args)).toBe("added()\nnext()");
	});

	test("patch combines edits on a file and supports raw or plus-prefixed create bodies", () => {
		const tool = new EditTool(makeSession(), "patch");
		expect(tool.matcherEntries({ path: "a.ts", edits: [{ diff: "@@\n+a()" }, { diff: "@@\n+b()" }] })).toEqual([
			{ path: "a.ts", digest: "a()\nb()" },
		]);
		for (const diff of ["one\ntwo", "+one\n+two"]) {
			expect(tool.matcherEntries({ path: "new.txt", edits: [{ op: "create", diff }] })).toEqual([
				{ path: "new.txt", digest: "one\ntwo" },
			]);
		}
	});

	test("patch deletion and context-only updates introduce nothing; blank additions remain empty", () => {
		const tool = new EditTool(makeSession(), "patch");
		for (const edits of [[{ op: "delete" }], [{ diff: "@@\n-old\n context" }], [{ rename: "moved.ts" }]]) {
			expect(tool.matcherEntries({ path: "a.ts", edits })).toBeUndefined();
			expect(tool.matcherDigest({ path: "a.ts", edits })).toBeUndefined();
		}
		expect(tool.matcherEntries({ path: "a.ts", edits: [{ diff: "@@\n+" }] })).toEqual([{ path: "a.ts", digest: "" }]);
		expect(tool.matcherDigest({ path: "a.ts", edits: [{ diff: "@@\n+" }] })).toBeUndefined();
	});

	test("hashline isolates multi-file sections, including repeated paths and replacement payloads", () => {
		const tool = new EditTool(makeSession(), "hashline");
		const args = {
			input: [
				"§src/a.ts",
				"»EOF",
				"const first = 1;",
				"§notes.md",
				"«BOF",
				"# Only Markdown",
				"§src/a.ts",
				"≔1aa..2bb",
				"const second = 2;",
			].join("\n"),
		};
		expect(tool.matcherEntries(args)).toEqual([
			{ path: "src/a.ts", digest: "const first = 1;\nconst second = 2;" },
			{ path: "notes.md", digest: "# Only Markdown" },
		]);
		expect(tool.matcherDigest(args)).toBe("const first = 1;\nconst second = 2;\n# Only Markdown");
	});

	test("hashline honors fallback paths, inline insertions, and anchor echoes", () => {
		const tool = new EditTool(makeSession(), "hashline");
		expect(tool.matcherEntries({ path: "fallback.ts", input: "»EOF|inline()" })).toEqual([
			{ path: "fallback.ts", digest: "inline()" },
		]);
		const oldText = "unchanged()";
		const hash = computeLineHash(1, oldText);
		expect(tool.matcherEntries({ input: `§a.ts\n»1${hash}|${oldText}\nintroduced()` })).toEqual([
			{ path: "a.ts", digest: "introduced()" },
		]);
		expect(tool.matcherEntries({ input: `§a.ts\n≔1${hash}|${oldText}` })).toBeUndefined();
	});

	test("apply_patch includes full Add File content, update additions, and move destination, never deletions", () => {
		const tool = new EditTool(makeSession(), "apply_patch");
		const args = {
			input: [
				"*** Begin Patch",
				"*** Add File: added.ts",
				"+const added = 1;",
				"++literalPlus();",
				"*** Update File: updated.ts",
				"@@",
				" context()",
				"-removed()",
				"+updated()",
				"*** Delete File: deleted.ts",
				"*** Update File: old.md",
				"*** Move to: moved.ts",
				"@@",
				"-old()",
				"+moved()",
				"*** End Patch",
			].join("\n"),
		};
		expect(tool.matcherEntries(args)).toEqual([
			{ path: "added.ts", digest: "const added = 1;\n+literalPlus();\n" },
			{ path: "updated.ts", digest: "updated()" },
			{ path: "moved.ts", digest: "moved()" },
		]);
		expect(tool.matcherDigest(args)).toBe("const added = 1;\n+literalPlus();\n\nupdated()\nmoved()");
	});

	test("apply_patch combines repeated file updates and projects an incomplete envelope", () => {
		const tool = new EditTool(makeSession(), "apply_patch");
		const input =
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+first()\n*** Update File: a.ts\n@@\n-old\n+second()\n*** End Patch";
		expect(tool.matcherEntries({ input })).toEqual([{ path: "a.ts", digest: "first()\nsecond()" }]);
		expect(tool.matcherEntries({ input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+partial()\n" })).toEqual([
			{ path: "a.ts", digest: "partial()" },
		]);
	});

	test("apply_patch delete-only and move-only envelopes have no digest", () => {
		const tool = new EditTool(makeSession(), "apply_patch");
		for (const body of ["*** Delete File: a.ts", "*** Update File: a.ts\n*** Move to: b.ts"]) {
			const args = { input: `*** Begin Patch\n${body}\n*** End Patch` };
			expect(tool.matcherEntries(args)).toBeUndefined();
			expect(tool.matcherDigest(args)).toBeUndefined();
		}
	});

	test("vim keystrokes and inserted text have no static matcher projection", () => {
		const tool = new EditTool(makeSession(), "vim");
		const args = { path: "a.ts", steps: [{ kbd: ["i"], insert: "introduced()" }] };
		expect(tool.matcherEntries(args)).toBeUndefined();
		expect(tool.matcherDigest(args)).toBeUndefined();
	});

	test("projection follows the current mode instead of guessing from argument fields", () => {
		let model = "anthropic/claude-sonnet-4-6";
		const session = makeSession();
		session.getActiveModelString = () => model;
		const tool = new EditTool(session);
		const replaceArgs = { path: "a.ts", edits: [{ new_text: "replace()" }] };
		expect(tool.matcherDigest(replaceArgs)).toBe("replace()");
		model = "openai/gpt-5.4";
		expect(tool.matcherDigest(replaceArgs)).toBeUndefined();
		expect(tool.matcherDigest({ input: "*** Begin Patch\n*** Add File: a.ts\n+create()\n*** End Patch" })).toBe(
			"create()\n",
		);
	});

	for (const mode of ["replace", "patch", "hashline", "apply_patch", "vim"] satisfies EditMode[]) {
		test(`${mode} returns undefined for missing, malformed, and unusable partial arguments`, () => {
			const tool = new EditTool(makeSession(), mode);
			for (const args of [
				null,
				undefined,
				"not an object",
				[],
				{},
				{ path: 1, edits: [] },
				{ path: "a.ts", edits: null },
				{ path: "a.ts", edits: [null] },
				{ path: "a.ts", edits: [{ new_text: 42, diff: 42 }] },
				{ input: 42 },
				{ input: "not a patch" },
				{ input: "§a.ts\n»" },
			]) {
				expect(tool.matcherEntries(args)).toBeUndefined();
				expect(tool.matcherDigest(args)).toBeUndefined();
			}
		});
	}
});

describe("write matcher hook", () => {
	test("returns the full unescaped content without requiring a path", () => {
		const tool = new WriteTool(makeSession());
		expect(tool.matcherDigest({ content: 'const text = "quoted";\nnext();' })).toBe(
			'const text = "quoted";\nnext();',
		);
		expect(tool.matcherDigest({ content: "" })).toBe("");
	});

	test("missing and malformed content produce no digest", () => {
		const tool = new WriteTool(makeSession());
		for (const args of [null, undefined, [], "content", {}, { path: "a.ts" }, { content: 42 }]) {
			expect(tool.matcherDigest(args)).toBeUndefined();
		}
	});
});

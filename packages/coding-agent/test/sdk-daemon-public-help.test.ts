import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	getPublicHelpRevision,
	type PublicHelpDocument,
	PublicHelpError,
	type PublicHelpErrorCode,
	type PublicHelpFragment,
	renderPublicCommandHelp,
} from "../src/cli/public-command-help";
import {
	PUBLIC_COMMANDS,
	PUBLIC_HELP_SECTIONS,
	type PublicCommandDescriptor,
} from "../src/cli/public-command-registry";

function traverse(command: readonly string[], json: boolean, registry = PUBLIC_COMMANDS): PublicHelpDocument[] {
	const documents: PublicHelpDocument[] = [];
	let options: { json: boolean; section?: string; page?: number; revision?: string } = { json };
	for (let guard = 0; guard < 10000; guard++) {
		const result = renderPublicCommandHelp(command, options, registry);
		expect(result.bytes).toBe(Buffer.byteLength(result.output));
		expect(result.bytes).toBeLessThanOrEqual(8192);
		expect(result.output.endsWith("\n")).toBe(true);
		if (json) expect(JSON.parse(result.output)).toEqual(result.document);
		documents.push(result.document);
		const next = result.document.next;
		if (!next) return documents;
		expect(next.argv).toEqual([
			...command,
			"--help",
			"--help-revision",
			result.document.revision,
			"--help-section",
			next.section,
			"--help-page",
			String(next.page),
			...(json ? ["--json"] : []),
		]);
		options = { json, section: next.section, page: next.page, revision: result.document.revision };
	}
	throw new Error("Traversal failed to terminate");
}
function fixture(description: string): PublicCommandDescriptor[] {
	return [{ ...PUBLIC_COMMANDS[0]!, command: ["sdk"], canonicalCommand: ["sdk"], children: [], description }];
}
function failure(action: () => unknown, code: PublicHelpErrorCode) {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(PublicHelpError);
		expect((error as PublicHelpError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("bounded static public help", () => {
	test("all 27 paths traverse every section once in both modes with pinned continuations", () => {
		expect(PUBLIC_COMMANDS).toHaveLength(27);
		for (const descriptor of PUBLIC_COMMANDS) {
			const json = traverse(descriptor.command, true);
			const text = traverse(descriptor.command, false);
			for (const documents of [json, text]) {
				expect(documents.filter(page => page.sectionComplete).map(page => page.section)).toEqual([
					...PUBLIC_HELP_SECTIONS,
				]);
				expect(documents.filter(page => page.documentComplete)).toHaveLength(1);
				expect(documents.at(-1)?.next).toBeNull();
				const entries = documents.flatMap(page => page.entries);
				expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
				expect(entries.filter(entry => entry.kind === "option")).toHaveLength(Object.keys(descriptor.flags).length);
				expect(entries.filter(entry => entry.kind === "argument")).toHaveLength(
					Object.keys(descriptor.args).length,
				);
				expect(entries.filter(entry => entry.kind === "child")).toHaveLength(descriptor.children.length);
			}
			// Mode changes formatting, never local entry identity or semantic content.
			expect(json.flatMap(page => page.entries)).toEqual(text.flatMap(page => page.entries));
		}
	});

	test("empty sections are valid only on page one and advance to the next section", () => {
		const result = renderPublicCommandHelp(["sdk", "guides", "trust"], { section: "arguments", json: true });
		expect(result.document).toMatchObject({
			entries: [],
			sectionComplete: true,
			documentComplete: false,
			next: { section: "options", page: 1 },
		});
		failure(
			() => renderPublicCommandHelp(["sdk", "guides", "trust"], { section: "arguments", page: 2 }),
			"invalid_page",
		);
	});

	test("rejects malformed selectors and mismatched revisions without echoing input", () => {
		for (const page of [
			0,
			-1,
			1.5,
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			"",
			"1e2",
			"+1",
			" 1",
			"1.0",
			"secret",
		])
			failure(() => renderPublicCommandHelp(["sdk"], { page }), "invalid_page");
		failure(() => renderPublicCommandHelp(["sdk"], { section: "secret" }), "invalid_section");
		failure(() => renderPublicCommandHelp(["sdk"], { revision: "A".repeat(64) }), "invalid_revision");
		failure(() => renderPublicCommandHelp(["sdk"], { revision: "0".repeat(64) }), "revision_mismatch");
		failure(() => renderPublicCommandHelp(["sdk", "unknown"]), "unknown_command");
		expect(renderPublicCommandHelp(["sdk"], { page: "0001" }).document.page).toBe(1);
	});

	test("revision is deterministic, key-order independent and sensitive to child metadata", () => {
		const registry = fixture("Original");
		const reordered = [
			Object.fromEntries(Object.entries(registry[0]!).reverse()) as unknown as PublicCommandDescriptor,
		];
		expect(getPublicHelpRevision(registry)).toBe(getPublicHelpRevision(reordered));
		const reorderedOptions = [
			{ ...registry[0]!, flags: Object.fromEntries(Object.entries(registry[0]!.flags).reverse()) },
		];
		expect(getPublicHelpRevision(registry)).not.toBe(getPublicHelpRevision(reorderedOptions));
		const revision = getPublicHelpRevision(registry);
		registry[0] = { ...registry[0]!, description: "Changed" };
		expect(getPublicHelpRevision(registry)).not.toBe(revision);
		failure(() => renderPublicCommandHelp(["sdk"], { revision }, registry), "revision_mismatch");
		expect(renderPublicCommandHelp(["sdk", "session", "send"], { json: true })).toEqual(
			renderPublicCommandHelp(["sdk", "session", "send"], { json: true }),
		);
	});

	test("alias command identity and concrete child help argv remain distinct", () => {
		const alias = renderPublicCommandHelp(["daemon", "reload"], { json: true }).document;
		expect(alias.command).toEqual(["daemon", "reload"]);
		expect(alias.canonicalCommand).toEqual(["daemon", "restart"]);
		expect(alias.next?.argv.slice(0, 2)).toEqual(["daemon", "reload"]);
		const children = traverse(["sdk", "session", "raw"], true)
			.flatMap(page => page.entries)
			.filter(entry => entry.kind === "child");
		expect(children.map(entry => ("value" in entry ? entry.value : null))).toEqual(
			["control", "query", "global"].map(kind => ({
				command: ["sdk", "session", "raw", kind],
				canonicalCommand: ["sdk", "session", "raw", kind],
				description: PUBLIC_COMMANDS.find(row => row.command.join(" ") === `sdk session raw ${kind}`)!.description,
				help: { executable: "gjc", argv: ["sdk", "session", "raw", kind, "--help"] },
			})),
		);
	});

	test("text explicitly escapes terminal controls while JSON preserves exact Unicode data", () => {
		const description = '한글 😀 é "quote" \\ slash\n\r\t\u001b[31m\u0000\u007f\u0085\u2028\u2029\ud800';
		const registry = fixture(description);
		const text = renderPublicCommandHelp(["sdk"], {}, registry).output;
		expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
		expect(text).toContain("\\u001b");
		expect(text).toContain("\\u0085");
		expect(text).toContain("do not paste escaped strings as shell argv");
		const json = JSON.parse(renderPublicCommandHelp(["sdk"], { json: true }, registry).output);
		expect(json.entries[0].value.description).toBe(description);
	});

	test("oversized values reconstruct canonical bytes with contiguous offsets and digest, never partial executable fields", () => {
		const description = '한글😀é"\\\n\ud800'.repeat(2200);
		const registry = fixture(description);
		for (const json of [false, true]) {
			const pages = traverse(["sdk"], json, registry).filter(page => page.section === "overview");
			const fragments = pages.flatMap(page => page.entries) as PublicHelpFragment[];
			expect(fragments.length).toBeGreaterThan(2);
			let offset = 0;
			const chunks: Buffer[] = [];
			for (const fragment of fragments) {
				expect(fragment.kind).toBe("fragment");
				expect(fragment.complete).toBe(false);
				expect(fragment.offsetBytes).toBe(offset);
				expect(Object.keys(fragment).sort()).toEqual(
					["id", "kind", "complete", "encoding", "offsetBytes", "totalBytes", "sha256", "data"].sort(),
				);
				const chunk = Buffer.from(fragment.data, "base64");
				offset += chunk.length;
				chunks.push(chunk);
			}
			const bytes = Buffer.concat(chunks);
			expect(bytes.length).toBe(fragments[0]!.totalBytes);
			expect(new Set(fragments.map(fragment => fragment.sha256)).size).toBe(1);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(fragments[0]!.sha256);
			expect(JSON.parse(bytes.toString("utf8")).description).toBe(description);
		}
	});

	test("8191/8192/8193-byte static values fragment safely including escaping overhead", () => {
		for (const size of [8191, 8192, 8193]) {
			for (const character of ["a", '"', "한"]) {
				const registry = fixture(character.repeat(size));
				for (const json of [true, false]) {
					const result = renderPublicCommandHelp(["sdk"], { json }, registry);
					expect(result.bytes).toBeLessThanOrEqual(8192);
					expect(result.document.entries[0]?.kind).toBe("fragment");
				}
			}
		}
	});

	test("oversized locator metadata fails rather than truncating commands or fabricating continuation", () => {
		const registry = fixture("Description");
		const command = ["sdk", "a".repeat(9000)];
		registry[0] = { ...registry[0]!, command, canonicalCommand: command };
		for (const json of [true, false])
			failure(() => renderPublicCommandHelp(command, { json }, registry), "static_metadata_too_large");
	});
});

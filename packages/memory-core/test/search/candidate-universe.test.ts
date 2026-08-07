import { describe, expect, it } from "bun:test";

import {
	buildCandidateUniverse,
	type CandidateDirectoryEntry,
	type CandidateScopeDescriptor,
} from "../../src/search/candidate-universe";

type Tree = Readonly<Record<string, readonly (CandidateDirectoryEntry | string)[]>>;

function scope(kind: string): CandidateScopeDescriptor {
	return { kind, root: `/admitted/${kind}`, uriPrefix: `${kind}://` };
}

function listFrom(tree: Tree, calls: string[]) {
	return (currentScope: CandidateScopeDescriptor, relPath: string) => {
		const key = `${currentScope.kind}:${relPath}`;
		calls.push(key);
		return tree[key] ?? [];
	};
}

describe("M2 candidate universe", () => {
	it("places map-route, metadata, and heading reservations before the body-only walk", async () => {
		const calls: string[] = [];
		const tree: Tree = {
			"global:": [
				{ name: "z-body.md", kind: "file" },
				{ name: "body", kind: "directory" },
				{ name: "a.md", kind: "file" },
				{ name: "b.md", kind: "file" },
				{ name: "c.md", kind: "file" },
			],
			"global:body": [
				{ name: "deep.md", kind: "file" },
				{ name: "ignored.txt", kind: "file" },
			],
			"project:": [{ name: "project-body.md", kind: "file" }],
		};
		const result = await buildCandidateUniverse({
			scopes: [scope("project"), scope("global")],
			list: listFrom(tree, calls),
			reservations: [
				{ scope: "global", relPath: "c.md", stage: "heading" },
				{ scope: "project", relPath: "project-body.md", stage: "heading" },
				{ scope: "global", relPath: "b.md", stage: "metadata" },
				{ scope: "global", relPath: "a.md", stage: "map-route", uri: "route://a.md" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.candidates).toEqual([
			{ scope: "global", relPath: "a.md", uri: "route://a.md" },
			{ scope: "global", relPath: "b.md", uri: "global://b.md" },
			{ scope: "global", relPath: "c.md", uri: "global://c.md" },
			{ scope: "project", relPath: "project-body.md", uri: "project://project-body.md" },
			{ scope: "global", relPath: "body/deep.md", uri: "global://body/deep.md" },
			{ scope: "global", relPath: "z-body.md", uri: "global://z-body.md" },
		]);
		expect(calls).toEqual(["global:", "global:body", "project:"]);
		expect(result.value.budget.usage.files).toBe(6);
		expect(result.value.truncated).toBe(false);
	});

	it("excludes archives, proposals, journals, locks, JSONL, non-Markdown, transcripts, and unverified paths", async () => {
		const calls: string[] = [];
		const tree: Tree = {
			"global:": [
				{ name: "archive", kind: "directory" },
				{ name: "proposals", kind: "directory" },
				{ name: ".journal", kind: "directory" },
				{ name: ".locks", kind: "directory" },
				{ name: "transcripts", kind: "directory" },
				{ name: "unverified", kind: "directory" },
				{ name: "notes.jsonl", kind: "file" },
				{ name: "README.txt", kind: "file" },
				{ name: "meeting-transcript.md", kind: "file" },
				{ name: "secret.unverified.md", kind: "file" },
				{ name: "unverified.md", kind: "file" },
				{ name: "keep.md", kind: "file" },
				{ name: "allowed", kind: "directory" },
			],
			"global:allowed": [
				{ name: "keep.md", kind: "file" },
				{ name: "nested.transcript.md", kind: "file" },
				{ name: "nested.jsonl", kind: "file" },
			],
		};
		const result = await buildCandidateUniverse({ scopes: [scope("global")], list: listFrom(tree, calls) });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.candidates).toEqual([
			{ scope: "global", relPath: "allowed/keep.md", uri: "global://allowed/keep.md" },
			{ scope: "global", relPath: "keep.md", uri: "global://keep.md" },
		]);
		expect(calls).toEqual(["global:", "global:allowed"]);
		expect(result.value.budget.usage.files).toBe(2);
	});

	it("canonicalizes NFC-colliding names once and orders canonical paths by UTF-8 bytes", async () => {
		const entries: readonly CandidateDirectoryEntry[] = [
			{ name: "z.md", kind: "file" },
			{ name: "e\u0301.md", kind: "file" },
			{ name: "é.md", kind: "file" },
			{ name: "b.md", kind: "file" },
			{ name: "B.md", kind: "file" },
			{ name: "a.md", kind: "file" },
			{ name: "A.md", kind: "file" },
		];
		const result = await buildCandidateUniverse({
			scopes: [scope("global")],
			list: () => entries,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.candidates).toEqual([
			{ scope: "global", relPath: "A.md", uri: "global://A.md" },
			{ scope: "global", relPath: "B.md", uri: "global://B.md" },
			{ scope: "global", relPath: "a.md", uri: "global://a.md" },
			{ scope: "global", relPath: "b.md", uri: "global://b.md" },
			{ scope: "global", relPath: "z.md", uri: "global://z.md" },
			{ scope: "global", relPath: "é.md", uri: "global://é.md" },
		]);
		expect(result.value.candidates.filter(candidate => candidate.relPath === "é.md")).toHaveLength(1);
	});

	it("rejects unsafe directory entries instead of constructing an escaped candidate", async () => {
		const result = await buildCandidateUniverse({
			scopes: [scope("global")],
			list: () => [{ name: "../outside.md", kind: "file" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("invalid-input");
			if (result.error.code === "invalid-input") expect(result.error.detail).toContain("unsafe directory entry");
		}
	});
});

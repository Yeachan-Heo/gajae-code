import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseMemoryDocument } from "../../src/documents/document-parser";
import type { MemoryEnvironment } from "../../src/env";
import { parseMemoryMap } from "../../src/maps/map-parser";
import { rebuildMemoryMap } from "../../src/maps/map-rebuilder";
import { authorizeAccess } from "../../src/policy/access-policy";
import { atomicWrite } from "../../src/storage/atomic-write";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import { applyMemory } from "../../src/writes/apply";
import { forgetMemory } from "../../src/writes/forget";
import { proposeMemory, readStagedProposal } from "../../src/writes/proposal";
import { buildSupersessionMutations, type SupersessionCandidate } from "../../src/writes/supersession";

const AS_OF = "2026-07-29T12:00:00.000Z";
const roots: string[] = [];

function environment(memoryRoot: string): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId: null,
		now: new Date(AS_OF),
		deterministic: true,
		asOf: AS_OF,
	};
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-write-lifecycle-"));
	const root = path.join(parent, "memory");
	roots.push(parent);
	await createMemoryRootScaffold(root);
	return root;
}

function documentCandidate(
	uri: string,
	relPath: string,
	id: string,
	supersedes: readonly string[] = [],
): SupersessionCandidate {
	const content = [
		"---",
		'schemaVersion: "gajae.memory.document.v1"',
		`id: "${id}"`,
		'type: "decision"',
		'scope: "global"',
		'authority: "project-config"',
		'volatility: "stable"',
		'sensitivity: "public-safe"',
		'status: "active"',
		`created: "${AS_OF}"`,
		`updated: "${AS_OF}"`,
		"aliases: []",
		`supersedes: [${supersedes.map(value => `"${value}"`).join(", ")}]`,
		"---",
		`# ${id}`,
		"Use the documented decision.",
	].join("\n");
	const parsed = parseMemoryDocument({ content, relPath, uri });
	if (!parsed.ok) throw new Error(parsed.error.code);
	return {
		uri,
		relPath,
		content,
		digest: parsed.value.digest,
		metadata: parsed.value.metadata,
	};
}

async function writeCanonical(root: string, relPath: string, content: string): Promise<void> {
	const grant = authorizeAccess({
		environment: environment(root),
		destination: "global-canonical",
		sensitivity: "public-safe",
		relPath,
		content,
	});
	if (!grant.ok) throw new Error(grant.error.code);
	await atomicWrite({ grant: grant.value, relPath, content });
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("M6 write lifecycle", () => {
	it("stages a deterministic proposal with a CAS digest and real diff", async () => {
		const root = await makeRoot();
		const first = await proposeMemory(environment(root), {
			type: "decision",
			content: "Use the append-only transaction.",
			targetUri: "global://constraints/transaction.md",
		});
		const second = await proposeMemory(environment(root), {
			type: "decision",
			content: "Use the append-only transaction.",
			targetUri: "global://constraints/transaction.md",
		});
		expect(first).toEqual(second);
		if (!first.ok) return;
		expect(first.value.expectedDigest).toBeNull();
		expect(first.value.diff).toContain("+Use the append-only transaction.");
		expect(readStagedProposal(environment(root), first.value.proposalId).ok).toBe(true);
	});

	it("refuses a secret-bearing proposal before staging", async () => {
		const root = await makeRoot();
		const result = await proposeMemory(environment(root), {
			type: "note",
			content: "password-super-secret-token-123456",
			targetUri: "global://notes/secret.md",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("sensitivity-violation");
	});

	it("rebuilds only approved MAP regions and preserves human bytes", () => {
		const startProjects = "<!-- AUTO:PROJECTS START -->";
		const endProjects = "<!-- AUTO:PROJECTS END -->";
		const startHealth = "<!-- AUTO:INDEX-HEALTH START -->";
		const endHealth = "<!-- AUTO:INDEX-HEALTH END -->";
		const before = `${[
			"# Human heading \t",
			"Cafe\u0301 human text  \t",
			"",
			startProjects,
			"old generated content",
			endProjects,
			"human separator  \t",
			startHealth,
			"old health",
			endHealth,
			"Human footer.  \t",
		].join("\r\n")}\r\n`;
		const result = rebuildMemoryMap(before, [{ uri: "global://notes/new.md", label: "New note" }]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const inputProjectStart = before.indexOf(startProjects);
		const inputProjectInteriorStart = before.indexOf("\r\n", inputProjectStart) + 2;
		const inputProjectEnd = before.indexOf(endProjects);
		const inputHealthStart = before.indexOf(startHealth);
		const inputHealthInteriorStart = before.indexOf("\r\n", inputHealthStart) + 2;
		const inputHealthEnd = before.indexOf(endHealth);
		const outputProjectStart = result.value.indexOf(startProjects);
		const outputProjectInteriorStart = result.value.indexOf("\r\n", outputProjectStart) + 2;
		const outputProjectEnd = result.value.indexOf(endProjects);
		const outputHealthStart = result.value.indexOf(startHealth);
		const outputHealthInteriorStart = result.value.indexOf("\r\n", outputHealthStart) + 2;
		const outputHealthEnd = result.value.indexOf(endHealth);
		expect(Buffer.from(result.value.slice(0, outputProjectInteriorStart), "utf8")).toEqual(
			Buffer.from(before.slice(0, inputProjectInteriorStart), "utf8"),
		);
		expect(Buffer.from(result.value.slice(outputProjectInteriorStart, outputProjectEnd), "utf8")).toEqual(
			Buffer.from("[New note](memory://global/notes/new.md)\n", "utf8"),
		);
		expect(Buffer.from(result.value.slice(outputProjectEnd, outputHealthInteriorStart), "utf8")).toEqual(
			Buffer.from(before.slice(inputProjectEnd, inputHealthInteriorStart), "utf8"),
		);
		expect(Buffer.from(result.value.slice(outputHealthInteriorStart, outputHealthEnd), "utf8")).toEqual(
			Buffer.from("- Active routes: 1\n", "utf8"),
		);
		expect(Buffer.from(result.value.slice(outputHealthEnd), "utf8")).toEqual(
			Buffer.from(before.slice(inputHealthEnd), "utf8"),
		);
	});

	it("preserves human MAP bytes through a real propose and apply round trip", async () => {
		const root = await makeRoot();
		// CRLF plus decomposed Unicode outside the AUTO markers must survive the
		// whole lifecycle: staging serialization previously NFC-normalized the
		// embedded MAP and apply re-normalized it again.
		const humanPrefix = "# Human heading\r\nCafe\u0301 text with trailing  \r\n";
		const mapPath = path.join(root, "MEMORY.md");
		const scaffold = await fs.readFile(mapPath, "utf8");
		await fs.writeFile(mapPath, `${humanPrefix}${scaffold}`, { mode: 0o600 });

		const proposal = await proposeMemory(environment(root), {
			type: "convention",
			content: "Run bun test for integration.",
			targetUri: "global://conventions/testing.md",
		});
		expect(proposal.ok).toBe(true);
		if (!proposal.ok) return;
		const applied = await applyMemory(environment(root), { proposalId: proposal.value.proposalId });
		expect(applied.ok).toBe(true);

		const rebuilt = await fs.readFile(mapPath, "utf8");
		expect(Buffer.from(rebuilt.slice(0, humanPrefix.length), "utf8")).toEqual(Buffer.from(humanPrefix, "utf8"));
		expect(rebuilt).toContain("conventions/testing.md");
	});

	it("applies the document, supersession, receipt, and MAP as one mutation set", async () => {
		const root = await makeRoot();
		const old = documentCandidate("global://constraints/old.md", "global/constraints/old.md", "old");
		await writeCanonical(root, old.relPath, old.content);
		const proposal = await proposeMemory(environment(root), {
			type: "decision",
			content: "Use the new transaction decision.",
			targetUri: "global://constraints/new.md",
			supersedes: ["old"],
		});
		expect(proposal.ok).toBe(true);
		if (!proposal.ok) return;
		const applied = await applyMemory(environment(root), { proposalId: proposal.value.proposalId });
		expect(applied.ok).toBe(true);
		expect(await fs.readFile(path.join(root, "global/constraints/new.md"), "utf8")).toContain("new transaction");
		expect(await fs.readFile(path.join(root, old.relPath), "utf8")).toContain('status: "superseded"');
		expect(await fs.readFile(path.join(root, "MEMORY.md"), "utf8")).toContain("memory://global/constraints/new.md");
		expect(
			await fs.lstat(path.join(root, `global/proposals-${proposal.value.proposalId}.receipt.json`)),
		).toBeDefined();
	});

	it("forgets by tombstoning and rejects a stale CAS without writes", async () => {
		const root = await makeRoot();
		const note = documentCandidate("global://constraints/forget.md", "global/constraints/forget.md", "forget");
		await writeCanonical(root, note.relPath, note.content);
		const parsed = parseMemoryDocument({ content: note.content, relPath: note.relPath, uri: note.uri });
		if (!parsed.ok) throw new Error(parsed.error.code);
		const stale = await forgetMemory(environment(root), { uri: note.uri, expectedDigest: "0".repeat(64) });
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.exitCode).toBe(12);
		expect(await fs.readFile(path.join(root, note.relPath), "utf8")).toBe(note.content);
		const forgotten = await forgetMemory(environment(root), {
			uri: note.uri,
			expectedDigest: parsed.value.digest,
			reason: "no longer current",
		});
		expect(forgotten.ok).toBe(true);
		expect(await fs.readFile(path.join(root, note.relPath), "utf8")).toContain("gajae: tombstone no longer current");
		// A tombstone must remain a parseable memory document: emitting an explicit
		// `verification: null` left the store permanently malformed and doctor-unhealthy.
		const tombstoned = await fs.readFile(path.join(root, note.relPath), "utf8");
		expect(tombstoned).not.toContain("verification: null");
		const reparsed = parseMemoryDocument({ content: tombstoned, relPath: note.relPath, uri: note.uri });
		expect(reparsed.ok).toBe(true);
		if (reparsed.ok) expect(reparsed.value.metadata.status).toBe("superseded");
	});

	it("removes every fragment and plain route for a forgotten document", async () => {
		const root = await makeRoot();
		const note = documentCandidate("global://constraints/forget.md", "global/constraints/forget.md", "forget-routes");
		await writeCanonical(root, note.relPath, note.content);
		const mapContent = [
			"# Memory Map",
			"",
			"<!-- AUTO:PROJECTS START -->",
			"[Heading](memory://global/constraints/forget.md#Heading)",
			"[Details](memory://global/constraints/forget.md#Details)",
			"[Whole document](memory://global/constraints/forget.md)",
			"[Keep](memory://global/constraints/keep.md)",
			"<!-- AUTO:PROJECTS END -->",
			"",
			"<!-- AUTO:INDEX-HEALTH START -->",
			"<!-- AUTO:INDEX-HEALTH END -->",
			"",
		].join("\n");
		await writeCanonical(root, "MEMORY.md", mapContent);
		const parsed = parseMemoryDocument({ content: note.content, relPath: note.relPath, uri: note.uri });
		if (!parsed.ok) throw new Error(parsed.error.code);
		const forgotten = await forgetMemory(environment(root), {
			uri: `${note.uri}#Details`,
			expectedDigest: parsed.value.digest,
		});
		expect(forgotten.ok).toBe(true);
		const rebuiltMap = parseMemoryMap(await fs.readFile(path.join(root, "MEMORY.md"), "utf8"), "MEMORY.md");
		expect(rebuiltMap.ok).toBe(true);
		if (rebuiltMap.ok)
			expect(rebuiltMap.value.routes.map(route => route.uri)).toEqual(["memory://global/constraints/keep.md"]);
	});

	it("fails closed for a supersession cycle", () => {
		const first = documentCandidate("global://decisions/a.md", "global/decisions/a.md", "a", ["b"]);
		const second = documentCandidate("global://decisions/b.md", "global/decisions/b.md", "b", ["a"]);
		const next = documentCandidate("global://decisions/c.md", "global/decisions/c.md", "c");
		const parsedNext = parseMemoryDocument({ content: next.content, relPath: next.relPath, uri: next.uri });
		if (!parsedNext.ok) throw new Error(parsedNext.error.code);
		const result = buildSupersessionMutations({
			newUri: next.uri,
			newDocument: parsedNext.value,
			supersedes: ["a"],
			candidates: [first, second],
		});
		expect(result.ok).toBe(false);
	});
});

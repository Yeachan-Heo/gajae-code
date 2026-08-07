import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseMemoryDocument } from "../../src/documents/document-parser";
import type { MemoryEnvironment } from "../../src/env";
import type { Sensitivity } from "../../src/index";
import { authorizeAccess } from "../../src/policy/access-policy";
import { atomicWrite } from "../../src/storage/atomic-write";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import { applyMemory } from "../../src/writes/apply";
import { forgetMemory } from "../../src/writes/forget";
import { proposeMemory, readStagedProposal } from "../../src/writes/proposal";

const AS_OF = "2026-07-29T12:00:00.000Z";
const PRIVATE_BODY = "PRIVATE_CANONICAL_BODY_MUST_NOT_ESCAPE";
const RESTRICTED_BODY = "RESTRICTED_CANONICAL_BODY_MUST_NOT_ESCAPE";
const PRIVATE_ALIAS = "PRIVATE_ALIAS_MUST_NOT_ESCAPE";
const PRIVATE_SUPERSEDES = "PRIVATE_SUPERSEDES_MUST_NOT_ESCAPE";
const PRIVATE_VERIFICATION_PROVIDER = "PRIVATE_PROVIDER_MUST_NOT_ESCAPE";
const PRIVATE_VERIFICATION_RESOURCE = "PRIVATE_RESOURCE_MUST_NOT_ESCAPE";
const PRIVATE_VERIFICATION_ID = "PRIVATE_VERIFICATION_ID_MUST_NOT_ESCAPE";
const SENSITIVE_SENTINELS = [
	PRIVATE_BODY,
	RESTRICTED_BODY,
	PRIVATE_ALIAS,
	PRIVATE_SUPERSEDES,
	PRIVATE_VERIFICATION_PROVIDER,
	PRIVATE_VERIFICATION_RESOURCE,
	PRIVATE_VERIFICATION_ID,
] as const;
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
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-private-lifecycle-"));
	const root = path.join(parent, "memory");
	roots.push(parent);
	await createMemoryRootScaffold(root);
	return root;
}

function documentContent(id: string, sensitivity: Sensitivity, body: string): string {
	return [
		"---",
		'schemaVersion: "gajae.memory.document.v1"',
		`id: "${id}"`,
		'type: "note"',
		'scope: "global"',
		'authority: "project-config"',
		'volatility: "stable"',
		`sensitivity: "${sensitivity}"`,
		'status: "active"',
		`created: "${AS_OF}"`,
		`updated: "${AS_OF}"`,
		`aliases: ["${PRIVATE_ALIAS}"]`,
		`supersedes: ["${PRIVATE_SUPERSEDES}"]`,
		"verification:",
		`  provider: "${PRIVATE_VERIFICATION_PROVIDER}"`,
		`  resource: "${PRIVATE_VERIFICATION_RESOURCE}"`,
		`  id: "${PRIVATE_VERIFICATION_ID}"`,
		"---",
		`# ${id}`,
		body,
	].join("\n");
}

async function writeCanonical(root: string, relPath: string, content: string, sensitivity: Sensitivity): Promise<void> {
	const grant = authorizeAccess({
		environment: environment(root),
		destination: "global-canonical",
		sensitivity,
		relPath,
		content,
	});
	if (!grant.ok) throw new Error(grant.error.code);
	await atomicWrite({ grant: grant.value, relPath, content });
}

async function globalJsonBytes(root: string): Promise<string> {
	const names = await fs.readdir(path.join(root, "global"));
	const json = names.filter(name => name.endsWith(".json"));
	const contents = await Promise.all(json.map(async name => fs.readFile(path.join(root, "global", name), "utf8")));
	return contents.join("\n");
}
function expectNoSensitiveProjection(value: string): void {
	for (const sentinel of SENSITIVE_SENTINELS) expect(value).not.toContain(sentinel);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("private and restricted lifecycle disclosure", () => {
	it("proposes successfully with sensitive canonical documents without serializing their bodies", async () => {
		const root = await makeRoot();
		await writeCanonical(
			root,
			"global/private.md",
			documentContent("private-doc", "private", PRIVATE_BODY),
			"private",
		);
		await writeCanonical(
			root,
			"global/restricted.md",
			documentContent("restricted-doc", "restricted", RESTRICTED_BODY),
			"restricted",
		);

		const result = await proposeMemory(environment(root), {
			type: "note",
			content: "A public-safe proposal body.",
			targetUri: "global://private.md",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const staged = readStagedProposal(environment(root), result.value.proposalId);
		expect(staged.ok).toBe(true);
		const artifact = await fs.readFile(path.join(root, `global/proposals-${result.value.proposalId}.json`));
		const serialized = artifact.toString("utf8");
		expectNoSensitiveProjection(serialized);
		expectNoSensitiveProjection(result.value.diff);
		expectNoSensitiveProjection(JSON.stringify(result));
	});

	it("forgets a private canonical document and emits a truthful body-free receipt", async () => {
		const root = await makeRoot();
		const content = documentContent("private-forget", "private", PRIVATE_BODY);
		await writeCanonical(root, "global/private-forget.md", content, "private");
		const parsed = parseMemoryDocument({
			content,
			relPath: "global/private-forget.md",
			uri: "global://private-forget.md",
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const stale = await forgetMemory(environment(root), {
			uri: "global://private-forget.md",
			expectedDigest: "0".repeat(64),
		});
		expect(stale.ok).toBe(false);
		expectNoSensitiveProjection(JSON.stringify(stale));

		const result = await forgetMemory(environment(root), {
			uri: "global://private-forget.md",
			expectedDigest: parsed.value.digest,
			reason: "no longer needed",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.forgotten).toBe(true);
		expect(result.value.superseded).toBe(true);
		expectNoSensitiveProjection(JSON.stringify(result));

		const serializedFiles = [
			await globalJsonBytes(root),
			await fs.readFile(path.join(root, "MEMORY.md"), "utf8"),
			await fs.readFile(path.join(root, "global/private-forget.md"), "utf8"),
		].join("\n");
		expectNoSensitiveProjection(serializedFiles);
		expect(serializedFiles).toContain("gajae: tombstone no longer needed");
	});

	it("keeps restricted canonical bodies inside their document during supersession", async () => {
		const root = await makeRoot();
		await writeCanonical(
			root,
			"global/restricted-old.md",
			documentContent("restricted-old", "restricted", RESTRICTED_BODY),
			"restricted",
		);
		const proposal = await proposeMemory(environment(root), {
			type: "note",
			content: "A replacement that does not disclose the predecessor.",
			targetUri: "global://restricted-new.md",
			supersedes: ["restricted-old"],
		});
		expect(proposal.ok).toBe(true);
		if (!proposal.ok) return;
		expectNoSensitiveProjection(proposal.value.diff);
		const artifact = await fs.readFile(path.join(root, `global/proposals-${proposal.value.proposalId}.json`), "utf8");
		expectNoSensitiveProjection(artifact);
		const applied = await applyMemory(environment(root), { proposalId: proposal.value.proposalId });
		expect(applied.ok).toBe(true);
		const serializedFiles = `${await globalJsonBytes(root)}\n${await fs.readFile(path.join(root, "global/restricted-old.md"), "utf8")}`;
		expectNoSensitiveProjection(serializedFiles);
	});
});

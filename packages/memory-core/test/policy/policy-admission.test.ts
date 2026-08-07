import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryEnvironment, RepositorySnapshot } from "../../src/env";
import { type ProposeInput, propose, search } from "../../src/index";
import { admitMemoryPolicy } from "../../src/policy/policy-admission";
import { resolveScopes } from "../../src/scope/scope-resolver";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";

const temporaryRoots: string[] = [];
const REPOSITORY: RepositorySnapshot = {
	worktreeRoot: "/workspace/widget",
	commonDir: "/workspace/widget/.git",
	isLinkedWorktree: false,
	remotes: [{ name: "origin", url: "git@github.com:acme/widget.git" }],
};

function environment(memoryRoot: string, sessionId: string | null = "session-1"): MemoryEnvironment {
	return {
		memoryRoot,
		repository: REPOSITORY,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

function document(sensitivity: "public-safe" | "private" | "restricted" = "public-safe"): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		"id: needle",
		"type: fact",
		"scope: global",
		"authority: user-confirmed",
		"volatility: stable",
		`sensitivity: ${sensitivity}`,
		"status: active",
		"created: 2026-07-29T00:00:00Z",
		"updated: 2026-07-29T00:00:00.000Z",
		"aliases: []",
		"supersedes: []",
		"---",
		"# Needle",
		"deterministic policy needle",
		"",
	].join("\n");
}

function proposalInput(content: string): ProposeInput {
	return { type: "fact", content, targetUri: "global://notes/policy.md" };
}

async function makeRoot(): Promise<string> {
	const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-core-policy-admission-"));
	temporaryRoots.push(parent);
	const root = path.join(parent, "memory");
	await createMemoryRootScaffold(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })));
});

describe("memory policy admission", () => {
	it("uses the immutable defaults when optional policy files are absent", async () => {
		const root = await makeRoot();
		const result = admitMemoryPolicy(environment(root));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.retrieval).toEqual({ maxMaps: 4, maxFiles: 20, maxSections: 8, maxChars: 24_000 });
		expect(result.value.ledger.enabled).toBe(true);
		expect(result.value.write.enabled).toBe(true);
		expect(result.value.privacy.maxSensitivity).toBe("restricted");
	});

	it("merges global, project, and session files through the control reader", async () => {
		const root = await makeRoot();
		const initial = resolveScopes(environment(root));
		expect(initial.ok).toBe(true);
		if (!initial.ok) return;
		const projectKey = initial.value.project.encodedKey;
		await fsp.writeFile(
			path.join(root, "config.yaml"),
			"version: 1\nretrieval:\n  maxFiles: 12\nwrite:\n  allowedDestinations: [global-canonical, project-canonical, session, proposal]\n",
			{ mode: 0o600 },
		);
		await fsp.mkdir(path.join(root, "projects", projectKey), { mode: 0o700 });
		await fsp.writeFile(
			path.join(root, "projects", projectKey, "config.yaml"),
			"privacy:\n  maxSensitivity: private\n",
			{
				mode: 0o600,
			},
		);
		await fsp.mkdir(path.join(root, "sessions", "session-1"), { mode: 0o700 });
		await fsp.writeFile(
			path.join(root, "sessions", "session-1", "policy.yaml"),
			"retrieval:\n  maxFiles: 5\nledger:\n  enabled: false\n",
			{
				mode: 0o600,
			},
		);

		const result = admitMemoryPolicy(environment(root));
		expect(result).toEqual({
			ok: true,
			value: expect.objectContaining({
				retrieval: expect.objectContaining({ maxFiles: 5 }),
				ledger: expect.objectContaining({ enabled: false }),
				privacy: expect.objectContaining({ maxSensitivity: "private" }),
			}),
		});
	});

	it("rejects malformed or broadening in-store layers with typed results", async () => {
		const root = await makeRoot();
		await fsp.writeFile(path.join(root, "config.yaml"), "retrieval:\n  maxFiles: 0\n", { mode: 0o600 });
		const invalid = admitMemoryPolicy(environment(root));
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.code).toBe("invalid-input");

		await fsp.writeFile(path.join(root, "config.yaml"), "retrieval:\n  maxFiles: 10\n", { mode: 0o600 });
		await fsp.mkdir(path.join(root, "sessions", "session-1"), { mode: 0o700 });
		await fsp.writeFile(path.join(root, "sessions", "session-1", "policy.yaml"), "retrieval:\n  maxFiles: 11\n", {
			mode: 0o600,
		});
		const broadening = admitMemoryPolicy(environment(root));
		expect(broadening.ok).toBe(false);
		if (!broadening.ok) expect(broadening.error.code).toBe("policy-denied");
	});

	it("narrows retrieval budgets and suppresses ledger emission at the public search ingress", async () => {
		const root = await makeRoot();
		await fsp.writeFile(path.join(root, "config.yaml"), "retrieval:\n  maxFiles: 1\nledger:\n  enabled: false\n", {
			mode: 0o600,
		});
		await fsp.writeFile(path.join(root, "global", "needle.md"), document(), { mode: 0o600 });
		const result = await search(environment(root), { query: "needle" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.budget?.limits.maxFiles).toBe(1);
		expect(result.value.ledgerId).toBeNull();
		expect(result.value.sources.length).toBeGreaterThan(0);
	});

	it("denies writes disabled or routed outside the allowed destinations", async () => {
		const root = await makeRoot();
		await fsp.writeFile(path.join(root, "config.yaml"), "write:\n  enabled: false\n", { mode: 0o600 });
		const disabled = await propose(environment(root, null), proposalInput("disabled"));
		expect(disabled.ok).toBe(false);
		if (!disabled.ok) expect(disabled.error.code).toBe("policy-denied");

		await fsp.writeFile(path.join(root, "config.yaml"), "write:\n  allowedDestinations: [session, proposal]\n", {
			mode: 0o600,
		});
		const disallowed = await propose(environment(root, null), proposalInput("global target"));
		expect(disallowed.ok).toBe(false);
		if (!disallowed.ok) expect(disallowed.error.code).toBe("policy-denied");
	});

	it("enforces the configured sensitivity ceiling before staging", async () => {
		const root = await makeRoot();
		await fsp.writeFile(path.join(root, "config.yaml"), "privacy:\n  maxSensitivity: public-safe\n", {
			mode: 0o600,
		});
		const restricted = await propose(environment(root, null), proposalInput(document("restricted")));
		expect(restricted.ok).toBe(false);
		if (!restricted.ok) expect(restricted.error.code).toBe("sensitivity-violation");
	});
});

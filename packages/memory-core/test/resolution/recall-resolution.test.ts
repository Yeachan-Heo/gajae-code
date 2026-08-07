import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { MemoryEnvironment } from "../../src/env";
import type { ScopeResolutionResult } from "../../src/scope/scope-resolver";
import type { CandidateDirectoryEntry } from "../../src/search/candidate-universe";
import { type RetrievalDependencies, recallMemory } from "../../src/search/retrieval-pipeline";

const AS_OF = "2026-07-29T00:00:00.000Z";
const GLOBAL_PREFIX = `global:${"//"}`;
const MAP_URI = `memory:${"//"}global/MEMORY.md`;
const temporaryRoots: string[] = [];

interface DocumentOptions {
	readonly id: string;
	readonly type: string;
	readonly authority: string;
	readonly scope: string;
	readonly body: string;
	readonly volatility?: string;
	readonly aliases?: readonly string[];
	readonly updated?: string;
	readonly supersedes?: readonly string[];
	readonly status?: string;
	readonly verification?: { readonly provider: string; readonly resource: string; readonly id: string };
}

function document(options: DocumentOptions): string {
	const lines = [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		`id: ${options.id}`,
		`type: ${options.type}`,
		`scope: ${options.scope}`,
		`authority: ${options.authority}`,
		`volatility: ${options.volatility ?? "stable"}`,
		"sensitivity: public-safe",
		`status: ${options.status ?? "active"}`,
		`created: ${options.updated ?? AS_OF}`,
		`updated: ${options.updated ?? AS_OF}`,
		`aliases: [${(options.aliases ?? []).join(", ")}]`,
		`supersedes: [${(options.supersedes ?? []).join(", ")}]`,
	];
	if (options.verification !== undefined) {
		lines.push(
			"verification:",
			`  provider: ${options.verification.provider}`,
			`  resource: ${options.verification.resource}`,
			`  id: "${options.verification.id}"`,
		);
	}
	lines.push("---");
	return `${lines.join("\n")}\n${options.body}\n`;
}

function environment(memoryRoot: string): MemoryEnvironment {
	return { memoryRoot, repository: null, sessionId: null, now: new Date(AS_OF), deterministic: true, asOf: AS_OF };
}

function scopeResolution(memoryRoot: string): ScopeResolutionResult {
	return {
		schemaVersion: "gajae.memory.scope-resolution.v1",
		memoryRoot,
		project: {
			forgeId: null,
			repoRoot: null,
			gitCommonDir: null,
			isLinkedWorktree: false,
			encodedKey: "",
			source: "path-fallback",
		},
		sessionId: null,
		scopes: [
			{ kind: "global", root: "/virtual/global", writable: true, available: true, unavailableReason: null },
			{ kind: "project", root: null, writable: false, available: false, unavailableReason: "no project" },
			{ kind: "session", root: null, writable: false, available: false, unavailableReason: "no session" },
		],
	};
}

async function fixture(files: Readonly<Record<string, string>>): Promise<{
	readonly environment: MemoryEnvironment;
	readonly dependencies: RetrievalDependencies;
}> {
	const memoryRoot = await fs.mkdtemp(path.join(process.cwd(), ".memory-resolution-test-"));
	temporaryRoots.push(memoryRoot);
	const entriesFor = (relPath: string): readonly CandidateDirectoryEntry[] => {
		const prefix = relPath.length === 0 ? "" : `${relPath}/`;
		const children = new Map<string, CandidateDirectoryEntry["kind"]>();
		for (const name of Object.keys(files)) {
			if (!name.startsWith(prefix)) continue;
			const rest = name.slice(prefix.length);
			if (rest.length === 0) continue;
			const slash = rest.indexOf("/");
			children.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "directory");
		}
		return [...children.entries()]
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
			.map(([name, kind]) => ({ name, kind }));
	};
	const dependencies: RetrievalDependencies = {
		scopeResolution: scopeResolution(memoryRoot),
		mapUris: [MAP_URI],
		mapContents: { [MAP_URI]: "<!-- AUTO:PROJECTS START -->\n<!-- AUTO:PROJECTS END -->" },
		list: async (_scope, relPath) => entriesFor(relPath),
		read: async (_environment, uri) => {
			const content = files[uri.startsWith(GLOBAL_PREFIX) ? uri.slice(GLOBAL_PREFIX.length) : uri];
			return content === undefined
				? { ok: false as const, error: { code: "not-found" as const, exitCode: 5 as const, uri } }
				: { ok: true as const, value: { content } };
		},
	};
	return { environment: environment(memoryRoot), dependencies };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("recall exposes M3 claim resolution", () => {
	it("returns cited sources carrying authority, freshness, and volatility per claim", async () => {
		const store = await fixture({
			"note.md": document({
				id: "note",
				type: "fact",
				authority: "tool-verified",
				scope: "global",
				aliases: ["deployment"],
				body: "# Deployment fact\nThe deployment target is production.",
			}),
		});
		const result = await recallMemory(store.environment, { query: "deployment" }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.status).toBe("matched");
		// The recall envelope deliberately carries citations, not claim bodies:
		// duplicating document text would defeat the M2 privacy invariant.
		const source = result.value.sources[0];
		expect(source?.authority).toBe("tool-verified");
		expect(source?.updatedAt).toBe(AS_OF);
		expect(source?.volatility).toBe("stable");
		expect(source?.uri).toBe(`${GLOBAL_PREFIX}note.md`);
		expect(source?.digest.length).toBe(64);
		expect(JSON.stringify(result.value)).not.toContain("The deployment target is production.");
	});

	it("keeps each volatile claim paired with its own document verification hint", async () => {
		const store = await fixture({
			"live-a.md": document({
				id: "live-a",
				type: "observation",
				authority: "tool-verified",
				scope: "global",
				volatility: "volatile",
				verification: { provider: "local", resource: "port", id: "8080" },
				aliases: ["listener"],
				// Same type and heading slug as live-b, so both claims share a claim
				// key: a claimKey-keyed hint map would cross-wire the two documents.
				body: "# Listener\nPort 8080 is listening right now.",
			}),
			"live-b.md": document({
				id: "live-b",
				type: "observation",
				authority: "tool-verified",
				scope: "global",
				volatility: "volatile",
				verification: { provider: "remote", resource: "socket", id: "9090" },
				aliases: ["listener"],
				body: "# Listener\nPort 9090 is listening right now.",
			}),
		});
		const result = await recallMemory(store.environment, { query: "listener" }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.volatileClaims.length).toBe(2);
		for (const volatile of result.value.volatileClaims) {
			expect(volatile.verificationRequired).toBe(true);
		}
		const byPort = new Map(
			result.value.volatileClaims.map(volatile => [volatile.claim, volatile.verificationHint] as const),
		);
		expect(byPort.get("Port 8080 is listening right now.")).toEqual({
			provider: "local",
			resource: "port",
			id: "8080",
		});
		expect(byPort.get("Port 9090 is listening right now.")).toEqual({
			provider: "remote",
			resource: "socket",
			id: "9090",
		});
	});

	it("projects volatile hints and conflicts into the explain receipt as claim keys only", async () => {
		const store = await fixture({
			"live-a.md": document({
				id: "live-a",
				type: "observation",
				authority: "tool-verified",
				scope: "global",
				volatility: "volatile",
				verification: { provider: "local", resource: "port", id: "8080" },
				aliases: ["listener"],
				body: "# Listener\nPort 8080 is listening right now.",
			}),
		});
		const result = await recallMemory(store.environment, { query: "listener", explain: true }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const explain = result.value.explain;
		expect(explain).toBeDefined();
		if (explain === undefined) return;
		expect(result.value.volatileClaims.length).toBeGreaterThan(0);
		expect(explain.hints.length).toBeGreaterThan(0);
		// The claim VALUE is body-derived text; only its key may appear in explain.
		for (const volatile of result.value.volatileClaims) {
			expect(explain.hints).not.toContain(volatile.claim);
		}
		expect(explain.hints).toContain("observation.listener");
		expect(JSON.stringify(explain)).not.toContain("Port 8080 is listening right now.");
	});

	it("never lets a fresher lower-authority claim weaken a user-confirmed global constraint", async () => {
		const store = await fixture({
			"global-constraint.md": document({
				id: "release-approval-global",
				type: "constraint",
				authority: "user-confirmed",
				scope: "global",
				aliases: ["release"],
				updated: "2026-07-20T00:00:00.000Z",
				body: "# Release approval\nRelease requires explicit human approval.",
			}),
			"project-constraint.md": document({
				id: "release-approval-project",
				type: "constraint",
				authority: "project-config",
				scope: "global",
				aliases: ["release"],
				// Deliberately newer: freshness must never beat declared authority
				// for a user-confirmed safety constraint (spec 10.2).
				updated: AS_OF,
				body: "# Release approval\nRelease may skip human approval.",
			}),
		});
		const result = await recallMemory(store.environment, { query: "release" }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const reported = [...result.value.resolutions, ...result.value.conflicts];
		expect(reported.length).toBeGreaterThan(0);
		for (const entry of reported) {
			expect(entry.dimensions.authority.length).toBeGreaterThan(0);
			expect(entry.dimensions.specificity.length).toBeGreaterThan(0);
			expect(entry.dimensions.freshness.length).toBeGreaterThan(0);
			expect(entry.dimensions.volatility.length).toBeGreaterThan(0);
		}
		// The weaker claim may never be selected, and it may never be resolved away
		// silently: either authority wins outright or the conflict is reported.
		const weakened = reported.find(entry => entry.resolution?.value.includes("may skip human approval"));
		expect(weakened).toBeUndefined();
		const releaseEntry = reported.find(entry => entry.claimKey.includes("release-approval"));
		expect(releaseEntry).toBeDefined();
		if (releaseEntry?.resolution === null) {
			expect(releaseEntry.requiresUserConfirmation).toBe(true);
			expect(result.value.status).toBe("conflict");
		} else {
			expect(releaseEntry?.resolution?.value).toContain("requires explicit human approval");
		}
		expect(JSON.stringify(result.value)).not.toContain("Release may skip human approval.\n");
	});

	it("reports an unresolved same-authority conflict instead of silently picking a winner", async () => {
		const store = await fixture({
			"left.md": document({
				id: "policy-left",
				type: "policy",
				authority: "project-config",
				scope: "global",
				aliases: ["retention"],
				body: "# Retention policy\nRetain logs for 30 days.",
			}),
			"right.md": document({
				id: "policy-right",
				type: "policy",
				authority: "project-config",
				scope: "global",
				aliases: ["retention"],
				body: "# Retention policy\nRetain logs for 90 days.",
			}),
		});
		const result = await recallMemory(store.environment, { query: "retention" }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.conflicts.length).toBeGreaterThan(0);
		expect(result.value.status).toBe("conflict");
		const conflict = result.value.conflicts[0];
		expect(conflict?.resolution).toBeNull();
		expect(conflict?.requiresUserConfirmation).toBe(true);
		expect(conflict?.rejected.length).toBeGreaterThan(1);
	});

	it("caps a long claim value instead of republishing the document body", async () => {
		// The cap applies to the first non-empty claim line, so the adversarial
		// case is one very long first line, not filler on later lines.
		const headline = `Capacity headline ${"x".repeat(400)}`;
		const store = await fixture({
			"long.md": document({
				id: "long",
				type: "fact",
				authority: "tool-verified",
				scope: "global",
				volatility: "volatile",
				aliases: ["capacity"],
				body: `# Capacity\n${headline}`,
			}),
		});
		const result = await recallMemory(store.environment, { query: "capacity" }, store.dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.volatileClaims.length).toBe(1);
		const claimValue = result.value.volatileClaims[0]?.claim ?? "";
		expect([...claimValue].length).toBe(201);
		expect(claimValue).toBe(`${[...headline].slice(0, 200).join("")}…`);
		expect(JSON.stringify(result.value)).not.toContain(headline);
	});

	it("resolves a conflict from a ranked document that the citation budget omits", async () => {
		const store = await fixture({
			"global-constraint.md": document({
				id: "budget-global",
				type: "constraint",
				authority: "user-confirmed",
				scope: "global",
				aliases: ["budget"],
				updated: "2026-07-20T00:00:00.000Z",
				body: "# Budget constraint\nSpending requires explicit approval.",
			}),
			"project-constraint.md": document({
				id: "budget-project",
				type: "constraint",
				authority: "project-config",
				scope: "global",
				aliases: ["budget"],
				updated: AS_OF,
				body: "# Budget constraint\nSpending may skip approval.",
			}),
		});
		// Only one citation is allowed, so the competing claim lives in a ranked
		// document that never becomes a source. It must still be resolved.
		const first = await recallMemory(store.environment, { query: "budget", limit: 1 }, store.dependencies);
		const second = await recallMemory(store.environment, { query: "budget", limit: 1 }, store.dependencies);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.sources.length).toBe(1);
		expect(first.value.conflicts.length).toBeGreaterThan(0);
		expect(first.value.status).toBe("conflict");
		const conflict = first.value.conflicts[0];
		expect(conflict?.requiresUserConfirmation).toBe(true);
		expect(conflict?.resolution).toBeNull();
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("keeps agreement conflict-free and stays byte-stable across repeated calls", async () => {
		const store = await fixture({
			"a.md": document({
				id: "a",
				type: "convention",
				authority: "project-config",
				scope: "global",
				aliases: ["testing"],
				body: "# Testing\nUse bun test.",
			}),
		});
		const first = await recallMemory(store.environment, { query: "testing" }, store.dependencies);
		const second = await recallMemory(store.environment, { query: "testing" }, store.dependencies);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.conflicts).toEqual([]);
		expect(first.value.status).toBe("matched");
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

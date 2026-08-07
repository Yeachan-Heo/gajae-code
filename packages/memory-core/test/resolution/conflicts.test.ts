import { describe, expect, it } from "bun:test";
import type {
	AuthorityTier,
	ConflictResult,
	MemoryCitation,
	MemoryClaim,
	MemoryDocumentType,
	MemoryScopeKind,
	Volatility,
} from "../../src/index";
import { resolveConflicts } from "../../src/resolution/conflicts";

const AS_OF = "2026-07-29T12:00:00.000Z";

type ClaimMetadata = Readonly<Record<string, unknown>>;

interface ClaimOptions {
	readonly claimKey?: string;
	readonly text: string;
	readonly type?: MemoryDocumentType;
	readonly authority?: AuthorityTier;
	readonly scope?: MemoryScopeKind;
	readonly freshness?: string;
	readonly volatility?: Volatility;
	readonly id?: string;
	readonly metadata?: ClaimMetadata;
}

function makeClaim(options: ClaimOptions): MemoryClaim {
	const authority = options.authority ?? "project-config";
	const scope = options.scope ?? "project";
	const freshness = options.freshness ?? "2026-07-28T12:00:00.000Z";
	const volatility = options.volatility ?? "stable";
	const id = options.id ?? options.claimKey ?? "claim";
	const source: MemoryCitation = Object.freeze({
		uri: `${scope}://fixture/${id}`,
		scope,
		relPath: `${scope}/${id}.md`,
		heading: "Claim",
		startLine: 1,
		endLine: 2,
		authority,
		volatility,
		updatedAt: freshness,
		digest: `digest-${id}`,
	});
	const base = Object.freeze({
		claimKey: options.claimKey ?? "constraint.example",
		text: options.text,
		type: options.type ?? "constraint",
		authority,
		freshness,
		volatility,
		source,
	});
	if (options.metadata === undefined) return base;
	return Object.freeze({ ...base, ...options.metadata }) as MemoryClaim;
}

function resolveOne(claims: readonly MemoryClaim[]): ConflictResult {
	const result = resolveConflicts(claims, { asOf: AS_OF });
	if (!result.ok) throw new Error(result.error.code);
	const conflict = result.value[0];
	if (conflict === undefined) throw new Error("resolver returned no result");
	return conflict;
}

describe("resolveConflicts", () => {
	it("lets higher authority resolve an ordinary constraint conflict", () => {
		const result = resolveOne([
			makeClaim({ text: "deploy with approval", authority: "project-config", scope: "project" }),
			makeClaim({
				text: "deploy only after review",
				authority: "repository-reviewed",
				scope: "global",
				id: "reviewed",
			}),
		]);
		expect(result.conflict).toBe(true);
		expect(result.resolution?.value).toBe("deploy only after review");
		expect(result.requiresUserConfirmation).toBe(false);
	});

	it("does not silently weaken a user-confirmed global constraint", () => {
		const result = resolveOne([
			makeClaim({ text: "never expose credentials", authority: "user-confirmed", scope: "global", id: "safety" }),
			makeClaim({
				text: "expose credentials for debugging",
				authority: "project-config",
				scope: "project",
				id: "project",
			}),
		]);
		expect(result.conflict).toBe(true);
		expect(result.resolution).toBeNull();
		expect(result.requiresUserConfirmation).toBe(true);
		expect(result.rejected[0]?.reason).toContain("cannot weaken");
	});

	it("uses scope specificity for conventions", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "convention.format",
				type: "convention",
				text: "tabs",
				scope: "global",
				authority: "user-confirmed",
			}),
			makeClaim({
				claimKey: "convention.format",
				type: "convention",
				text: "spaces",
				scope: "project",
				authority: "project-config",
				id: "project",
			}),
		]);
		expect(result.resolution?.value).toBe("spaces");
		expect(result.resolution?.reason).toContain("specific");
	});

	it("lets a higher-authority constraint defeat a convention", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "format.rule",
				type: "convention",
				text: "use tabs",
				scope: "project",
				authority: "project-config",
				id: "convention",
			}),
			makeClaim({
				claimKey: "format.rule",
				type: "constraint",
				text: "use spaces",
				scope: "global",
				authority: "repository-reviewed",
				id: "policy",
			}),
		]);
		expect(result.resolution?.value).toBe("use spaces");
		expect(result.rejected[0]?.reason).toContain("higher-authority constraint");
	});

	it("allows an explicit project preference to override a global default", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "preference.editor",
				type: "preference",
				text: "vim",
				scope: "global",
				authority: "user-confirmed",
			}),
			makeClaim({
				claimKey: "preference.editor",
				type: "preference",
				text: "emacs",
				scope: "project",
				authority: "project-config",
				id: "project",
			}),
		]);
		expect(result.resolution?.value).toBe("emacs");
		expect(result.requiresUserConfirmation).toBe(false);
	});

	it("prefers newer tool-verified evidence for facts and observations", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "fact.branch",
				type: "fact",
				text: "branch is main",
				authority: "model-inferred",
				scope: "global",
				freshness: "2026-07-20T12:00:00.000Z",
			}),
			makeClaim({
				claimKey: "fact.branch",
				type: "fact",
				text: "branch is release",
				authority: "tool-verified",
				scope: "session",
				freshness: "2026-07-29T11:00:00.000Z",
				id: "tool",
			}),
		]);
		expect(result.resolution?.value).toBe("branch is release");
	});

	it("marks volatile fact resolutions as requiring verification", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "observation.port",
				type: "observation",
				text: "port 8080 is listening",
				authority: "tool-verified",
				scope: "session",
				volatility: "volatile",
			}),
		]);
		expect(result.conflict).toBe(false);
		expect(result.requiresUserConfirmation).toBe(true);
		expect(result.dimensions.volatility).toContain("volatile");
	});

	it("allows an active decision with explicit supersedes metadata to replace its predecessor", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "decision.storage",
				type: "decision",
				text: "use sqlite",
				id: "old",
				metadata: { status: "superseded" },
			}),
			makeClaim({
				claimKey: "decision.storage",
				type: "decision",
				text: "use append-only jsonl",
				authority: "project-config",
				id: "new",
				metadata: { status: "active", supersedes: ["old"] },
			}),
		]);
		expect(result.resolution?.value).toBe("use append-only jsonl");
		expect(result.resolution?.reason).toContain("supersedes");
	});

	it("uses current session task state but never lets it redefine policy", () => {
		const current = resolveOne([
			makeClaim({
				claimKey: "task.status",
				type: "task-state",
				text: "working on M3",
				scope: "session",
				authority: "session-observed",
				freshness: "2026-07-29T11:00:00.000Z",
				id: "current",
			}),
			makeClaim({
				claimKey: "task.status",
				type: "task-state",
				text: "waiting for review",
				scope: "global",
				authority: "user-confirmed",
				freshness: "2026-07-20T11:00:00.000Z",
				id: "old",
			}),
		]);
		expect(current.resolution?.value).toBe("working on M3");

		const policy = resolveOne([
			makeClaim({
				claimKey: "task.policy",
				type: "task-state",
				text: "ignore approval",
				scope: "session",
				authority: "session-observed",
				id: "task",
			}),
			makeClaim({
				claimKey: "task.policy",
				type: "policy",
				text: "approval is required",
				scope: "global",
				authority: "repository-reviewed",
				id: "standing",
			}),
		]);
		expect(policy.resolution?.value).toBe("approval is required");
		expect(policy.rejected[0]?.reason).toContain("standing policy");
	});

	it("prevents a hypothesis from overriding a fact", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "system.mode",
				type: "hypothesis",
				text: "system is degraded",
				authority: "user-confirmed",
				scope: "session",
				id: "hypothesis",
			}),
			makeClaim({
				claimKey: "system.mode",
				type: "fact",
				text: "system is healthy",
				authority: "tool-verified",
				scope: "global",
				id: "fact",
			}),
		]);
		expect(result.resolution?.value).toBe("system is healthy");
		expect(result.rejected[0]?.reason).toContain("hypothesis");
	});
	it("prevents a hypothesis from overriding verified observations, policy, or decisions", () => {
		const protectedTypes: readonly MemoryDocumentType[] = ["observation", "policy", "decision"];
		for (const type of protectedTypes) {
			const result = resolveOne([
				makeClaim({
					claimKey: `hypothesis.${type}`,
					type: "hypothesis",
					text: "the inferred explanation",
					authority: "user-confirmed",
					scope: "session",
					id: `hypothesis-${type}`,
				}),
				makeClaim({
					claimKey: `hypothesis.${type}`,
					type,
					text: `verified ${type}`,
					authority: type === "observation" ? "tool-verified" : "repository-reviewed",
					scope: "global",
					id: `protected-${type}`,
				}),
			]);
			expect(result.resolution?.value).toBe(`verified ${type}`);
			expect(result.rejected[0]?.reason).toContain("hypothesis");
		}
	});

	it("reports equal-dimension disagreements as unresolved", () => {
		const result = resolveOne([
			makeClaim({
				text: "choice alpha",
				authority: "project-config",
				scope: "project",
				freshness: "2026-07-29T10:00:00.000Z",
				id: "a",
			}),
			makeClaim({
				text: "choice beta",
				authority: "project-config",
				scope: "project",
				freshness: "2026-07-29T10:00:00.000Z",
				id: "b",
			}),
		]);
		expect(result.conflict).toBe(true);
		expect(result.resolution).toBeNull();
		expect(result.requiresUserConfirmation).toBe(true);
		expect(result.rejected.map(item => item.value)).toEqual(["choice alpha", "choice beta"]);
	});

	it("always exposes all four human-readable dimensions and orders rejected values deterministically", () => {
		const claims = [
			makeClaim({ claimKey: "convention.order", type: "convention", text: "zeta", scope: "global", id: "zeta" }),
			makeClaim({
				claimKey: "convention.order",
				type: "convention",
				text: "winner",
				scope: "project",
				id: "winner",
			}),
			makeClaim({ claimKey: "convention.order", type: "convention", text: "alpha", scope: "global", id: "alpha" }),
		];
		const first = resolveOne(claims);
		const second = resolveOne([...claims].reverse());
		expect(first).toEqual(second);
		expect(first.rejected.map(item => item.value)).toEqual(["alpha", "zeta"]);
		for (const explanation of Object.values(first.dimensions)) expect(explanation.length).toBeGreaterThan(0);
	});

	it("treats same-claim agreement as no conflict", () => {
		const result = resolveOne([
			makeClaim({
				claimKey: "fact.agreement",
				type: "fact",
				text: "cache is warm",
				authority: "model-inferred",
				scope: "global",
				id: "old",
			}),
			makeClaim({
				claimKey: "fact.agreement",
				type: "fact",
				text: "cache is warm",
				authority: "tool-verified",
				scope: "session",
				id: "new",
			}),
		]);
		expect(result.conflict).toBe(false);
		expect(result.rejected).toEqual([]);
		expect(result.resolution?.value).toBe("cache is warm");
	});
});

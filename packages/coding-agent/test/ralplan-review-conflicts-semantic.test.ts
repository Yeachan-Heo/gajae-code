import { describe, expect, test } from "bun:test";
import { JevClient } from "@gajae-code/ai";
import type { ReviewFinding } from "../src/gjc-runtime/ralplan-review-conflicts";
import { detectReviewConflicts } from "../src/gjc-runtime/ralplan-review-conflicts";
import {
	candidateCrossTargetPairs,
	detectSemanticReviewConflicts,
} from "../src/gjc-runtime/ralplan-review-conflicts-semantic";

function finding(over: Partial<ReviewFinding> & Pick<ReviewFinding, "findingId" | "targetId" | "action" | "sourceRole">): ReviewFinding {
	return {
		severity: "block",
		evidence: `evidence for ${over.findingId}`,
		sourceReceipt: { stage: over.sourceRole === "architect" ? "architect" : "critic", stageN: 1, path: "p", sha256: "s" },
		...over,
	} as ReviewFinding;
}

const ARCH_REMOVE = finding({ findingId: "f1", targetId: "module-a", action: "remove", sourceRole: "architect" });
const CRITIC_ADD = finding({ findingId: "f2", targetId: "module-b", action: "add", sourceRole: "critic" });

/** A client whose transport is a function, so nothing touches the network. */
function clientReturning(noul: number | ((body: string) => number)): JevClient {
	return new JevClient({
		apiKey: "test-key",
		fetchImpl: (async (_url: string, init: RequestInit) => {
			const value = typeof noul === "function" ? noul(String(init.body)) : noul;
			return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { conflicting: { type: "noul", noul: value } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch,
	});
}

describe("candidate pairs", () => {
	test("pairs cross-role findings on different targets", () => {
		expect(candidateCrossTargetPairs([ARCH_REMOVE, CRITIC_ADD])).toHaveLength(1);
	});

	test("leaves same-target pairs to the exact check", () => {
		const sameTarget = finding({ findingId: "f3", targetId: "module-a", action: "add", sourceRole: "critic" });
		expect(candidateCrossTargetPairs([ARCH_REMOVE, sameTarget])).toHaveLength(0);
		// and the exact check does claim it
		expect(detectReviewConflicts([ARCH_REMOVE, sameTarget])).toHaveLength(1);
	});

	test("ignores same-role pairs and clarify actions", () => {
		const sameRole = finding({ findingId: "f4", targetId: "module-c", action: "add", sourceRole: "architect" });
		expect(candidateCrossTargetPairs([ARCH_REMOVE, sameRole])).toHaveLength(0);
		const clarify = finding({ findingId: "f5", targetId: "module-d", action: "clarify", sourceRole: "critic" });
		expect(candidateCrossTargetPairs([ARCH_REMOVE, clarify])).toHaveLength(0);
	});
});

describe("detection", () => {
	test("opens a conflict above threshold", async () => {
		const result = await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD], { client: clientReturning(0.91) });
		expect(result.evaluated).toBe(1);
		expect(result.errors).toEqual([]);
		expect(result.conflicts).toHaveLength(1);
		const conflict = result.conflicts[0]!;
		expect(conflict.status).toBe("open");
		expect(conflict.findingIds).toEqual(["f1", "f2"]);
		expect(conflict.targetId).toBe("module-a|module-b");
		expect(conflict.conflictId.startsWith("conflict:semantic:")).toBe(true);
	});

	test("stays silent below threshold", async () => {
		const result = await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD], { client: clientReturning(0.31) });
		expect(result.evaluated).toBe(1);
		expect(result.conflicts).toEqual([]);
	});

	test("sends one pair per request and never several subjects in one state", async () => {
		const bodies: string[] = [];
		const client = clientReturning(body => {
			bodies.push(body);
			return 0.0;
		});
		const third = finding({ findingId: "f6", targetId: "module-c", action: "change", sourceRole: "critic" });
		await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD, third], { client, concurrency: 2 });
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			const sent = JSON.parse(body);
			expect(Object.keys(sent.state)).toEqual(["finding_a", "finding_b"]);
			expect(Object.keys(sent.questions)).toEqual(["conflicting"]);
			expect(sent.model).toBe("jev-1.13.0");
		}
	});
});

describe("failure is never a block", () => {
	test("an unconfigured client skips instead of throwing", async () => {
		const result = await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD], {
			client: new JevClient({ env: {}, apiKey: undefined }),
		});
		expect(result.skipped).toBe("not_configured");
		expect(result.conflicts).toEqual([]);
	});

	test("a transport failure degrades to no conflicts and a recorded error", async () => {
		const client = new JevClient({
			apiKey: "k",
			maxAttempts: 1,
			fetchImpl: (async () => {
				throw new Error("socket hang up");
			}) as unknown as typeof fetch,
		});
		const result = await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD], { client });
		expect(result.conflicts).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("socket hang up");
	});

	test("a 422 degrades rather than throwing out of the pass", async () => {
		const client = new JevClient({
			apiKey: "k",
			maxAttempts: 1,
			fetchImpl: (async () => new Response("bad question", { status: 422 })) as unknown as typeof fetch,
		});
		const result = await detectSemanticReviewConflicts([ARCH_REMOVE, CRITIC_ADD], { client });
		expect(result.conflicts).toEqual([]);
		expect(result.errors[0]).toContain("422");
	});

	test("the pair budget refuses rather than spending", async () => {
		const many: ReviewFinding[] = [];
		for (let i = 0; i < 40; i++) {
			many.push(finding({ findingId: `a${i}`, targetId: `t${i}`, action: "remove", sourceRole: "architect" }));
			many.push(finding({ findingId: `c${i}`, targetId: `u${i}`, action: "add", sourceRole: "critic" }));
		}
		const result = await detectSemanticReviewConflicts(many, { client: clientReturning(1), maxPairs: 10 });
		expect(result.skipped).toBe("pair_budget_exceeded");
		expect(result.evaluated).toBe(0);
	});
});

describe("the exact check is untouched", () => {
	test("same-target incompatible pairs still conflict without any client", () => {
		const sameTarget = finding({ findingId: "f9", targetId: "module-a", action: "add", sourceRole: "critic" });
		const conflicts = detectReviewConflicts([ARCH_REMOVE, sameTarget]);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.conflictId).toBe("conflict:module-a:f1:f9");
	});
});

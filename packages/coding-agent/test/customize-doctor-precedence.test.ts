import { describe, expect, test } from "bun:test";
import { type DiscoveryPrecedenceCandidate, resolveDiscoveryPrecedence } from "../src/cli/customize-doctor-precedence";

const CANDIDATE_SHAPES: readonly DiscoveryPrecedenceCandidate[] = [
	{ key: "read", provider: "repository", scope: "project", eligible: false, enabled: true },
	{ key: "read", provider: "native", scope: "user", eligible: true, enabled: true },
	{ key: "read", provider: "claude", scope: "user", eligible: true, enabled: true },
	{ key: "read", provider: "disabled", scope: "user", eligible: true, enabled: false },
	{ key: "write", provider: "repository", scope: "project", eligible: false, enabled: true },
	{ key: "write", provider: "native", scope: "user", eligible: true, enabled: true },
	{ key: "write", provider: "codex", scope: "user", eligible: true, enabled: true },
	{ key: "write", provider: "disabled", scope: "user", eligible: true, enabled: false },
	{ key: undefined, provider: "native", scope: "user", eligible: true, enabled: true },
];

function generateSequences<T>(values: readonly T[], maxLength: number): T[][] {
	const sequences: T[][] = [];
	const visit = (prefix: T[], remaining: number): void => {
		if (prefix.length > 0) sequences.push([...prefix]);
		if (remaining === 0) return;

		for (const value of values) {
			prefix.push(value);
			visit(prefix, remaining - 1);
			prefix.pop();
		}
	};
	visit([], maxLength);
	return sequences;
}

describe("customize doctor discovery precedence", () => {
	test("generated ordered candidates obey first eligible enabled ownership", () => {
		for (const candidates of generateSequences(CANDIDATE_SHAPES, 3)) {
			const resolved = resolveDiscoveryPrecedence(candidates);
			const ownerIndexByKey = new Map<string, number>();
			for (const [index, candidate] of candidates.entries()) {
				if (
					candidate.key !== undefined &&
					candidate.eligible &&
					candidate.enabled &&
					!ownerIndexByKey.has(candidate.key)
				) {
					ownerIndexByKey.set(candidate.key, index);
				}
			}

			for (const [index, candidate] of candidates.entries()) {
				const result = resolved[index];
				if (!result) throw new Error("missing precedence result for candidate");
				const ownerIndex = candidate.key === undefined ? undefined : ownerIndexByKey.get(candidate.key);
				if (!candidate.eligible || ownerIndex === undefined || index < ownerIndex) {
					expect(result).toEqual({ shadowed: false });
				} else if (index === ownerIndex) {
					expect(result).toEqual({ shadowed: false });
				} else {
					const owner = candidates[ownerIndex];
					if (!owner) throw new Error("missing expected precedence owner");
					expect(result).toEqual({
						shadowed: true,
						shadowedBy: { provider: owner.provider, scope: owner.scope },
					});
				}
				if (!candidate.eligible) expect(result.shadowedBy).toBeUndefined();
			}
		}
	});

	test("inserting excluded project candidates cannot change eligible winners", () => {
		const eligibleShapes = CANDIDATE_SHAPES.filter(candidate => candidate.eligible);
		const projectShapes = CANDIDATE_SHAPES.filter(candidate => !candidate.eligible);

		for (const candidates of generateSequences(eligibleShapes, 3)) {
			const baseline = resolveDiscoveryPrecedence(candidates);
			for (const project of projectShapes) {
				for (let insertionIndex = 0; insertionIndex <= candidates.length; insertionIndex++) {
					const expanded = [...candidates.slice(0, insertionIndex), project, ...candidates.slice(insertionIndex)];
					const expandedResults = resolveDiscoveryPrecedence(expanded);
					for (let index = 0; index < candidates.length; index++) {
						const expandedIndex = index < insertionIndex ? index : index + 1;
						expect(expandedResults[expandedIndex]).toEqual(baseline[index]);
					}
				}
			}
		}
	});
});

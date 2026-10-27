export interface DiscoveryPrecedenceCandidate {
	key: string | undefined;
	provider: string;
	scope: "user" | "project" | "native";
	eligible: boolean;
	enabled: boolean;
}

export interface DiscoveryPrecedenceResult {
	shadowed: boolean;
	shadowedBy?: { provider: string; scope: DiscoveryPrecedenceCandidate["scope"] };
}

/** Resolve ordered discovery candidates without allowing ineligible or disabled entries to own keys. */
export function resolveDiscoveryPrecedence(
	candidates: readonly DiscoveryPrecedenceCandidate[],
): DiscoveryPrecedenceResult[] {
	const winners = new Map<string, { provider: string; scope: DiscoveryPrecedenceCandidate["scope"] }>();

	return candidates.map(candidate => {
		if (!candidate.eligible || candidate.key === undefined) return { shadowed: false };

		const winner = winners.get(candidate.key);
		if (winner) return { shadowed: true, shadowedBy: winner };

		if (candidate.enabled) {
			winners.set(candidate.key, { provider: candidate.provider, scope: candidate.scope });
		}
		return { shadowed: false };
	});
}

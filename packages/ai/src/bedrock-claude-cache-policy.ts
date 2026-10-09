export type BedrockClaudeGeneration = {
	generation: { major: number; minor: number };
	kind: string;
};

function extractBedrockModelId(id: string): string | undefined {
	if (id !== id.toLowerCase()) return undefined;
	if (id.startsWith("arn:")) {
		const arn =
			/^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-eusc):bedrock:[a-z0-9-]+:(?:\d{12})?:(?:foundation-model|inference-profile)\/([^/]+)$/.exec(
				id,
			);
		return arn?.[1];
	}
	return id.includes("/") ? undefined : id;
}

/**
 * Bedrock Claude ids come in two shapes:
 *  - family-first (3.x era): anthropic.claude-3-5-haiku-20241022-v1:0
 *  - kind-first (4+ era):    anthropic.claude-opus-4-20250514-v1:0,
 *                            anthropic.claude-haiku-4-5-20251001-v1:0
	 * Cross-region profiles (us./eu./au./jp./apac./global./in. prefixes) and inference-profile
	 * ARNs keep the canonical model id as their final path segment.
	 */
	export function parseBedrockClaudeGeneration(id: string): BedrockClaudeGeneration | undefined {
		const modelId = extractBedrockModelId(id);
		if (modelId === undefined) return undefined;
		const prefix = "(?:(?:us|eu|au|jp|apac|global|in)\\.)?anthropic\\.claude-";
	const component = "(?:0|[1-9]\\d?)";
	const suffix = "(?:-(?:[a-z][a-z0-9]*(?::[a-z0-9]+)?|\\d{8}))*";
	const familyFirst = new RegExp(`^${prefix}([1-9]\\d?)(?:-(${component}))?-([a-z][a-z0-9]*)${suffix}$`).exec(modelId);
	if (familyFirst) {
		return {
			generation: {
				major: Number(familyFirst[1]),
				minor: familyFirst[2] === undefined ? 0 : Number(familyFirst[2]),
			},
			kind: familyFirst[3]!,
		};
	}
	const kindFirst = new RegExp(`^${prefix}([a-z][a-z0-9]*)-([1-9]\\d?)(?:[.-](${component}))?${suffix}$`).exec(
		modelId,
	);
	if (kindFirst) {
		return {
			generation: { major: Number(kindFirst[2]), minor: kindFirst[3] === undefined ? 0 : Number(kindFirst[3]) },
			kind: kindFirst[1]!,
		};
	}
	return undefined;
}

/**
 * Returns undefined for non-Claude ids, false for malformed or unsupported
 * Claude ids, and true only for AWS's documented cache-capable generations.
 */
export function supportsBedrockClaudePromptCaching(id: string): boolean | undefined {
	if (!id.toLowerCase().includes("anthropic.claude")) return undefined;
	const claude = parseBedrockClaudeGeneration(id);
	if (claude === undefined) return false;
	if (claude.generation.major >= 4) return true;
	if (claude.generation.major !== 3) return false;
	return (
		(claude.generation.minor === 5 && claude.kind === "haiku") ||
		(claude.generation.minor === 7 && claude.kind === "sonnet")
	);
}

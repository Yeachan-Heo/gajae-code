import { loadEffectiveGjcPluginRegistry } from "./registry";
import { resolveValidatedActiveSubskill } from "./subskill-authority";
import type { LoadedSubskillActivation } from "./types";
import { GjcPluginLoadError } from "./types";

export interface SubskillActivationResult {
	cleanedArgs: string;
	activation?: LoadedSubskillActivation;
	activeSubskillsToPersist: LoadedSubskillActivation[];
}

export async function resolveSubskillActivationForSkillInvocation(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	skillName: string;
	args: string;
}): Promise<SubskillActivationResult> {
	const registry = await loadEffectiveGjcPluginRegistry(input.cwd);
	const candidates: LoadedSubskillActivation[] = [];
	for (const entry of registry) {
		if (!entry.enabled || entry.migration?.status === "failed") continue;
		for (const surface of entry.surfaces.subskills) {
			const validated = await resolveValidatedActiveSubskill({
				cwd: input.cwd,
				reference: {
					plugin: entry.name,
					scope: entry.scope,
					subskillName: surface.name,
					parent: surface.parent,
					phase: surface.phase,
					activationArg: surface.activationArg,
					extensionId: surface.extensionId,
					expectedDigest: surface.sha256,
				},
			});
			if (validated) candidates.push(validated.activation);
		}
	}
	const candidateActivations = candidates.filter(candidate => candidate.parent === input.skillName);
	const activationsByArg = new Map<string, LoadedSubskillActivation>();
	for (const candidate of candidateActivations) {
		if (activationsByArg.has(candidate.activationArg))
			throw new GjcPluginLoadError(
				"duplicate_arg",
				`Duplicate GJC plugin activation argument: --${candidate.activationArg}`,
			);
		activationsByArg.set(candidate.activationArg, candidate);
	}
	const tokens = input.args
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
	let activation: LoadedSubskillActivation | undefined;
	let consumed = false;
	// Find the activation flag and its position to remove it while preserving
	// other text (especially multiline structure when the flag is removed)
	let flagTokenIndex = -1;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!consumed && token.startsWith("--") && !token.includes("=")) {
			const candidate = activationsByArg.get(token.slice(2));
			if (candidate) {
				activation = candidate;
				consumed = true;
				flagTokenIndex = i;
				break;
			}
		}
	}
	let cleanedArgs = input.args;
	if (consumed && flagTokenIndex >= 0) {
		// Remove the flag from the original text by finding and deleting the exact token
		// without normalizing other whitespace (review P2, issue #5951).
		const flagToken = tokens[flagTokenIndex];
		const flagPattern = new RegExp(`(^|\\s)${flagToken.replace(/[.*+?^${}()|[\\\\\]]/g, "\\$&")}(\\s|$)`);
		cleanedArgs = input.args.replace(flagPattern, (_match, before, after) => {
			// Preserve one whitespace boundary if present
			return before || after ? before || after : "";
		});
	}
	return {
		cleanedArgs,
		activation,
		activeSubskillsToPersist: activation
			? candidates.filter(
					candidate =>
						candidate.plugin === activation!.plugin && candidate.activationArg === activation!.activationArg,
				)
			: [],
	};
}

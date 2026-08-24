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
	agentDir?: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	skillName: string;
	args: string;
}): Promise<SubskillActivationResult> {
	const registry = await loadEffectiveGjcPluginRegistry(input.cwd, { agentDir: input.agentDir });
	const candidates: LoadedSubskillActivation[] = [];
	for (const entry of registry) {
		if (!entry.enabled || entry.migration?.status === "failed") continue;
		for (const surface of entry.surfaces.subskills) {
			const validated = await resolveValidatedActiveSubskill({
				cwd: input.cwd,
				agentDir: input.agentDir,
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
	const cleanedTokens: string[] = [];
	let consumed = false;
	for (const token of tokens) {
		if (!consumed && token.startsWith("--") && !token.includes("=")) {
			const candidate = activationsByArg.get(token.slice(2));
			if (candidate) {
				activation = candidate;
				consumed = true;
				continue;
			}
		}
		cleanedTokens.push(token);
	}
	return {
		cleanedArgs: consumed ? cleanedTokens.join(" ") : input.args,
		activation,
		activeSubskillsToPersist: activation
			? candidates.filter(
					candidate =>
						candidate.plugin === activation!.plugin && candidate.activationArg === activation!.activationArg,
				)
			: [],
	};
}

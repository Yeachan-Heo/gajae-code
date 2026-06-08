import {
	assertCoordinatorArtifactPath,
	assertCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	type CoordinatorMutationClass,
	requireCoordinatorMutation,
} from "./policy";

export const COORDINATOR_MUTATION_CLASSES = ["sessions", "questions", "reports"] as const;

export type { CoordinatorMutationClass };

export interface CoordinatorSafetyConfig {
	allowedRoots: string[];
	artifactMaxBytes: number;
	enabledMutationClasses: Set<CoordinatorMutationClass>;
	repo?: string;
	profile?: string;
}

export interface CoordinatorSafetyPolicy {
	config: CoordinatorSafetyConfig;
	resolveWorkdir(input: unknown): Promise<string>;
	resolveArtifactPath(input: unknown): Promise<string>;
	assertMutationAllowed(
		mutationClass: CoordinatorMutationClass,
		args: Record<string, unknown>,
	): { ok: true } | CoordinatorFailure;
}

export interface CoordinatorFailure {
	ok: false;
	reason: string;
	[key: string]: unknown;
}

function toSafetyConfig(config: CoordinatorMcpConfig): CoordinatorSafetyConfig {
	return {
		allowedRoots: config.allowedRoots,
		artifactMaxBytes: config.artifactByteCap,
		enabledMutationClasses: config.mutationClasses,
		repo: config.namespace.repo ?? undefined,
		profile: config.namespace.profile ?? undefined,
	};
}

function toFailure(error: unknown): CoordinatorFailure {
	const message = error instanceof Error ? error.message : String(error);
	const [rawReason, detail] = message.split(":", 2);
	const reason = rawReason.replace(/^coordinator_/, "");
	return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export async function createCoordinatorSafetyPolicy(
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CoordinatorSafetyPolicy> {
	const canonicalConfig = buildCoordinatorMcpConfig(options.env ?? process.env);
	const config = toSafetyConfig(canonicalConfig);
	return {
		config,
		resolveWorkdir(input: unknown): Promise<string> {
			return assertCoordinatorWorkdir(canonicalConfig, input);
		},
		async resolveArtifactPath(input: unknown): Promise<string> {
			return (await assertCoordinatorArtifactPath(canonicalConfig, input)).path;
		},
		assertMutationAllowed(
			mutationClass: CoordinatorMutationClass,
			args: Record<string, unknown>,
		): { ok: true } | CoordinatorFailure {
			try {
				requireCoordinatorMutation(canonicalConfig, mutationClass, args);
				return { ok: true };
			} catch (error) {
				return toFailure(error);
			}
		},
	};
}

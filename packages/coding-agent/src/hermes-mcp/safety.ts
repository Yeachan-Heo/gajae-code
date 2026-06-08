import {
	assertHermesArtifactPath,
	assertHermesWorkdir,
	buildHermesMcpConfig,
	type HermesMcpConfig,
	type HermesMutationClass,
	requireHermesMutation,
} from "./policy";

export const HERMES_MUTATION_CLASSES = ["sessions", "questions", "reports"] as const;

export type { HermesMutationClass };

export interface HermesSafetyConfig {
	allowedRoots: string[];
	artifactMaxBytes: number;
	enabledMutationClasses: Set<HermesMutationClass>;
	repo?: string;
	profile?: string;
}

export interface HermesSafetyPolicy {
	config: HermesSafetyConfig;
	resolveWorkdir(input: unknown): Promise<string>;
	resolveArtifactPath(input: unknown): Promise<string>;
	assertMutationAllowed(
		mutationClass: HermesMutationClass,
		args: Record<string, unknown>,
	): { ok: true } | HermesFailure;
}

export interface HermesFailure {
	ok: false;
	reason: string;
	[key: string]: unknown;
}

function toSafetyConfig(config: HermesMcpConfig): HermesSafetyConfig {
	return {
		allowedRoots: config.allowedRoots,
		artifactMaxBytes: config.artifactByteCap,
		enabledMutationClasses: config.mutationClasses,
		repo: config.namespace.repo ?? undefined,
		profile: config.namespace.profile ?? undefined,
	};
}

function toFailure(error: unknown): HermesFailure {
	const message = error instanceof Error ? error.message : String(error);
	const [rawReason, detail] = message.split(":", 2);
	const reason = rawReason.replace(/^coordinator_/, "");
	return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export async function createHermesSafetyPolicy(options: { env?: NodeJS.ProcessEnv } = {}): Promise<HermesSafetyPolicy> {
	const canonicalConfig = buildHermesMcpConfig(options.env ?? process.env);
	const config = toSafetyConfig(canonicalConfig);
	return {
		config,
		resolveWorkdir(input: unknown): Promise<string> {
			return assertHermesWorkdir(canonicalConfig, input);
		},
		async resolveArtifactPath(input: unknown): Promise<string> {
			return (await assertHermesArtifactPath(canonicalConfig, input)).path;
		},
		assertMutationAllowed(
			mutationClass: HermesMutationClass,
			args: Record<string, unknown>,
		): { ok: true } | HermesFailure {
			try {
				requireHermesMutation(canonicalConfig, mutationClass, args);
				return { ok: true };
			} catch (error) {
				return toFailure(error);
			}
		},
	};
}

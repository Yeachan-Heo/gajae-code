import * as fs from "node:fs/promises";
import * as path from "node:path";

export const HERMES_MUTATION_CLASSES = ["session", "prompt", "question", "report"] as const;

export type HermesMutationClass = (typeof HERMES_MUTATION_CLASSES)[number];

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

function splitEnvList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\n,;]+/)
		.flatMap(part => part.split(path.delimiter))
		.map(part => part.trim())
		.filter(Boolean);
}

async function canonicalizeExisting(input: string): Promise<string> {
	return fs.realpath(path.resolve(input));
}

async function canonicalizeMaybeMissing(input: string): Promise<string> {
	const absolute = path.resolve(input);
	try {
		return await fs.realpath(absolute);
	} catch {
		const parent = path.dirname(absolute);
		const canonicalParent = await fs.realpath(parent);
		return path.join(canonicalParent, path.basename(absolute));
	}
}

function isInsideRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseArtifactMaxBytes(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "65536", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 65536;
	return Math.min(parsed, 1024 * 1024);
}

function parseMutationClasses(value: string | undefined): Set<HermesMutationClass> {
	const enabled = new Set<HermesMutationClass>();
	const normalized = splitEnvList(value).map(part => part.toLowerCase());
	if (normalized.includes("all")) {
		for (const mutationClass of HERMES_MUTATION_CLASSES) enabled.add(mutationClass);
		return enabled;
	}
	for (const part of normalized) {
		if ((HERMES_MUTATION_CLASSES as readonly string[]).includes(part)) enabled.add(part as HermesMutationClass);
	}
	return enabled;
}

async function resolveAllowedRoots(env: NodeJS.ProcessEnv): Promise<string[]> {
	const configured = splitEnvList(env.GJC_HERMES_MCP_WORKDIR_ROOTS);
	const roots: string[] = [];
	for (const root of configured) {
		try {
			roots.push(await canonicalizeExisting(root));
		} catch {
			// Invalid configured roots are ignored so they cannot accidentally widen access.
		}
	}
	return [...new Set(roots)].sort();
}

async function resolveContainedPath(allowedRoots: string[], input: unknown, reason: string): Promise<string> {
	if (typeof input !== "string" || input.trim().length === 0) throw new Error(`${reason}:missing_path`);
	if (allowedRoots.length === 0) throw new Error(`${reason}:empty_allowed_roots`);
	const canonical = await canonicalizeMaybeMissing(input);
	if (!allowedRoots.some(root => isInsideRoot(canonical, root))) throw new Error(reason);
	return canonical;
}

export async function createHermesSafetyPolicy(options: { env?: NodeJS.ProcessEnv } = {}): Promise<HermesSafetyPolicy> {
	const env = options.env ?? process.env;
	const config: HermesSafetyConfig = {
		allowedRoots: await resolveAllowedRoots(env),
		artifactMaxBytes: parseArtifactMaxBytes(env.GJC_HERMES_MCP_ARTIFACT_MAX_BYTES),
		enabledMutationClasses: parseMutationClasses(env.GJC_HERMES_MCP_ENABLE_MUTATION_CLASSES),
		repo: env.GJC_HERMES_MCP_REPO?.trim() || undefined,
		profile: env.GJC_HERMES_MCP_PROFILE?.trim() || undefined,
	};
	return {
		config,
		resolveWorkdir(input: unknown): Promise<string> {
			return resolveContainedPath(config.allowedRoots, input, "workdir_outside_allowed_roots");
		},
		resolveArtifactPath(input: unknown): Promise<string> {
			return resolveContainedPath(config.allowedRoots, input, "artifact_outside_allowed_roots");
		},
		assertMutationAllowed(
			mutationClass: HermesMutationClass,
			args: Record<string, unknown>,
		): { ok: true } | HermesFailure {
			if (!config.enabledMutationClasses.has(mutationClass))
				return { ok: false, reason: "mutation_class_disabled", mutationClass };
			if (args.allow_mutation !== true) return { ok: false, reason: "mutation_not_allowed_for_call", mutationClass };
			return { ok: true };
		},
	};
}

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { coordinatorMcpStateRoot, gjcRoot } from "../gjc-runtime/session-layout";
import {
	DEFAULT_SESSION_IDLE_TTL_MS,
	DEFAULT_SESSION_SWEEP_INTERVAL_MS,
	MIN_SESSION_IDLE_TTL_MS,
	MIN_SESSION_SWEEP_INTERVAL_MS,
} from "./session-reaper";

export type CoordinatorMutationClass = "sessions" | "questions" | "reports";

export interface CoordinatorNamespace {
	profile: string | null;
	repo: string | null;
	identity: string;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("coordinator_namespace_invalid");
}

export function coordinatorNamespaceIdentity(env: NodeJS.ProcessEnv = process.env): string {
	return `ns1_${createHash("sha256")
		.update(
			canonicalJson({
				profile_exact: env.GJC_COORDINATOR_MCP_PROFILE ?? null,
				profile_present: env.GJC_COORDINATOR_MCP_PROFILE !== undefined,
				repo_exact: env.GJC_COORDINATOR_MCP_REPO ?? null,
				repo_present: env.GJC_COORDINATOR_MCP_REPO !== undefined,
			}),
		)
		.digest("hex")
		.slice(0, 32)}`;
}

export interface CoordinatorMcpConfig {
	allowedRoots: string[];
	mutationClasses: Set<CoordinatorMutationClass>;
	artifactByteCap: number;
	namespace: CoordinatorNamespace;
	stateRoot: string;
	sessionCommand: string | null;
	sessionIdleTtlMs: number;
	sessionSweepIntervalMs: number;
	forceStopEnabled: boolean;
}

export interface CoordinatorMutationRequest {
	allow_mutation?: boolean;
}

const DEFAULT_ARTIFACT_BYTE_CAP = 64 * 1024;
const MAX_ARTIFACT_BYTE_CAP = 1024 * 1024;
const MUTATION_CLASSES = new Set<CoordinatorMutationClass>(["sessions", "questions", "reports"]);
const LEGACY_MUTATION_CLASS_ALIASES = new Map<string, CoordinatorMutationClass>([
	["session", "sessions"],
	["prompt", "sessions"],
	["question", "questions"],
	["report", "reports"],
]);

function parsePositiveIntMs(value: string | undefined, fallback: number, floor: number): number {
	const parsed = Number.parseInt((value ?? "").trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.max(floor, parsed);
}

function parseBool(value: string | undefined): boolean {
	return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\n,;:]+/)
		.map(part => part.trim())
		.filter(Boolean);
}

function parseRootList(value: string | undefined): string[] {
	const normalized = (value ?? "").replace(/[\n,;]+/g, path.delimiter);
	return normalized
		.split(path.delimiter)
		.map(part => part.trim())
		.filter(Boolean);
}

function parseMutationClasses(value: string | undefined): Set<CoordinatorMutationClass> {
	const classes = new Set<CoordinatorMutationClass>();
	for (const raw of parseList(value)) {
		const normalized = raw.toLowerCase();
		if (normalized === "all") {
			for (const mutationClass of MUTATION_CLASSES) classes.add(mutationClass);
			continue;
		}
		const mutationClass = LEGACY_MUTATION_CLASS_ALIASES.get(normalized) ?? normalized;
		if (MUTATION_CLASSES.has(mutationClass as CoordinatorMutationClass))
			classes.add(mutationClass as CoordinatorMutationClass);
	}
	return classes;
}

function parseByteCap(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ARTIFACT_BYTE_CAP;
	return Math.min(parsed, MAX_ARTIFACT_BYTE_CAP);
}

function cleanScope(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 100) || null;
}

function defaultCoordinatorMcpStateRoot(cwd: string, gjcSessionId?: string): string {
	return gjcSessionId
		? coordinatorMcpStateRoot(cwd, gjcSessionId)
		: path.join(gjcRoot(cwd), "state", "coordinator-mcp");
}

export function buildCoordinatorMcpConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorMcpConfig {
	const stateRootOverride = env.GJC_COORDINATOR_MCP_STATE_ROOT?.trim();
	const gjcSessionId = env.GJC_SESSION_ID?.trim();
	const stateRoot = stateRootOverride || defaultCoordinatorMcpStateRoot(process.cwd(), gjcSessionId);
	return {
		allowedRoots: parseRootList(env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS).map(root => path.resolve(root)),
		mutationClasses: parseMutationClasses(
			env.GJC_COORDINATOR_MCP_MUTATIONS ?? env.GJC_COORDINATOR_MCP_ENABLE_MUTATION_CLASSES,
		),
		artifactByteCap: parseByteCap(
			env.GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP ?? env.GJC_COORDINATOR_MCP_ARTIFACT_MAX_BYTES,
		),
		namespace: {
			profile: cleanScope(env.GJC_COORDINATOR_MCP_PROFILE),
			repo: cleanScope(env.GJC_COORDINATOR_MCP_REPO),
			identity: coordinatorNamespaceIdentity(env),
		},
		stateRoot: path.resolve(stateRoot),
		sessionCommand: env.GJC_COORDINATOR_MCP_SESSION_COMMAND?.trim() || null,
		sessionIdleTtlMs: parsePositiveIntMs(
			env.GJC_COORDINATOR_MCP_SESSION_IDLE_TTL_MS,
			DEFAULT_SESSION_IDLE_TTL_MS,
			MIN_SESSION_IDLE_TTL_MS,
		),
		sessionSweepIntervalMs: parsePositiveIntMs(
			env.GJC_COORDINATOR_MCP_SESSION_SWEEP_INTERVAL_MS,
			DEFAULT_SESSION_SWEEP_INTERVAL_MS,
			MIN_SESSION_SWEEP_INTERVAL_MS,
		),
		forceStopEnabled: parseBool(env.GJC_COORDINATOR_MCP_FORCE_STOP),
	};
}

async function realpathIfExists(value: string): Promise<string> {
	let current = path.resolve(value);
	const missing: string[] = [];
	while (true) {
		try {
			const canonical = await fs.realpath(current);
			return path.join(canonical, ...missing.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function isInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalAllowedRoots(config: CoordinatorMcpConfig): Promise<string[]> {
	const roots = await Promise.all(config.allowedRoots.map(root => realpathIfExists(root)));
	return roots.map(root => path.resolve(root));
}

export async function assertCoordinatorWorkdir(config: CoordinatorMcpConfig, cwd: unknown): Promise<string> {
	if (typeof cwd !== "string" || cwd.trim().length === 0) throw new Error("coordinator_workdir_required");
	if (config.allowedRoots.length === 0) throw new Error("coordinator_workdir_roots_required");
	const requested = path.resolve(cwd);
	const canonicalRequested = await realpathIfExists(requested);
	const roots = await canonicalAllowedRoots(config);
	if (!roots.some(root => isInside(canonicalRequested, root))) {
		throw new Error(`coordinator_workdir_outside_allowed_roots:${requested}`);
	}
	return requested;
}

export async function assertCoordinatorArtifactPath(
	config: CoordinatorMcpConfig,
	artifactPath: unknown,
): Promise<{ path: string; byteCap: number }> {
	if (typeof artifactPath !== "string" || artifactPath.trim().length === 0)
		throw new Error("coordinator_artifact_path_required");
	if (config.allowedRoots.length === 0) throw new Error("coordinator_artifact_roots_required");
	const requested = path.resolve(artifactPath);
	const canonicalRequested = await realpathIfExists(requested);
	const canonicalStateRoot = await realpathIfExists(config.stateRoot);
	if (isInside(canonicalRequested, canonicalStateRoot)) throw new Error("coordinator_artifact_state_root_denied");
	const roots = await canonicalAllowedRoots(config);
	if (!roots.some(root => isInside(canonicalRequested, root))) {
		throw new Error(`coordinator_artifact_outside_allowed_roots:${requested}`);
	}
	return { path: requested, byteCap: config.artifactByteCap };
}

export function requireCoordinatorMutation(
	config: CoordinatorMcpConfig,
	mutationClass: CoordinatorMutationClass,
	request: CoordinatorMutationRequest,
): void {
	if (!config.mutationClasses.has(mutationClass))
		throw new Error(`coordinator_mutation_class_disabled:${mutationClass}`);
	if (request.allow_mutation !== true) throw new Error(`coordinator_mutation_call_not_allowed:${mutationClass}`);
}

export function coordinatorNamespacePath(config: CoordinatorMcpConfig): string {
	return path.join(config.stateRoot, "v1", config.namespace.identity);
}

/** Opens and authorizes an artifact by the opened handle identity, not a racy pathname. */
export async function safeOpenCoordinatorArtifact(
	config: CoordinatorMcpConfig,
	artifactPath: unknown,
): Promise<fs.FileHandle> {
	if (typeof artifactPath !== "string" || artifactPath.trim().length === 0)
		throw new Error("coordinator_artifact_path_required");
	if (config.allowedRoots.length === 0) throw new Error("coordinator_artifact_roots_required");
	if (process.platform !== "linux") throw new Error("artifact_identity_unavailable");
	const requested = path.resolve(artifactPath);
	await assertCoordinatorArtifactPath(config, requested);
	const handle = await fs.open(requested, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new Error("artifact_identity_unavailable");
		const canonicalTarget = await fs.realpath(`/proc/self/fd/${handle.fd}`);
		const canonicalStateRoot = await realpathIfExists(config.stateRoot);
		const roots = await canonicalAllowedRoots(config);
		if (isInside(canonicalTarget, canonicalStateRoot)) throw new Error("coordinator_artifact_state_root_denied");
		if (!roots.some(root => isInside(canonicalTarget, root)))
			throw new Error(`coordinator_artifact_outside_allowed_roots:${requested}`);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

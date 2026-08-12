import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";

import * as path from "node:path";
import {
	assertCoordinatorWorkdir as assertPolicyCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	type CoordinatorMutationClass,
	coordinatorNamespaceIdentity,
} from "../coordinator-mcp/policy";

export const COORDINATOR_AUTHORITY_VERSION = 1 as const;

export type FrozenCoordinatorEnv = Readonly<NodeJS.ProcessEnv>;

export interface FrozenCoordinatorAuthority {
	readonly version: typeof COORDINATOR_AUTHORITY_VERSION;
	readonly env: FrozenCoordinatorEnv;
	readonly config: CoordinatorMcpConfig;
	readonly allowedRoots: readonly string[];
	readonly mutationClasses: readonly CoordinatorMutationClass[];
	readonly stateRoot: string;
	readonly namespace: Readonly<CoordinatorMcpConfig["namespace"]>;
	readonly sessionCommand: string | null;
	readonly fingerprint: string;
}

export type CoordinatorAuthority = FrozenCoordinatorAuthority;

export class CoordinatorAuthorityError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.name = "CoordinatorAuthorityError";
		this.code = code;
	}
}
export const MasterCoordinatorAuthorityError = CoordinatorAuthorityError;

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}

	throw new CoordinatorAuthorityError(
		"authority_value_invalid",
		"Coordinator authority contains an unserializable value.",
	);
}

function digestAuthority(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function copyEnv(env: NodeJS.ProcessEnv): FrozenCoordinatorEnv {
	return Object.freeze({ ...env });
}

function requireExplicitStateRoot(env: NodeJS.ProcessEnv): string {
	const value = env.GJC_COORDINATOR_MCP_STATE_ROOT?.trim();
	if (!value)
		throw new CoordinatorAuthorityError(
			"state_root_required",
			"GJC_COORDINATOR_MCP_STATE_ROOT must be explicitly set.",
		);
	return value;
}

async function realpathIfExists(value: string): Promise<string> {
	let current = path.resolve(value);
	const suffix: string[] = [];
	while (true) {
		try {
			const canonical = await fs.realpath(current);
			return path.join(canonical, ...suffix.reverse());
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

async function canonicalRoot(value: string): Promise<string> {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new CoordinatorAuthorityError("workdir_roots_required", "Coordinator workdir roots must be nonempty.");
	const resolved = path.resolve(value);
	const canonical = await realpathIfExists(resolved);
	let stat: Stats;

	try {
		stat = await fs.lstat(resolved);
	} catch (error) {
		if (isNodeError(error, "ENOENT"))
			throw new CoordinatorAuthorityError(
				"workdir_root_missing",
				`Coordinator workdir root does not exist: ${resolved}`,
			);
		throw error;
	}
	if (!stat.isDirectory())
		throw new CoordinatorAuthorityError(
			"workdir_root_not_directory",
			`Coordinator workdir root is not a directory: ${resolved}`,
		);
	return canonical;
}

async function canonicalStateRoot(value: string): Promise<string> {
	const resolved = path.resolve(value);
	const canonical = await realpathIfExists(resolved);
	try {
		const stat = await fs.lstat(resolved);
		if (stat.isSymbolicLink())
			throw new CoordinatorAuthorityError(
				"state_root_symlink",
				"Coordinator state root must not be a symbolic link.",
			);
		if (!stat.isDirectory())
			throw new CoordinatorAuthorityError("state_root_not_directory", "Coordinator state root must be a directory.");
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
		const parent = path.dirname(resolved);
		const parentStat = await fs.lstat(parent).catch(parentError => {
			if (isNodeError(parentError, "ENOENT")) return null;
			throw parentError;
		});
		if (parentStat === null || !parentStat.isDirectory() || parentStat.isSymbolicLink())
			throw new CoordinatorAuthorityError(
				"state_root_parent_invalid",
				"Coordinator state root parent must be a real private directory.",
			);
	}
	return canonical;
}

function authorityFingerprintInput(
	allowedRoots: readonly string[],
	mutationClasses: readonly CoordinatorMutationClass[],
	stateRoot: string,
	namespace: CoordinatorMcpConfig["namespace"],
	sessionCommand: string | null,
): Record<string, unknown> {
	return {
		version: COORDINATOR_AUTHORITY_VERSION,
		allowedRoots: [...allowedRoots].sort(),
		mutationClasses: [...mutationClasses].sort(),
		stateRoot,
		namespace: {
			profile: namespace.profile,
			repo: namespace.repo,
			identity: namespace.identity,
		},
		sessionCommand,
	};
}

export function coordinatorAuthorityFingerprint(
	authority: Pick<
		FrozenCoordinatorAuthority,
		"allowedRoots" | "mutationClasses" | "stateRoot" | "namespace" | "sessionCommand"
	>,
): string {
	return digestAuthority(
		authorityFingerprintInput(
			authority.allowedRoots,
			authority.mutationClasses,
			authority.stateRoot,
			authority.namespace,
			authority.sessionCommand,
		),
	);
}

export const computeCoordinatorAuthorityFingerprint = coordinatorAuthorityFingerprint;
export const fingerprintCoordinatorAuthority = coordinatorAuthorityFingerprint;

export async function freezeCoordinatorAuthority(
	env: NodeJS.ProcessEnv = process.env,
): Promise<FrozenCoordinatorAuthority> {
	const frozenEnv = copyEnv(env);
	const explicitStateRoot = requireExplicitStateRoot(frozenEnv as NodeJS.ProcessEnv);
	const rawRoots = (frozenEnv.GJC_COORDINATOR_MCP_WORKDIR_ROOTS ?? "")
		.replace(/[\n,;]+/g, path.delimiter)
		.split(path.delimiter)
		.map(value => value.trim())
		.filter(value => value.length > 0);
	if (rawRoots.length === 0)
		throw new CoordinatorAuthorityError(
			"workdir_roots_required",
			"GJC_COORDINATOR_MCP_WORKDIR_ROOTS must contain at least one root.",
		);
	const config = buildCoordinatorMcpConfig(frozenEnv as NodeJS.ProcessEnv);
	const mutationClasses = [...config.mutationClasses].sort();
	if (!mutationClasses.includes("sessions"))
		throw new CoordinatorAuthorityError(
			"sessions_mutation_required",
			"Coordinator sessions mutation authority is required.",
		);
	const allowedRoots = [...new Set(await Promise.all(rawRoots.map(root => canonicalRoot(root))))].sort();
	if (allowedRoots.length === 0)
		throw new CoordinatorAuthorityError("workdir_roots_required", "Coordinator workdir roots must be nonempty.");
	const stateRoot = await canonicalStateRoot(explicitStateRoot);
	const namespace = {
		profile: config.namespace.profile,
		repo: config.namespace.repo,
		identity: coordinatorNamespaceIdentity(frozenEnv as NodeJS.ProcessEnv),
	};
	const fingerprint = coordinatorAuthorityFingerprint({
		allowedRoots,
		mutationClasses,
		stateRoot,
		namespace,
		sessionCommand: config.sessionCommand,
	});
	const frozenConfig: CoordinatorMcpConfig = {
		...config,
		allowedRoots: [...allowedRoots],
		mutationClasses: new Set(mutationClasses),
		namespace,
		stateRoot,
	};
	return Object.freeze({
		version: COORDINATOR_AUTHORITY_VERSION,
		env: frozenEnv,
		config: frozenConfig,
		allowedRoots,
		mutationClasses,
		stateRoot,
		namespace: Object.freeze(namespace),
		sessionCommand: config.sessionCommand,
		fingerprint,
	});
}

export const buildFrozenCoordinatorAuthority = freezeCoordinatorAuthority;
export const createFrozenCoordinatorAuthority = freezeCoordinatorAuthority;
export const loadCoordinatorAuthority = freezeCoordinatorAuthority;
export const buildCoordinatorAuthority = freezeCoordinatorAuthority;
export const createCoordinatorAuthority = freezeCoordinatorAuthority;
export const validateCoordinatorAuthority = freezeCoordinatorAuthority;

export function assertAuthorityFingerprint(authority: FrozenCoordinatorAuthority, fingerprint: unknown): void {
	if (typeof fingerprint !== "string" || fingerprint !== authority.fingerprint)
		throw new CoordinatorAuthorityError(
			"authority_fingerprint_mismatch",
			"Coordinator authority fingerprint does not match the frozen authority.",
		);
}

export async function verifyCoordinatorAuthority(
	authority: FrozenCoordinatorAuthority,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	try {
		const current = await freezeCoordinatorAuthority(env);
		return current.fingerprint === authority.fingerprint;
	} catch {
		return false;
	}
}

export async function assertCoordinatorAuthorityUnchanged(
	authority: FrozenCoordinatorAuthority,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!(await verifyCoordinatorAuthority(authority, env)))
		throw new CoordinatorAuthorityError(
			"authority_changed",
			"Coordinator authority is missing or changed from the frozen boot authority.",
		);
}

export const assertAuthorityUnchanged = assertCoordinatorAuthorityUnchanged;

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!!relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertCanonicalCoordinatorWorkdir(
	authority: FrozenCoordinatorAuthority,
	cwd: unknown,
): Promise<string> {
	if (typeof cwd !== "string" || cwd.trim().length === 0)
		throw new CoordinatorAuthorityError("workdir_required", "Coordinator workdir is required.");
	const requested = path.resolve(cwd);
	let stat: Stats;
	try {
		stat = await fs.lstat(requested);
	} catch (error) {
		if (isNodeError(error, "ENOENT"))
			throw new CoordinatorAuthorityError("workdir_missing", `Coordinator workdir does not exist: ${requested}`);
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new CoordinatorAuthorityError(
			"workdir_symlink_or_not_directory",
			"Coordinator workdir must be a real directory, not a symlink.",
		);
	const canonical = await fs.realpath(requested);
	if (canonical !== requested)
		throw new CoordinatorAuthorityError("workdir_symlink", "Coordinator workdir must use its canonical realpath.");
	if (!authority.allowedRoots.some(root => isWithin(root, canonical)))
		throw new CoordinatorAuthorityError(
			"workdir_outside_allowed_roots",
			`Coordinator workdir is outside the frozen roots: ${requested}`,
		);
	return canonical;
}

export const assertAdmittedCoordinatorWorkdir = assertCanonicalCoordinatorWorkdir;
export const assertCoordinatorAuthorityWorkdir = assertCanonicalCoordinatorWorkdir;

export async function assertCoordinatorWorkdirWithFrozenAuthority(
	authority: FrozenCoordinatorAuthority,
	cwd: unknown,
): Promise<string> {
	await assertCoordinatorAuthorityUnchanged(authority);
	const canonical = await assertCanonicalCoordinatorWorkdir(authority, cwd);
	const configured = await assertPolicyCoordinatorWorkdir(authority.config, canonical);
	if (configured !== canonical)
		throw new CoordinatorAuthorityError(
			"workdir_canonicalization_mismatch",
			"Coordinator did not preserve the frozen canonical workdir.",
		);
	return canonical;
}
export const assertCoordinatorWorkdir = assertCanonicalCoordinatorWorkdir;

export function isCoordinatorAuthority(value: unknown): value is FrozenCoordinatorAuthority {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<FrozenCoordinatorAuthority>;
	return (
		candidate.version === COORDINATOR_AUTHORITY_VERSION &&
		typeof candidate.fingerprint === "string" &&
		Array.isArray(candidate.allowedRoots) &&
		typeof candidate.stateRoot === "string"
	);
}

export function assertFrozenCoordinatorAuthority(value: unknown): asserts value is FrozenCoordinatorAuthority {
	if (!isCoordinatorAuthority(value))
		throw new CoordinatorAuthorityError(
			"authority_invalid",
			"Coordinator authority is not a validated frozen authority.",
		);
	const authority = value;
	if (!authority.env.GJC_COORDINATOR_MCP_STATE_ROOT?.trim())
		throw new CoordinatorAuthorityError("authority_invalid", "Coordinator authority state root is not explicit.");
	if (authority.allowedRoots.length === 0 || !authority.mutationClasses.includes("sessions"))
		throw new CoordinatorAuthorityError(
			"authority_invalid",
			"Coordinator authority is missing required session roots or mutation capability.",
		);
	if (coordinatorAuthorityFingerprint(authority) !== authority.fingerprint)
		throw new CoordinatorAuthorityError(
			"authority_fingerprint_mismatch",
			"Coordinator authority fingerprint is invalid.",
		);
}

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	type GuardedWriteResult,
	readExistingStateForMutation,
	StatePublicationUncertainError,
	StateWriteConflictError,
	withWorkflowStateLock,
	writeGuardedJsonAtomic,
} from "../../gjc-runtime/state-writer";
import {
	RECEIPT_SCHEMA_VERSION,
	type ReceiptEnvelope,
	type ValidationEvidence,
	validateReceipt,
} from "../../harness-control-plane/receipts";

const text = z
	.string()
	.min(1)
	.refine(value => value.trim().length > 0, "must not be blank");
const counter = z.number().int().nonnegative();
const positiveCounter = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filesystemIdentity = z.string().regex(/^\d+:\d+$/);
const mode = z.enum(["read", "write"]);
export const ManagedPathResourceSchema = z
	.object({
		kind: z.literal("path"),
		path: text,
		mode,
		recursive: z.boolean(),
		namespace: z.boolean(),
	})
	.strict();
export const ManagedNamedResourceSchema = z
	.object({
		kind: z.enum(["database", "integration"]),
		identity: text,
		mode,
	})
	.strict();
export const ManagedPortResourceSchema = z
	.object({
		kind: z.literal("port"),
		protocol: z.enum(["tcp", "udp"]),
		address: z.enum(["*", "0.0.0.0", "::", "127.0.0.1", "::1"]),
		port: z.number().int().min(1).max(65535),
		mode,
	})
	.strict();
export const ManagedResourceSchema = z.union([
	ManagedPathResourceSchema,
	ManagedNamedResourceSchema,
	ManagedPortResourceSchema,
]);
export type ManagedResource = z.infer<typeof ManagedResourceSchema>;
export const ManagedArtifactSchema = z
	.object({
		path: text,
		role: z.enum(["input", "read-write", "output", "validation-output"]),
		presence: z.enum(["required", "optional", "absent"]),
	})
	.strict();
export type ManagedArtifact = z.infer<typeof ManagedArtifactSchema>;
export const ManagedTaskDefinitionSchema = z
	.object({
		id: text,
		task: text,
		workspace: text,
		predecessors: z.array(text),
		criteriaIdentity: digest,
		validations: z.array(z.object({ name: text, command: text }).strict()).min(1),
		resources: z.array(ManagedResourceSchema),
		artifacts: z.array(ManagedArtifactSchema),
	})
	.strict();
export type ManagedTaskDefinition = z.infer<typeof ManagedTaskDefinitionSchema>;
export const ManagedDefinitionRecordSchema = z
	.object({
		revision: positiveCounter,
		hash: digest,
		definition: ManagedTaskDefinitionSchema,
	})
	.strict();
export type ManagedDefinitionRecord = z.infer<typeof ManagedDefinitionRecordSchema>;
export const ManagedManifestEntrySchema = z
	.object({
		path: text,
		object: filesystemIdentity.nullable(),
		kind: z.enum(["absent", "file", "directory"]),
		hash: digest.nullable(),
		mode: z.number().int().min(0).max(0o777).nullable(),
	})
	.strict();
export type ManagedManifestEntry = z.infer<typeof ManagedManifestEntrySchema>;
export type ManagedManifest = ManagedManifestEntry[];
export const ManagedPredecessorSchema = z
	.object({
		nodeId: text,
		taskRevision: positiveCounter,
		attemptId: text,
		verificationId: text,
		verificationHash: digest,
		produced: z.array(ManagedManifestEntrySchema),
	})
	.strict();
export type ManagedPredecessor = z.infer<typeof ManagedPredecessorSchema>;
export const ManagedCanonicalResourceSchema = z
	.object({
		declaration: ManagedResourceSchema,
		path: text.nullable(),
		object: filesystemIdentity.nullable(),
		ancestor: filesystemIdentity.nullable(),
		suffix: z.string().nullable(),
	})
	.strict();
export type ManagedCanonicalResource = z.infer<typeof ManagedCanonicalResourceSchema>;
export const ManagedNativeIdentitySchema = z
	.object({
		key: text,
		identity: digest,
		requestHash: digest,
	})
	.strict();
export type ManagedNativeIdentity = z.infer<typeof ManagedNativeIdentitySchema>;
export const ManagedVerificationObservationSchema = z
	.object({
		name: text,
		command: text,
		cwd: text,
		exitStatus: z.number().int(),
		pass: z.boolean(),
	})
	.strict();
export type ManagedVerificationObservation = z.infer<typeof ManagedVerificationObservationSchema>;
export const ManagedVerificationReceiptSchema = z
	.object({
		id: text,
		hash: digest,
		envelope: z.record(z.string(), z.unknown()),
	})
	.strict();
export type ManagedVerificationReceipt = z.infer<typeof ManagedVerificationReceiptSchema>;
export const ManagedVerificationExecutionSchema = z
	.object({
		executionId: text,
		workspace: text,
		commands: z.array(z.object({ name: text, command: text }).strict()).min(1),
		observations: z.array(ManagedVerificationObservationSchema),
		receipts: z.array(ManagedVerificationReceiptSchema),
	})
	.strict();
export type ManagedVerificationExecution = z.infer<typeof ManagedVerificationExecutionSchema>;
export const ManagedTaskAttemptSchema = z
	.object({
		id: text,
		nodeId: text,
		taskRevision: positiveCounter,
		graphRevision: positiveCounter,
		definitionHash: digest,
		definition: ManagedTaskDefinitionSchema,
		native: ManagedNativeIdentitySchema,
		inputs: z.array(ManagedManifestEntrySchema),
		predecessors: z.array(ManagedPredecessorSchema),
		resources: z.array(ManagedCanonicalResourceSchema),
		produced: z.array(ManagedManifestEntrySchema).nullable(),
		validationImmutable: z.array(ManagedManifestEntrySchema).nullable(),
		validationOutputs: z.array(ManagedManifestEntrySchema).nullable(),
		worker: z.enum(["reserved", "no-effect", "authorized", "unknown", "closed"]),
		validation: z.enum(["not-started", "running", "unknown", "finished"]),
		fence: z.enum(["current", "canceled", "superseded", "failed"]),
		retired: z.boolean(),
		accepted: z.object({ id: text, hash: digest }).strict().nullable(),
		verificationExecution: ManagedVerificationExecutionSchema.nullable(),
	})
	.strict();
export type ManagedTaskAttempt = z.infer<typeof ManagedTaskAttemptSchema>;
export const ManagedTaskGraphSchema = z
	.object({
		id: text,
		owner: text,
		revision: positiveCounter,
		nodes: z.array(ManagedDefinitionRecordSchema).min(1),
		attempts: z.array(ManagedTaskAttemptSchema),
		canceled: z.array(text),
	})
	.strict();
export type ManagedTaskGraph = z.infer<typeof ManagedTaskGraphSchema>;
export const ManagedDomainBindingSchema = z
	.object({
		controlRoot: text,
		rootIdentity: filesystemIdentity,
		agentDir: text,
		agentDirIdentity: filesystemIdentity,
		enrollmentId: text,
		worktrees: z.array(z.object({ path: text, identity: filesystemIdentity }).strict()).min(1),
		aliases: z.array(z.object({ path: text, target: text }).strict()),
	})
	.strict();
export type ManagedDomainBinding = z.infer<typeof ManagedDomainBindingSchema>;
export const ManagedTaskDomainSchema = z
	.object({
		version: z.literal(1),
		state_revision: counter,
		binding: ManagedDomainBindingSchema,
		graphs: z.array(ManagedTaskGraphSchema),
	})
	.strict();
export type ManagedTaskDomain = z.infer<typeof ManagedTaskDomainSchema>;
/**
 * Internal M2 handoff object. It is returned only after a durable M1
 * reservation; M2 must keep it private after verified Broker admission.
 */
export interface ManagedAttemptRef {
	readonly controlRoot: string;
	readonly enrollmentId: string;
	readonly agentDirIdentity: string;
	readonly graphId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly taskRevision: number;
	readonly attemptId: string;
	readonly definitionHash: string;
	readonly criteriaIdentity: string;
	readonly inputIdentity: string;
	readonly predecessorIdentity: string;
	readonly resourceIdentity: string;
	readonly native: ManagedNativeIdentity;
	readonly nativeIdentity: string;
}

export function managedIdentity(value: unknown): string {
	function ordered(v: unknown): unknown {
		if (Array.isArray(v)) return v.map(ordered);
		if (v && typeof v === "object")
			return Object.fromEntries(
				Object.entries(v)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, x]) => [k, ordered(x)]),
			);
		return v;
	}
	return createHash("sha256")
		.update(JSON.stringify(ordered(value)))
		.digest("hex");
}
function requirePolicy(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(`managed-task: ${reason}`);
}
function parseStoredReceiptEnvelope(value: unknown): ReceiptEnvelope<ValidationEvidence> | undefined {
	const parsed = z
		.object({
			receiptId: text,
			schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
			sessionId: text,
			family: z.literal("validation"),
			valid: z.literal(true),
			createdAt: text,
			source: z.literal("managed-task-verification"),
			subject: z
				.object({
					workspace: text,
					branch: z.string().nullable(),
					head: z.string().nullable(),
					commit: z.string().nullable(),
				})
				.strict(),
			evidence: z
				.object({
					command: text,
					exactCommand: text,
					cwd: text,
					exitStatus: z.literal(0),
					pass: z.literal(true),
					commitUnderTest: z.null(),
				})
				.strict(),
			artifactHashes: z.record(z.string(), text),
			sha256: digest,
		})
		.strict()
		.safeParse(value);
	if (!parsed.success) return undefined;
	const envelope: ReceiptEnvelope<ValidationEvidence> = parsed.data;
	if (!validateReceipt(envelope).valid) return undefined;
	return envelope;
}
function trustedStoredAcceptance(attempt: ManagedTaskAttempt): boolean {
	const accepted = attempt.accepted;
	const execution = attempt.verificationExecution;
	if (!accepted || attempt.validation !== "finished" || !execution) return false;
	const stored = execution.receipts.find(receipt => receipt.id === accepted.id && receipt.hash === accepted.hash);
	if (!stored) return false;
	const envelope = parseStoredReceiptEnvelope(stored.envelope);
	return envelope !== undefined && envelope.receiptId === stored.id && envelope.sha256 === stored.hash;
}
export type ManagedEnrollmentRecord = {
	controlRoots: string[];
	establishedRoots: string[];
	publishingRoots: string[];
	nativeIdentities: string[];
	byRoot: Record<string, string[]>;
};
function enrollmentIndexDocument(record: ManagedEnrollmentRecord): {
	version: 1;
	controlRoots: string[];
	establishedRoots: string[];
	publishingRoots: string[];
	nativeIdentities: string[];
	byRoot: Record<string, string[]>;
	state_revision: number;
} {
	const controlRoots = [...record.controlRoots].sort();
	const establishedRoots = [...record.establishedRoots].filter(root => controlRoots.includes(root)).sort();
	const publishingRoots = [...record.publishingRoots]
		.filter(root => controlRoots.includes(root) && !establishedRoots.includes(root))
		.sort();
	const byRoot: Record<string, string[]> = {};
	for (const root of controlRoots) byRoot[root] = [...(record.byRoot[root] ?? [])].sort();
	const nativeIdentities = [
		...new Set([...record.nativeIdentities, ...controlRoots.flatMap(root => byRoot[root] ?? [])]),
	].sort();
	return {
		version: 1,
		controlRoots,
		establishedRoots,
		publishingRoots,
		// Global identities may be accepted without a root mapping; cleanup must retain them.
		nativeIdentities,
		byRoot,
		state_revision: 0,
	};
}
function parseEnrollmentIndex(value: unknown): ManagedEnrollmentRecord {
	const parsed = z
		.object({
			version: z.literal(1),
			controlRoots: z.array(text),
			establishedRoots: z.array(text),
			publishingRoots: z.array(text),
			nativeIdentities: z.array(digest).default([]),
			byRoot: z.record(text, z.array(digest)).default({}),
			state_revision: counter.optional(),
		})
		.strict()
		.parse(value);
	requireDistinct(parsed.controlRoots, "duplicate enrolled control root");
	requirePolicy(parsed.controlRoots.every(isCanonicalAbsolute), "enrolled control root is not canonical");
	requireDistinct(parsed.establishedRoots, "duplicate established control root");
	requireDistinct(parsed.publishingRoots, "duplicate publishing control root");
	requirePolicy(
		parsed.establishedRoots.every(root => parsed.controlRoots.includes(root)),
		"established control root is not enrolled",
	);
	requirePolicy(
		parsed.publishingRoots.every(
			root => parsed.controlRoots.includes(root) && !parsed.establishedRoots.includes(root),
		),
		"publishing control root is not pending",
	);
	const byRoot: Record<string, string[]> = {};
	for (const root of parsed.controlRoots) {
		const ids = parsed.byRoot[root] ?? [];
		requireDistinct(ids, "duplicate enrolled native identity");
		byRoot[root] = ids;
	}
	requireDistinct(Object.values(byRoot).flat(), "native identity belongs to multiple control roots");
	const nativeIdentities = [...new Set([...parsed.nativeIdentities, ...Object.values(byRoot).flat()])];
	requireDistinct(nativeIdentities, "duplicate enrolled native identity");
	return {
		controlRoots: parsed.controlRoots,
		establishedRoots: parsed.establishedRoots,
		publishingRoots: parsed.publishingRoots,
		nativeIdentities,
		byRoot,
	};
}
async function loadEnrollmentIndexUnderLock(target: string): Promise<ManagedEnrollmentRecord> {
	const read = await readExistingStateForMutation(target);
	if (read.kind === "absent")
		return { controlRoots: [], establishedRoots: [], publishingRoots: [], nativeIdentities: [], byRoot: {} };
	requirePolicy(read.kind === "valid", "corrupt managed enrollment index");
	try {
		return parseEnrollmentIndex(read.value);
	} catch {
		throw new Error("corrupt managed enrollment index");
	}
}
export function within(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function objectIdentity(directory: string): Promise<string> {
	const stat = await fs.lstat(directory, { bigint: true });
	requirePolicy(stat.isDirectory() && !stat.isSymbolicLink(), "binding must be a directory");
	return `${stat.dev}:${stat.ino}`;
}

function isCanonicalAbsolute(value: string): boolean {
	return path.isAbsolute(value) && path.normalize(value) === value;
}

function requireDistinct(values: string[], reason: string): void {
	requirePolicy(new Set(values).size === values.length, reason);
}

function comparePathRecords<T extends { path: string }>(left: T, right: T): number {
	return left.path.localeCompare(right.path);
}

function canonicalNamedIdentity(identity: string): string {
	requirePolicy(
		/^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/.test(identity) && !identity.includes("//") && !identity.includes(".."),
		"named resource must have explicit canonical identity",
	);
	return identity;
}

export interface ManagedDomainBindingInput {
	controlRoot: string;
	agentDir: string;
	enrollmentId: string;
	worktrees: string[];
	aliases?: string[];
}

/** Explicit aliases are accepted only while their real target remains the enrolled target. */
export async function createManagedDomainBinding(input: ManagedDomainBindingInput): Promise<ManagedDomainBinding> {
	text.parse(input.enrollmentId);
	const controlRoot = await fs.realpath(input.controlRoot);
	const agentDir = await fs.realpath(input.agentDir);
	const worktrees = (
		await Promise.all(
			input.worktrees.map(async value => {
				const worktree = await fs.realpath(value);
				return { path: worktree, identity: await objectIdentity(worktree) };
			}),
		)
	).sort(comparePathRecords);
	requireDistinct(
		worktrees.map(worktree => worktree.path),
		"duplicate worktree",
	);
	const aliases = (
		await Promise.all(
			(input.aliases ?? []).map(async value => ({
				path: path.resolve(value),
				target: await fs.realpath(value),
			})),
		)
	).sort(comparePathRecords);
	requireDistinct(
		aliases.map(alias => alias.path),
		"duplicate alias",
	);
	requirePolicy(
		aliases.every(a => a.target === controlRoot || worktrees.some(w => w.path === a.target)),
		"alias is not enrolled",
	);
	return ManagedDomainBindingSchema.parse({
		controlRoot,
		rootIdentity: await objectIdentity(controlRoot),
		agentDir,
		agentDirIdentity: await objectIdentity(agentDir),
		enrollmentId: input.enrollmentId,
		worktrees,
		aliases,
	});
}

async function validateBinding(binding: ManagedDomainBinding): Promise<void> {
	requirePolicy(isCanonicalAbsolute(binding.controlRoot), "control root is not canonical");
	requirePolicy(isCanonicalAbsolute(binding.agentDir), "agent directory is not canonical");
	requireDistinct(
		binding.worktrees.map(worktree => worktree.path),
		"duplicate worktree",
	);
	requireDistinct(
		binding.aliases.map(alias => alias.path),
		"duplicate alias",
	);
	requirePolicy(
		binding.worktrees.every(worktree => isCanonicalAbsolute(worktree.path)),
		"worktree is not canonical",
	);
	requirePolicy(
		binding.aliases.every(alias => isCanonicalAbsolute(alias.path) && isCanonicalAbsolute(alias.target)),
		"alias is not canonical",
	);
	requirePolicy(
		(await fs.realpath(binding.controlRoot)) === binding.controlRoot &&
			(await objectIdentity(binding.controlRoot)) === binding.rootIdentity,
		"control root changed",
	);
	requirePolicy(
		(await fs.realpath(binding.agentDir)) === binding.agentDir &&
			(await objectIdentity(binding.agentDir)) === binding.agentDirIdentity,
		"agent directory changed",
	);
	for (const w of binding.worktrees)
		requirePolicy(
			(await fs.realpath(w.path)) === w.path && (await objectIdentity(w.path)) === w.identity,
			"worktree changed",
		);
	for (const alias of binding.aliases) {
		requirePolicy(
			alias.target === binding.controlRoot || binding.worktrees.some(worktree => worktree.path === alias.target),
			"alias is not enrolled",
		);
		requirePolicy((await fs.realpath(alias.path)) === alias.target, "alias changed");
	}
}

async function canonicalPath(
	binding: ManagedDomainBinding,
	supplied: string,
): Promise<{ path: string; object: string | null; ancestor: string; suffix: string }> {
	requirePolicy(isCanonicalAbsolute(supplied), "path must be absolute and normalized");
	let candidate = supplied;
	for (const alias of [...binding.aliases].sort((a, b) => b.path.length - a.path.length)) {
		if (within(alias.path, candidate)) {
			requirePolicy((await fs.realpath(alias.path)) === alias.target, "alias changed");
			candidate = path.join(alias.target, path.relative(alias.path, candidate));
			break;
		}
	}
	const root = binding.worktrees
		.filter(w => within(w.path, candidate))
		.sort((a, b) => b.path.length - a.path.length)[0];
	requirePolicy(root, "path is outside enrolled worktrees");
	let current = root.path;
	let stat = await fs.lstat(current, { bigint: true });
	requirePolicy(stat.isDirectory() && !stat.isSymbolicLink(), "worktree changed");
	let ancestor = `${stat.dev}:${stat.ino}`;
	const segments = path.relative(current, candidate).split(path.sep).filter(Boolean);
	for (let i = 0; i < segments.length; i++) {
		current = path.join(current, segments[i]!);
		try {
			stat = await fs.lstat(current, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			requirePolicy((await fs.realpath(path.dirname(current))) === path.dirname(current), "path ancestor changed");
			return { path: candidate, object: null, ancestor, suffix: segments.slice(i).join(path.sep) };
		}
		requirePolicy(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), "unsupported path alias/type");
		if (i < segments.length - 1) requirePolicy(stat.isDirectory(), "non-directory ancestor");
		ancestor = `${stat.dev}:${stat.ino}`;
	}
	requirePolicy((await fs.realpath(candidate)) === candidate, "path changed");
	return { path: candidate, object: ancestor, ancestor, suffix: "" };
}

export async function canonicalizeManagedResources(
	binding: ManagedDomainBinding,
	declarations: ManagedResource[],
): Promise<ManagedCanonicalResource[]> {
	await validateBinding(binding);
	return Promise.all(
		declarations.map(async value => {
			const declaration = ManagedResourceSchema.parse(value);
			if (declaration.kind === "path") return { declaration, ...(await canonicalPath(binding, declaration.path)) };
			if (declaration.kind !== "port") canonicalNamedIdentity(declaration.identity);
			return { declaration, path: null, object: null, ancestor: null, suffix: null };
		}),
	);
}

function portAddressesOverlap(
	left: z.infer<typeof ManagedPortResourceSchema>["address"],
	right: z.infer<typeof ManagedPortResourceSchema>["address"],
): boolean {
	if (left === right || left === "*" || right === "*") return true;
	const leftV4 = left === "0.0.0.0" || left === "127.0.0.1";
	const rightV4 = right === "0.0.0.0" || right === "127.0.0.1";
	const leftV6 = left === "::" || left === "::1";
	const rightV6 = right === "::" || right === "::1";
	if (left === "0.0.0.0") return rightV4;
	if (right === "0.0.0.0") return leftV4;
	if (left === "::") return rightV6;
	if (right === "::") return leftV6;
	return false;
}

export function managedResourcesOverlap(a: ManagedCanonicalResource, b: ManagedCanonicalResource): boolean {
	const left = ManagedCanonicalResourceSchema.parse(a);
	const right = ManagedCanonicalResourceSchema.parse(b);
	const x = left.declaration,
		y = right.declaration;
	if (x.kind !== y.kind) return false;
	if (x.kind === "path" && y.kind === "path") {
		requirePolicy(
			left.path !== null && right.path !== null && left.ancestor !== null && right.ancestor !== null,
			"invalid canonical path resource",
		);
		return (
			(left.object !== null && left.object === right.object) ||
			left.path === right.path ||
			(left.ancestor === right.ancestor && left.suffix === right.suffix) ||
			(x.recursive && within(left.path, right.path)) ||
			(y.recursive && within(right.path, left.path)) ||
			(x.namespace && within(left.path, right.path)) ||
			(y.namespace && within(right.path, left.path))
		);
	}
	if (x.kind === "port" && y.kind === "port")
		return x.protocol === y.protocol && x.port === y.port && portAddressesOverlap(x.address, y.address);
	return "identity" in x && "identity" in y && x.identity === y.identity;
}
export function managedResourcesConflict(a: ManagedCanonicalResource, b: ManagedCanonicalResource): boolean {
	return (a.declaration.mode === "write" || b.declaration.mode === "write") && managedResourcesOverlap(a, b);
}
export function parseManagedTaskDefinitions(value: unknown): ManagedTaskDefinition[] {
	const nodes = z.array(ManagedTaskDefinitionSchema).min(1).parse(value);
	const ids = new Set(nodes.map(n => n.id));
	requirePolicy(ids.size === nodes.length, "duplicate node");
	for (const node of nodes)
		requireDistinct(
			node.validations.map(validation => validation.name),
			"duplicate validation",
		);
	const visiting = new Set<string>(),
		visited = new Set<string>();
	function visit(id: string): void {
		requirePolicy(!visiting.has(id), "dependency cycle");
		if (visited.has(id)) return;
		visiting.add(id);
		const node = nodes.find(n => n.id === id)!;
		requirePolicy(new Set(node.predecessors).size === node.predecessors.length, "duplicate predecessor");
		for (const predecessor of node.predecessors) {
			requirePolicy(ids.has(predecessor), "missing predecessor");
			visit(predecessor);
		}
		visiting.delete(id);
		visited.add(id);
	}
	for (const node of nodes) visit(node.id);
	return z.array(ManagedTaskDefinitionSchema).parse(JSON.parse(JSON.stringify(nodes)));
}

function canonicalResourceKey(resource: ManagedCanonicalResource): string {
	const declaration = resource.declaration;
	if (declaration.kind === "path") {
		requirePolicy(
			resource.path !== null && resource.ancestor !== null && resource.suffix !== null,
			"invalid canonical path resource",
		);
		return managedIdentity({
			kind: declaration.kind,
			path: resource.path,
			object: resource.object,
			ancestor: resource.ancestor,
			suffix: resource.suffix,
		});
	}
	if (declaration.kind === "port")
		return `${declaration.kind}:${declaration.protocol}:${declaration.address}:${declaration.port}`;
	return `${declaration.kind}:${declaration.identity}`;
}

export function resourceCoversPath(
	resource: ManagedCanonicalResource,
	targetPath: string,
	needed: "read" | "write",
): boolean {
	if (resource.declaration.kind !== "path" || resource.path === null) return false;
	if (needed === "write" && resource.declaration.mode !== "write") return false;
	return resource.path === targetPath || (resource.declaration.recursive && within(resource.path, targetPath));
}
function resourceCoversArtifact(
	resource: ManagedCanonicalResource,
	artifact: { path: string; object: string | null; ancestor: string; suffix: string },
	needed: "read" | "write",
): boolean {
	return resourceCoversPath(resource, artifact.path, needed);
}

function isInsideWorkspace(workspace: string, artifact: string): boolean {
	return workspace === artifact || within(workspace, artifact);
}

async function validateDefinition(binding: ManagedDomainBinding, node: ManagedTaskDefinition): Promise<void> {
	const workspace = await canonicalPath(binding, node.workspace);
	requirePolicy(workspace.object && (await fs.lstat(workspace.path)).isDirectory(), "workspace missing");
	const resources = await canonicalizeManagedResources(binding, node.resources);
	for (const resource of resources) {
		if (resource.declaration.kind === "path") {
			requirePolicy(
				!resource.declaration.namespace || resource.declaration.mode === "write",
				"namespace requires write resource",
			);
		}
	}
	requireDistinct(resources.map(canonicalResourceKey), "duplicate resource");
	const artifacts = await Promise.all(
		node.artifacts.map(async artifact => ({ artifact, canonical: await canonicalPath(binding, artifact.path) })),
	);
	for (let i = 0; i < artifacts.length; i++) {
		const { artifact, canonical } = artifacts[i]!;
		const needed = artifact.role === "input" ? "read" : "write";
		requirePolicy(isInsideWorkspace(workspace.path, canonical.path), "artifact is outside workspace");
		requirePolicy(
			resources.some(resource => resourceCoversArtifact(resource, canonical, needed)),
			"artifact lacks resource declaration",
		);
		if (needed === "write" && (canonical.object === null || artifact.presence === "absent")) {
			const parent = await canonicalPath(binding, path.dirname(canonical.path));
			requirePolicy(
				resources.some(
					resource =>
						resource.declaration.kind === "path" &&
						resource.declaration.mode === "write" &&
						resource.declaration.namespace &&
						resource.path === parent.path,
				),
				"output requires parent namespace write",
			);
		}
		for (const other of artifacts.slice(0, i))
			requirePolicy(
				!(canonical.object && canonical.object === other.canonical.object) &&
					!within(canonical.path, other.canonical.path) &&
					!within(other.canonical.path, canonical.path),
				"overlapping artifact roles",
			);
	}
}

function validateManifest(manifest: ManagedManifest): ManagedManifest {
	const parsed = z.array(ManagedManifestEntrySchema).parse(manifest);
	requireDistinct(
		parsed.map(entry => entry.path),
		"duplicate manifest entry",
	);
	for (const entry of parsed) {
		requirePolicy(isCanonicalAbsolute(entry.path), "manifest path is not canonical");
		if (entry.kind === "absent")
			requirePolicy(
				entry.object === null && entry.hash === null && entry.mode === null,
				"invalid absent manifest entry",
			);
		else
			requirePolicy(
				entry.object !== null && entry.hash !== null && entry.mode !== null,
				"incomplete manifest entry",
			);
	}
	return parsed;
}

export async function captureManagedManifest(binding: ManagedDomainBinding, paths: string[]): Promise<ManagedManifest> {
	await validateBinding(binding);
	const requested = [...new Set(paths)].sort();
	const requestedCanonical = await Promise.all(requested.map(value => canonicalPath(binding, value)));
	const roots = requestedCanonical.filter(
		candidate =>
			!requestedCanonical.some(
				other => other !== candidate && other.object !== null && within(other.path, candidate.path),
			),
	);
	const entries: ManagedManifest = [];
	for (const requestedEntry of roots) {
		const canonical = await canonicalPath(binding, requestedEntry.path);
		if (!canonical.object) {
			entries.push({ path: canonical.path, object: null, kind: "absent", hash: null, mode: null });
			continue;
		}
		const before = await fs.lstat(canonical.path, { bigint: true });
		requirePolicy(
			!before.isSymbolicLink() && (before.isFile() || before.isDirectory()),
			"unsupported manifest path type",
		);
		const directory = before.isDirectory();
		const hash = directory
			? managedIdentity((await fs.readdir(canonical.path)).sort())
			: createHash("sha256")
					.update(await fs.readFile(canonical.path))
					.digest("hex");
		const after = await fs.lstat(canonical.path, { bigint: true });
		requirePolicy(
			before.dev === after.dev &&
				before.ino === after.ino &&
				before.mtimeNs === after.mtimeNs &&
				before.ctimeNs === after.ctimeNs &&
				before.size === after.size,
			"manifest changed during capture",
		);
		entries.push({
			path: canonical.path,
			object: canonical.object,
			kind: directory ? "directory" : "file",
			hash,
			mode: Number(after.mode & 0o777n),
		});
		if (directory) {
			const children = (await fs.readdir(canonical.path)).sort().map(name => path.join(canonical.path, name));
			entries.push(...(await captureManagedManifest(binding, children)));
			const final = await fs.lstat(canonical.path, { bigint: true });
			requirePolicy(
				final.mtimeNs === after.mtimeNs && final.ctimeNs === after.ctimeNs,
				"directory changed during capture",
			);
		}
	}
	return validateManifest(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

export async function assertManagedManifestCurrent(
	binding: ManagedDomainBinding,
	manifest: ManagedManifest,
): Promise<void> {
	const expected = validateManifest(manifest);
	// Directory entries recursively cover their descendants; avoid capturing them twice.
	const roots = expected.filter(
		entry =>
			!expected.some(parent => parent !== entry && parent.kind === "directory" && within(parent.path, entry.path)),
	);
	requirePolicy(
		managedIdentity(
			await captureManagedManifest(
				binding,
				roots.map(entry => entry.path),
			),
		) === managedIdentity(expected),
		"content drift",
	);
}
export function managedTaskDomainPath(controlRoot: string): string {
	return path.join(controlRoot, ".gjc", "managed-task-domain", "state.json");
}
export function managedEnrollmentIndexPath(agentDir: string): string {
	return path.join(agentDir, ".gjc", "managed-task-enrollments", "index.json");
}

export function validateManagedTaskDomain(value: unknown): ManagedTaskDomain {
	const state = ManagedTaskDomainSchema.parse(value);
	requirePolicy(isCanonicalAbsolute(state.binding.controlRoot), "control root is not canonical");
	requirePolicy(isCanonicalAbsolute(state.binding.agentDir), "agent directory is not canonical");
	requireDistinct(
		state.binding.worktrees.map(worktree => worktree.path),
		"duplicate worktree",
	);
	requireDistinct(
		state.binding.aliases.map(alias => alias.path),
		"duplicate alias",
	);
	requirePolicy(new Set(state.graphs.map(g => g.id)).size === state.graphs.length, "duplicate graph");
	const nativeKeys = new Set<string>(),
		nativeIds = new Set<string>();
	const held: ManagedTaskAttempt[] = [];
	for (const graph of state.graphs) {
		parseManagedTaskDefinitions(graph.nodes.map(node => node.definition));
		requirePolicy(new Set(graph.canceled).size === graph.canceled.length, "duplicate canceled node");
		requirePolicy(
			graph.canceled.every(id => graph.nodes.some(n => n.definition.id === id)),
			"unknown canceled node",
		);
		requirePolicy(new Set(graph.attempts.map(a => a.id)).size === graph.attempts.length, "duplicate attempt");
		for (const node of graph.nodes) {
			requirePolicy(node.hash === managedIdentity(node.definition), "definition hash mismatch");
		}
		for (const attempt of graph.attempts) {
			requirePolicy(
				attempt.definitionHash === managedIdentity(attempt.definition) && attempt.nodeId === attempt.definition.id,
				"attempt definition mismatch",
			);
			requirePolicy(attempt.accepted === null || trustedStoredAcceptance(attempt), "untrusted acceptance authority");
			requirePolicy(
				attempt.resources.length === attempt.definition.resources.length &&
					attempt.resources.every(
						(r, i) => managedIdentity(r.declaration) === managedIdentity(attempt.definition.resources[i]),
					),
				"reservation vector mismatch",
			);
			requireDistinct(attempt.resources.map(canonicalResourceKey), "duplicate attempt resource");
			for (const resource of attempt.resources) {
				if (resource.declaration.kind === "path") {
					requirePolicy(
						resource.path && isCanonicalAbsolute(resource.path) && resource.ancestor && resource.suffix !== null,
						"invalid canonical path identity",
					);
					requirePolicy(
						!resource.declaration.namespace || resource.declaration.mode === "write",
						"namespace requires write resource",
					);
				} else
					requirePolicy(
						resource.path === null &&
							resource.object === null &&
							resource.ancestor === null &&
							resource.suffix === null,
						"invalid named identity fields",
					);
			}
			validateManifest(attempt.inputs);
			requireDistinct(
				attempt.predecessors.map(predecessor => predecessor.nodeId),
				"duplicate predecessor vector",
			);
			requirePolicy(
				attempt.predecessors
					.map(p => p.nodeId)
					.sort()
					.join("\0") === [...attempt.definition.predecessors].sort().join("\0"),
				"predecessor vector mismatch",
			);
			for (const predecessor of attempt.predecessors) validateManifest(predecessor.produced);
			if (attempt.produced) validateManifest(attempt.produced);
			if (attempt.validationImmutable) validateManifest(attempt.validationImmutable);
			if (attempt.validationOutputs) validateManifest(attempt.validationOutputs);
			if (attempt.fence === "current")
				requirePolicy(
					graph.nodes.some(
						n =>
							n.definition.id === attempt.nodeId &&
							n.revision === attempt.taskRevision &&
							n.hash === attempt.definitionHash,
					),
					"current attempt definition missing",
				);
			if (attempt.validation !== "not-started")
				requirePolicy(attempt.worker === "closed", "validation requires closed worker");
			if (attempt.validation === "not-started")
				requirePolicy(attempt.verificationExecution === null, "verification execution without start");
			if (attempt.validation !== "not-started")
				requirePolicy(attempt.verificationExecution !== null, "missing verification execution");
			if (attempt.validation === "finished") {
				const observations = attempt.verificationExecution?.observations.length ?? 0;
				const commands = attempt.verificationExecution?.commands.length ?? 0;
				const failed = attempt.fence === "failed";
				requirePolicy(
					failed ? observations > 0 && observations <= commands : observations === commands,
					"unfinished verification observations",
				);
			}
			requirePolicy(
				!nativeKeys.has(attempt.native.key) && !nativeIds.has(attempt.native.identity),
				"native identity reused",
			);
			nativeKeys.add(attempt.native.key);
			nativeIds.add(attempt.native.identity);
			if (attempt.retired) requirePolicy(canRetireManagedAttempt(attempt), "unproven retirement");
			if (!attempt.retired) {
				for (const previous of held)
					requirePolicy(
						!attempt.resources.some(a => previous.resources.some(b => managedResourcesConflict(a, b))),
						"conflicting reservations",
					);
				held.push(attempt);
			}
		}
	}
	return state;
}

/**
 * Static schema validation above intentionally does not infer mutable filesystem
 * state. Every durable transaction performs this second binding-aware pass while
 * holding the domain lock, before either user mutation or publication.
 */
async function validateManagedTaskDomainAuthority(
	state: ManagedTaskDomain,
	binding: ManagedDomainBinding,
): Promise<void> {
	requirePolicy(managedIdentity(state.binding) === managedIdentity(binding), "domain binding mismatch");
	await validateBinding(binding);
	for (const graph of state.graphs) {
		for (const node of graph.nodes) await validateDefinition(binding, node.definition);
		for (const attempt of graph.attempts) {
			await validateDefinition(binding, attempt.definition);
			// A produced output may legitimately turn an absent reservation path
			// into a file. Re-canonicalize to reject escapes/aliases, but retain the
			// durable admission vector rather than treating that allowed transition
			// as a reservation rewrite.
			await canonicalizeManagedResources(binding, attempt.definition.resources);
		}
	}
}

export interface ManagedDomainTransactionOptions {
	binding: ManagedDomainBinding;
	expectedRevision?: number;
	/** Only for first enrollment; caller checks its authoritative registration/native journal under this lock. */
	assertNoManagedEvidence?: () => Promise<void>;
	/** Publish a fail-closed marker after definition validation but before the first state write. */
	beforeFirstPublication?: () => Promise<void>;
	/** Runs under the domain lock after the first state is durable, serialized with stale-index reclamation. */
	onFirstPublication?: () => Promise<void>;
	/** Restore pending only when the state writer proves it failed before rename. */
	onFirstPublicationAborted?: () => Promise<void>;
	/** Trusted native/internal observation: reload under the lock and CAS against the live revision. */
	internal?: boolean;
}
/** Trusted internal policy boundary, NOT a public wire parser or receipt/PASS submission API. */
export async function transactManagedTaskDomain<T>(
	options: ManagedDomainTransactionOptions,
	mutation: (state: ManagedTaskDomain) => Promise<T>,
): Promise<{ state: ManagedTaskDomain; result: T }> {
	const binding = ManagedDomainBindingSchema.parse(options.binding);
	if (!options.internal) {
		requirePolicy(options.expectedRevision !== undefined, "expectedRevision is required");
		counter.parse(options.expectedRevision);
	} else requirePolicy(options.assertNoManagedEvidence === undefined, "internal mutation cannot enroll");
	await validateBinding(binding);
	const target = managedTaskDomainPath(binding.controlRoot);
	const writer = { cwd: binding.controlRoot, privateDurable: { directory: path.dirname(target) } };
	return withWorkflowStateLock(
		target,
		async () => {
			await validateBinding(binding);
			const read = await readExistingStateForMutation(target);
			requirePolicy(read.kind !== "corrupt", "corrupt authority");
			const firstPublication = read.kind === "absent";
			let state: ManagedTaskDomain;
			if (read.kind === "absent") {
				requirePolicy(!options.internal, "established authority missing");
				requirePolicy(options.expectedRevision === 0, "established authority missing");
				requirePolicy(
					typeof options.assertNoManagedEvidence === "function",
					"fresh enrollment requires native evidence check",
				);
				await options.assertNoManagedEvidence();
				state = { version: 1, state_revision: 0, binding, graphs: [] };
			} else state = validateManagedTaskDomain(read.value);
			requirePolicy(managedIdentity(state.binding) === managedIdentity(binding), "domain binding mismatch");
			const expectedRevision = options.internal ? state.state_revision : options.expectedRevision!;
			if (state.state_revision !== expectedRevision)
				throw new StateWriteConflictError(target, expectedRevision, state.state_revision);
			await validateManagedTaskDomainAuthority(state, binding);
			const previous = structuredClone(state);
			const result = await mutation(state);
			for (const graph of state.graphs)
				for (const attempt of graph.attempts)
					if (!attempt.retired && canRetireManagedAttempt(attempt)) retireManagedAttempt(attempt);
			requirePolicy(managedIdentity(state.binding) === managedIdentity(binding), "immutable binding changed");
			requirePolicy(state.state_revision === previous.state_revision, "revision belongs to source CAS");
			for (const graph of previous.graphs) {
				const next = state.graphs.find(g => g.id === graph.id);
				requirePolicy(
					next && next.owner === graph.owner && next.revision >= graph.revision,
					"graph history/owner changed",
				);
				for (const attempt of graph.attempts) {
					const updated = next.attempts.find(a => a.id === attempt.id);
					requirePolicy(updated, "attempt history removed");
					const immutable = (a: ManagedTaskAttempt) => [
						a.id,
						a.nodeId,
						a.taskRevision,
						a.graphRevision,
						a.definitionHash,
						a.definition,
						a.native,
						a.inputs,
						a.predecessors,
						a.resources,
					];
					requirePolicy(
						managedIdentity(immutable(updated)) === managedIdentity(immutable(attempt)),
						"immutable attempt changed",
					);
					requirePolicy(!attempt.retired || updated.retired, "retired attempt revived");
					requirePolicy(attempt.fence === "current" || updated.fence !== "current", "fenced attempt revived");
				}
			}
			const previousAccepted = new Map(
				previous.graphs.flatMap(graph =>
					graph.attempts.map(attempt => [`${graph.id}\0${attempt.id}`, attempt.accepted] as const),
				),
			);
			for (const graph of state.graphs)
				for (const attempt of graph.attempts) {
					const prior = previousAccepted.get(`${graph.id}\0${attempt.id}`) ?? null;
					if (managedIdentity(attempt.accepted) === managedIdentity(prior)) continue;
					requirePolicy(prior === null && attempt.accepted !== null, "acceptance cannot be rewritten");
					const accepted = attempt.accepted;
					requirePolicy(
						attempt.fence === "current" && attempt.validation === "finished" && attempt.worker === "closed",
						"acceptance requires current finished closed attempt",
					);
					requirePolicy(
						attempt.verificationExecution?.receipts.some(
							receipt => receipt.id === accepted.id && receipt.hash === accepted.hash,
						) === true,
						"acceptance missing stored receipt",
					);
				}
			validateManagedTaskDomain(state);
			await validateManagedTaskDomainAuthority(state, binding);
			if (firstPublication) await options.beforeFirstPublication?.();
			let written: GuardedWriteResult;
			try {
				written = await writeGuardedJsonAtomic(target, state, {
					...writer,
					policy: "source",
					expectedRevision,
					lockHeld: true,
				});
			} catch (caught) {
				if (firstPublication && caught instanceof StatePublicationUncertainError) {
					const published = await readExistingStateForMutation(target);
					if (published.kind === "valid") {
						try {
							const state = validateManagedTaskDomain(published.value);
							if (managedIdentity(state.binding) === managedIdentity(binding))
								await options.onFirstPublication?.();
						} catch {
							// Keep the publishing marker when the read-back cannot prove this domain.
						}
					}
					// Missing or corrupt after a rename attempt is deliberately retained as publishing.
				} else if (firstPublication) {
					await options.onFirstPublicationAborted?.();
				}
				throw caught;
			}
			requirePolicy(written.written, "source publication skipped");
			if (firstPublication) await options.onFirstPublication?.();
			return { state: validateManagedTaskDomain(written.stamped), result };
		},
		writer,
	);
}
export async function defineManagedTaskGraph(
	state: ManagedTaskDomain,
	input: { id: string; owner: string; nodes: unknown },
): Promise<ManagedTaskGraph> {
	text.parse(input.id);
	text.parse(input.owner);
	requirePolicy(!state.graphs.some(g => g.id === input.id), "graph already exists");
	const nodes = parseManagedTaskDefinitions(input.nodes);
	for (const node of nodes) await validateDefinition(state.binding, node);
	const graph: ManagedTaskGraph = {
		id: input.id,
		owner: input.owner,
		revision: 1,
		nodes: nodes.map(definition => ({ revision: 1, hash: managedIdentity(definition), definition })),
		attempts: [],
		canceled: [],
	};
	state.graphs.push(graph);
	return graph;
}
function predecessorVector(graph: ManagedTaskGraph, node: ManagedTaskDefinition): ManagedPredecessor[] | null {
	const result: ManagedPredecessor[] = [];
	for (const id of [...node.predecessors].sort()) {
		const definition = graph.nodes.find(n => n.definition.id === id)!;
		const attempt = graph.attempts.find(
			a =>
				a.nodeId === id &&
				a.taskRevision === definition.revision &&
				a.definitionHash === definition.hash &&
				a.fence === "current" &&
				a.accepted,
		);
		if (!attempt?.accepted || !attempt.produced) return null;
		result.push({
			nodeId: id,
			taskRevision: attempt.taskRevision,
			attemptId: attempt.id,
			verificationId: attempt.accepted.id,
			verificationHash: attempt.accepted.hash,
			produced: attempt.produced,
		});
	}
	return result;
}
export function readyManagedTasks(graph: ManagedTaskGraph): string[] {
	return graph.nodes
		.filter(
			n =>
				!graph.canceled.includes(n.definition.id) &&
				predecessorVector(graph, n.definition) !== null &&
				!graph.attempts.some(
					a =>
						a.nodeId === n.definition.id &&
						(!a.retired || (a.taskRevision === n.revision && a.fence === "current" && a.accepted)),
				),
		)
		.map(n => n.definition.id)
		.sort();
}
function existingExactManagedAttempt(
	graph: ManagedTaskGraph,
	input: { owner: string; nodeId: string; attemptId: string; native: ManagedNativeIdentity },
): ManagedTaskAttempt | undefined {
	return graph.attempts.find(
		attempt =>
			!attempt.retired &&
			attempt.nodeId === input.nodeId &&
			attempt.id === input.attemptId &&
			attempt.native.key === input.native.key &&
			attempt.native.identity === input.native.identity &&
			attempt.native.requestHash === input.native.requestHash,
	);
}
/** Exact same-key retry observes the original reservation; otherwise admits a new one. */
export async function observeOrAdmitManagedTask(
	state: ManagedTaskDomain,
	input: { graphId: string; owner: string; nodeId: string; attemptId: string; native: ManagedNativeIdentity },
): Promise<ManagedAttemptRef> {
	const graph = state.graphs.find(g => g.id === input.graphId);
	requirePolicy(graph && graph.owner === input.owner, "graph owner mismatch");
	ManagedNativeIdentitySchema.parse(input.native);
	const existing = existingExactManagedAttempt(graph, input);
	if (existing) {
		const node = graph.nodes.find(n => n.definition.id === input.nodeId);
		requirePolicy(node, "node missing");
		requirePolicy(!graph.canceled.includes(input.nodeId), "node is canceled");
		requirePolicy(existing.fence === "current", "managed attempt is fenced");
		requirePolicy(
			existing.taskRevision === node.revision && existing.definitionHash === node.hash,
			"managed native vector changed",
		);
		requirePolicy(existing.definition.workspace === node.definition.workspace, "workspace changed");
		return managedAttemptRefFromState(state, existing, graph.id);
	}
	return admitManagedTask(state, input);
}
/** Caller supplies native deriveIdempotencyIdentity result only after authenticated admission. No native effect here. */
export async function admitManagedTask(
	state: ManagedTaskDomain,
	input: { graphId: string; owner: string; nodeId: string; attemptId: string; native: ManagedNativeIdentity },
): Promise<ManagedAttemptRef> {
	const graph = state.graphs.find(g => g.id === input.graphId);
	requirePolicy(graph && graph.owner === input.owner, "graph owner mismatch");
	requirePolicy(readyManagedTasks(graph).includes(input.nodeId), "node not ready");
	text.parse(input.attemptId);
	ManagedNativeIdentitySchema.parse(input.native);
	requirePolicy(
		!state.graphs.some(g =>
			g.attempts.some(
				a =>
					a.native.key === input.native.key ||
					a.native.identity === input.native.identity ||
					(g.id === graph.id && a.id === input.attemptId),
			),
		),
		"attempt/native identity already reserved",
	);
	const node = graph.nodes.find(n => n.definition.id === input.nodeId)!;
	await validateDefinition(state.binding, node.definition);
	const predecessors = predecessorVector(graph, node.definition)!;
	for (const predecessor of predecessors) await assertManagedManifestCurrent(state.binding, predecessor.produced);
	const resources = await canonicalizeManagedResources(state.binding, node.definition.resources);
	for (const g of state.graphs)
		for (const attempt of g.attempts.filter(a => !a.retired)) {
			const current = await canonicalizeManagedResources(
				state.binding,
				attempt.resources.map(r => r.declaration),
			);
			requirePolicy(
				!resources.some(a => [...attempt.resources, ...current].some(b => managedResourcesConflict(a, b))),
				"resource conflict",
			);
		}
	for (const predecessor of predecessors)
		for (const entry of predecessor.produced) {
			const consumed = await canonicalizeManagedResources(state.binding, [
				{ kind: "path", path: entry.path, recursive: entry.kind === "directory", namespace: false, mode: "read" },
			]);
			requirePolicy(
				!resources.some(r => managedResourcesConflict(r, consumed[0]!)),
				"successor overwrites predecessor output",
			);
			requirePolicy(
				resources.some(
					r =>
						r.declaration.kind === "path" &&
						r.declaration.mode === "read" &&
						(r.path === entry.path || (r.declaration.recursive && within(r.path!, entry.path))),
				),
				"consumed predecessor lacks read reservation",
			);
		}
	const inputPaths = [
		...new Set([
			...node.definition.artifacts.filter(a => a.role !== "validation-output").map(a => a.path),
			...predecessors.flatMap(p => p.produced.map(e => e.path)),
		]),
	];
	const roots = inputPaths.filter(p => !inputPaths.some(other => other !== p && within(other, p)));
	const inputs = await captureManagedManifest(state.binding, roots);
	for (const artifact of node.definition.artifacts) {
		const entry = inputs.find(
			e =>
				e.path ===
				(resources.find(r => r.declaration.kind === "path" && r.declaration.path === artifact.path)?.path ??
					artifact.path),
		);
		if (artifact.role === "input")
			requirePolicy(
				entry &&
					(artifact.presence !== "required" || entry.kind !== "absent") &&
					(artifact.presence !== "absent" || entry.kind === "absent"),
				"input presence contract failed",
			);
	}
	graph.attempts.push({
		id: input.attemptId,
		nodeId: input.nodeId,
		taskRevision: node.revision,
		graphRevision: graph.revision,
		definitionHash: node.hash,
		definition: structuredClone(node.definition),
		native: structuredClone(input.native),
		inputs,
		predecessors,
		resources,
		produced: null,
		validationImmutable: null,
		validationOutputs: null,
		worker: "reserved",
		validation: "not-started",
		fence: "current",
		retired: false,
		accepted: null,
		verificationExecution: null,
	});
	return {
		controlRoot: state.binding.controlRoot,
		enrollmentId: state.binding.enrollmentId,
		agentDirIdentity: state.binding.agentDirIdentity,
		graphId: graph.id,
		graphRevision: graph.revision,
		nodeId: input.nodeId,
		taskRevision: node.revision,
		attemptId: input.attemptId,
		definitionHash: node.hash,
		criteriaIdentity: node.definition.criteriaIdentity,
		inputIdentity: managedIdentity(inputs),
		predecessorIdentity: managedIdentity(predecessors),
		resourceIdentity: managedIdentity(resources),
		native: structuredClone(input.native),
		nativeIdentity: input.native.identity,
	};
}
export function canRetireManagedAttempt(attempt: ManagedTaskAttempt): boolean {
	return (
		(attempt.worker === "no-effect" || attempt.worker === "closed") &&
		(attempt.validation === "not-started" || attempt.validation === "finished") &&
		(attempt.fence !== "current" || attempt.accepted !== null)
	);
}
export function retireManagedAttempt(attempt: ManagedTaskAttempt): void {
	requirePolicy(canRetireManagedAttempt(attempt), "effect lifetime still held");
	attempt.retired = true;
}
/** Invalidation never releases reservations or rewrites old immutable attempts. */
export function cancelManagedTasks(graph: ManagedTaskGraph, ids: string[]): string[] {
	requirePolicy(
		ids.every(id => graph.nodes.some(n => n.definition.id === id)),
		"unknown cancellation node",
	);
	const affected = downstreamClosure(
		ids,
		graph.nodes.map(n => n.definition),
	);
	graph.canceled = [...new Set([...graph.canceled, ...affected])].sort();
	for (const attempt of graph.attempts)
		if (affected.has(attempt.nodeId) && attempt.fence === "current") attempt.fence = "canceled";
	return [...affected].sort();
}
function definitionVector(definition: ManagedTaskDefinition): unknown {
	return {
		task: definition.task,
		workspace: definition.workspace,
		criteriaIdentity: definition.criteriaIdentity,
		predecessors: [...definition.predecessors].sort(),
		resources: definition.resources,
		artifacts: definition.artifacts,
		validations: definition.validations,
	};
}
function downstreamClosure(ids: string[], definitions: ManagedTaskDefinition[]): Set<string> {
	const affected = new Set(ids);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of definitions)
			if (!affected.has(node.id) && node.predecessors.some(p => affected.has(p))) {
				affected.add(node.id);
				changed = true;
			}
	}
	return affected;
}
export async function reviseManagedTaskGraph(
	state: ManagedTaskDomain,
	graph: ManagedTaskGraph,
	value: unknown,
): Promise<string[]> {
	const definitions = parseManagedTaskDefinitions(value);
	for (const definition of definitions) await validateDefinition(state.binding, definition);
	const old = graph.nodes;
	const seeds = new Set<string>();
	for (const previous of old) {
		const next = definitions.find(definition => definition.id === previous.definition.id);
		if (!next || managedIdentity(definitionVector(next)) !== managedIdentity(definitionVector(previous.definition)))
			seeds.add(previous.definition.id);
	}
	for (const definition of definitions) {
		const previous = old.find(node => node.definition.id === definition.id);
		if (
			!previous ||
			managedIdentity(definitionVector(definition)) !== managedIdentity(definitionVector(previous.definition))
		)
			seeds.add(definition.id);
	}
	const affected = downstreamClosure([...seeds], [...old.map(node => node.definition), ...definitions]);
	graph.nodes = definitions.map(definition => {
		const previous = old.find(node => node.definition.id === definition.id);
		const historic = Math.max(
			0,
			...graph.attempts.filter(attempt => attempt.nodeId === definition.id).map(attempt => attempt.taskRevision),
		);
		return {
			definition,
			hash: managedIdentity(definition),
			revision: previous ? previous.revision + (affected.has(definition.id) ? 1 : 0) : historic + 1,
		};
	});
	graph.canceled = graph.canceled.filter(
		id => definitions.some(definition => definition.id === id) && !affected.has(id),
	);
	graph.revision++;
	for (const attempt of graph.attempts)
		if (affected.has(attempt.nodeId) && attempt.fence === "current") attempt.fence = "superseded";
	return [...affected].sort();
}

export function reducedWorkroomManagedDefinitions(
	workspace: string,
	criteriaIdentity: string,
): ManagedTaskDefinition[] {
	const node = (id: string, predecessors: string[]): ManagedTaskDefinition => ({
		id,
		task: `Workroom ${id}`,
		workspace,
		predecessors,
		criteriaIdentity,
		validations: [{ name: "check", command: "true" }],
		resources: [],
		artifacts: [],
	});
	return [
		node("S5", []),
		node("UI1a", ["S5"]),
		node("S6", ["S5"]),
		node("S7", ["S6"]),
		node("S8", ["UI1a", "S7"]),
		node("UI1b", ["S8"]),
		node("UI2", ["UI1b"]),
		node("S10a", ["S8"]),
		node("S10b", ["S10a"]),
		node("S9a", ["S8"]),
		node("S9b", ["S9a"]),
		node("S11", []),
	];
}
export type ManagedNativeEffectFence = "launch" | "seed";

export function managedNativeVector(attempt: ManagedTaskAttempt): string {
	return managedIdentity({
		task: attempt.definition.task,
		workspace: attempt.definition.workspace,
		criteriaIdentity: attempt.definition.criteriaIdentity,
		resources: attempt.definition.resources,
		definitionHash: attempt.definitionHash,
		native: attempt.native,
	});
}

export function lookupManagedAttemptByNativeIdentity(
	state: ManagedTaskDomain,
	nativeIdentity: string,
): ManagedTaskAttempt | undefined {
	const matches = state.graphs.flatMap(graph =>
		graph.attempts.filter(attempt => attempt.native.identity === nativeIdentity),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Trusted read of one attempt under the domain lock. Does not mint ManagedAttemptRef. */
export async function inspectManagedAttemptByNativeIdentity(
	binding: ManagedDomainBinding,
	nativeIdentity: string,
): Promise<ManagedTaskAttempt | undefined> {
	const enrolled = ManagedDomainBindingSchema.parse(binding);
	digest.parse(nativeIdentity);
	await validateBinding(enrolled);
	const target = managedTaskDomainPath(enrolled.controlRoot);
	return withWorkflowStateLock(
		target,
		async () => {
			const read = await readExistingStateForMutation(target);
			requirePolicy(read.kind !== "corrupt", "corrupt authority");
			if (read.kind === "absent") return undefined;
			const state = validateManagedTaskDomain(read.value);
			requirePolicy(managedIdentity(state.binding) === managedIdentity(enrolled), "domain binding mismatch");
			await validateManagedTaskDomainAuthority(state, enrolled);
			return lookupManagedAttemptByNativeIdentity(state, nativeIdentity);
		},
		{ cwd: enrolled.controlRoot, privateDurable: { directory: path.dirname(target) } },
	);
}

/**
 * Recheck current fence and immutable native vector, then run the native
 * transition before releasing the domain lock. Callers must not enter this
 * from a nested native serialization callback.
 */
export async function withManagedNativeEffectAuthorized<T>(
	binding: ManagedDomainBinding,
	nativeIdentity: string,
	expectedVector: string,
	fence: ManagedNativeEffectFence,
	effect: () => Promise<T>,
): Promise<T> {
	digest.parse(expectedVector);
	requirePolicy(fence === "launch" || fence === "seed", "unknown native effect fence");
	const enrolled = ManagedDomainBindingSchema.parse(binding);
	await validateBinding(enrolled);
	const target = managedTaskDomainPath(enrolled.controlRoot);
	return withWorkflowStateLock(
		target,
		async () => {
			const read = await readExistingStateForMutation(target);
			requirePolicy(read.kind !== "corrupt", "corrupt authority");
			requirePolicy(read.kind === "valid", "established authority missing");
			const state = validateManagedTaskDomain(read.value);
			requirePolicy(managedIdentity(state.binding) === managedIdentity(enrolled), "domain binding mismatch");
			await validateManagedTaskDomainAuthority(state, enrolled);
			const attempt = lookupManagedAttemptByNativeIdentity(state, nativeIdentity);
			requirePolicy(attempt, "managed native identity is not reserved");
			requirePolicy(attempt.fence === "current" && !attempt.retired, "managed attempt is fenced");
			requirePolicy(managedNativeVector(attempt) === expectedVector, "managed native vector changed");
			if (fence === "seed") requirePolicy(attempt.worker !== "no-effect", "canceled attempt cannot seed");
			if (fence === "launch") {
				requirePolicy(
					attempt.worker === "reserved" ||
						attempt.worker === "authorized" ||
						(attempt.worker === "no-effect" && attempt.validation === "not-started" && attempt.accepted === null),
					"illegal worker observation",
				);
				if (attempt.worker !== "authorized") {
					attempt.worker = "authorized";
					const written = await writeGuardedJsonAtomic(target, state, {
						cwd: enrolled.controlRoot,
						privateDurable: { directory: path.dirname(target) },
						policy: "source",
						expectedRevision: state.state_revision,
						lockHeld: true,
					});
					requirePolicy(written.written, "source publication skipped");
				}
			}
			return effect();
		},
		{ cwd: enrolled.controlRoot, privateDurable: { directory: path.dirname(target) } },
	);
}
export async function assertManagedNativeEffectAuthorized(
	binding: ManagedDomainBinding,
	nativeIdentity: string,
	expectedVector: string,
	fence: ManagedNativeEffectFence,
): Promise<void> {
	await withManagedNativeEffectAuthorized(binding, nativeIdentity, expectedVector, fence, async () => undefined);
}

export function managedAttemptRefMatches(
	ref: ManagedAttemptRef,
	attempt: ManagedTaskAttempt,
	binding: ManagedDomainBinding,
): boolean {
	return (
		ref.controlRoot === binding.controlRoot &&
		ref.enrollmentId === binding.enrollmentId &&
		ref.agentDirIdentity === binding.agentDirIdentity &&
		ref.graphId.length > 0 &&
		ref.nodeId === attempt.nodeId &&
		ref.attemptId === attempt.id &&
		ref.taskRevision === attempt.taskRevision &&
		ref.graphRevision === attempt.graphRevision &&
		ref.definitionHash === attempt.definitionHash &&
		ref.criteriaIdentity === attempt.definition.criteriaIdentity &&
		ref.inputIdentity === managedIdentity(attempt.inputs) &&
		ref.predecessorIdentity === managedIdentity(attempt.predecessors) &&
		ref.resourceIdentity === managedIdentity(attempt.resources) &&
		ref.nativeIdentity === attempt.native.identity &&
		managedIdentity(ref.native) === managedIdentity(attempt.native)
	);
}
export type ManagedNativeObservation = "no-effect" | "authorized" | "unknown" | "closed";

export function managedAttemptRefFromState(
	state: ManagedTaskDomain,
	attempt: ManagedTaskAttempt,
	graphId: string,
): ManagedAttemptRef {
	requirePolicy(
		state.graphs.some(graph => graph.id === graphId && graph.attempts.some(item => item.id === attempt.id)),
		"graph missing",
	);
	return {
		controlRoot: state.binding.controlRoot,
		enrollmentId: state.binding.enrollmentId,
		agentDirIdentity: state.binding.agentDirIdentity,
		graphId,
		graphRevision: attempt.graphRevision,
		nodeId: attempt.nodeId,
		taskRevision: attempt.taskRevision,
		attemptId: attempt.id,
		definitionHash: attempt.definitionHash,
		criteriaIdentity: attempt.definition.criteriaIdentity,
		inputIdentity: managedIdentity(attempt.inputs),
		predecessorIdentity: managedIdentity(attempt.predecessors),
		resourceIdentity: managedIdentity(attempt.resources),
		native: structuredClone(attempt.native),
		nativeIdentity: attempt.native.identity,
	};
}

export async function loadManagedEnrollmentIndex(agentDir: string): Promise<string[]> {
	return (await loadManagedEnrollmentRecord(agentDir)).controlRoots;
}

export async function loadManagedEnrollmentRecord(agentDir: string): Promise<ManagedEnrollmentRecord> {
	const agent = await fs.realpath(agentDir);
	const target = managedEnrollmentIndexPath(agent);
	// Managed enrollment can only be published on Linux (private durable publication). Elsewhere
	// an absent index is the only reachable state; do not let the Linux-only lock turn it into a
	// startup failure for brokers that never used task.dag. Only a proven ENOENT beneath real
	// directories is absent: any symlink, non-directory ancestor, or non-file leaf fails closed below.
	if (process.platform !== "linux" && (await isAbsentBeneathRealDirectories(agent, target)))
		return { controlRoots: [], establishedRoots: [], publishingRoots: [], nativeIdentities: [], byRoot: {} };
	try {
		return await withWorkflowStateLock(target, () => loadEnrollmentIndexUnderLock(target), {
			cwd: agent,
			privateDurable: { directory: path.dirname(target) },
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { controlRoots: [], establishedRoots: [], publishingRoots: [], nativeIdentities: [], byRoot: {} };
		if (error instanceof Error && error.message === "corrupt managed enrollment index") throw error;
		throw new Error("corrupt managed enrollment index");
	}
}

/**
 * True only when some component of `target` below `root` is missing and every component before it
 * is a real directory (not a symlink). lstat never follows the component it inspects, so walking
 * one component at a time keeps a symlinked ancestor from masking a present or corrupt namespace.
 */
async function isAbsentBeneathRealDirectories(root: string, target: string): Promise<boolean> {
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (current === target || !stat.isDirectory()) return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
	}
	return false;
}

export async function recordManagedEnrollment(
	agentDir: string,
	controlRoot: string,
	nativeIdentity?: string,
): Promise<void> {
	requirePolicy(isCanonicalAbsolute(controlRoot), "control root is not canonical");
	if (nativeIdentity !== undefined) digest.parse(nativeIdentity);
	const agent = await fs.realpath(agentDir);
	const target = managedEnrollmentIndexPath(agent);
	const writer = { cwd: agent, privateDurable: { directory: path.dirname(target) } };
	await withWorkflowStateLock(
		target,
		async () => {
			const record = await loadEnrollmentIndexUnderLock(target);
			const roots = new Set(record.controlRoots);
			const byRoot = { ...record.byRoot };
			const rootNatives = new Set(byRoot[controlRoot] ?? []);
			const already = roots.has(controlRoot) && (nativeIdentity === undefined || rootNatives.has(nativeIdentity));
			if (already) return;
			if (nativeIdentity !== undefined && record.nativeIdentities.includes(nativeIdentity))
				throw new Error("managed native identity is already enrolled under another control root");
			roots.add(controlRoot);
			if (nativeIdentity) rootNatives.add(nativeIdentity);
			byRoot[controlRoot] = [...rootNatives];
			const expectedRevision = await persistedEnrollmentRevision(target);
			const written = await writeGuardedJsonAtomic(
				target,
				enrollmentIndexDocument({
					controlRoots: [...roots],
					establishedRoots: record.establishedRoots,
					publishingRoots: record.publishingRoots,
					nativeIdentities: record.nativeIdentities,
					byRoot,
				}),
				{ ...writer, policy: "source", expectedRevision, lockHeld: true },
			);
			requirePolicy(written.written, "source publication skipped");
		},
		writer,
	);
}

async function updateManagedEnrollmentPublication(
	agentDir: string,
	controlRoot: string,
	publication: "pending" | "publishing" | "established",
): Promise<void> {
	requirePolicy(isCanonicalAbsolute(controlRoot), "control root is not canonical");
	const agent = await fs.realpath(agentDir);
	const target = managedEnrollmentIndexPath(agent);
	const writer = { cwd: agent, privateDurable: { directory: path.dirname(target) } };
	await withWorkflowStateLock(
		target,
		async () => {
			const record = await loadEnrollmentIndexUnderLock(target);
			const establishedRoots = new Set(record.establishedRoots);
			const publishingRoots = new Set(record.publishingRoots);
			if (publication === "established") {
				establishedRoots.add(controlRoot);
				publishingRoots.delete(controlRoot);
			} else if (publication === "publishing") {
				if (establishedRoots.has(controlRoot)) return;
				publishingRoots.add(controlRoot);
			} else {
				if (establishedRoots.has(controlRoot)) return;
				publishingRoots.delete(controlRoot);
			}
			const controlRoots = [...new Set([...record.controlRoots, controlRoot])];
			const byRoot = { ...record.byRoot, [controlRoot]: record.byRoot[controlRoot] ?? [] };
			if (
				controlRoots.length === record.controlRoots.length &&
				establishedRoots.size === record.establishedRoots.length &&
				publishingRoots.size === record.publishingRoots.length
			)
				return;
			const expectedRevision = await persistedEnrollmentRevision(target);
			const written = await writeGuardedJsonAtomic(
				target,
				enrollmentIndexDocument({
					controlRoots,
					establishedRoots: [...establishedRoots],
					publishingRoots: [...publishingRoots],
					nativeIdentities: record.nativeIdentities,
					byRoot,
				}),
				{ ...writer, policy: "source", expectedRevision, lockHeld: true },
			);
			requirePolicy(written.written, "source publication skipped");
		},
		writer,
	);
}

/** Mark a first domain publication in progress before its state rename. */
export async function markManagedEnrollmentPublishing(agentDir: string, controlRoot: string): Promise<void> {
	await updateManagedEnrollmentPublication(agentDir, controlRoot, "publishing");
}

/** A valid domain snapshot is authoritative even if the marker update was interrupted. */
export async function markManagedEnrollmentEstablished(agentDir: string, controlRoot: string): Promise<void> {
	await updateManagedEnrollmentPublication(agentDir, controlRoot, "established");
}

/** Only a proven pre-rename state-write failure may return publication to pending. */
export async function markManagedEnrollmentPending(agentDir: string, controlRoot: string): Promise<void> {
	await updateManagedEnrollmentPublication(agentDir, controlRoot, "pending");
}

/**
 * Remove a root that was pre-published for a first enrollment but never got a
 * domain state. Native identities make the root non-recoverable, so callers
 * must leave those entries indexed and report them as failed instead.
 */
async function removeEmptyManagedEnrollment(agentDir: string, controlRoot: string): Promise<boolean> {
	requirePolicy(isCanonicalAbsolute(controlRoot), "control root is not canonical");
	const agent = await fs.realpath(agentDir);
	const domainTarget = managedTaskDomainPath(controlRoot);
	return withWorkflowStateLock(
		domainTarget,
		async () => {
			const domain = await readExistingStateForMutation(domainTarget);
			if (domain.kind !== "absent") return false;
			const target = managedEnrollmentIndexPath(agent);
			const writer = { cwd: agent, privateDurable: { directory: path.dirname(target) } };
			return withWorkflowStateLock(
				target,
				async () => {
					const record = await loadEnrollmentIndexUnderLock(target);
					if (!record.controlRoots.includes(controlRoot)) return true;
					if (
						record.establishedRoots.includes(controlRoot) ||
						record.publishingRoots.includes(controlRoot) ||
						(record.byRoot[controlRoot] ?? []).length > 0
					)
						return false;
					const controlRoots = record.controlRoots.filter(root => root !== controlRoot);
					const byRoot = { ...record.byRoot };
					delete byRoot[controlRoot];
					const expectedRevision = await persistedEnrollmentRevision(target);
					const written = await writeGuardedJsonAtomic(
						target,
						enrollmentIndexDocument({
							controlRoots,
							establishedRoots: record.establishedRoots,
							publishingRoots: record.publishingRoots,
							nativeIdentities: record.nativeIdentities,
							byRoot,
						}),
						{ ...writer, policy: "source", expectedRevision, lockHeld: true },
					);
					requirePolicy(written.written, "source publication skipped");
					return true;
				},
				writer,
			);
		},
		{ cwd: controlRoot, privateDurable: { directory: path.dirname(domainTarget) } },
	);
}

async function persistedEnrollmentRevision(target: string): Promise<number> {
	const read = await readExistingStateForMutation(target);
	if (read.kind === "absent") return 0;
	requirePolicy(read.kind === "valid", "corrupt managed enrollment index");
	const revision = (read.value as { state_revision?: unknown }).state_revision;
	return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export async function currentManagedRevision(binding: ManagedDomainBinding): Promise<number> {
	const enrolled = ManagedDomainBindingSchema.parse(binding);
	await validateBinding(enrolled);
	const target = managedTaskDomainPath(enrolled.controlRoot);
	return withWorkflowStateLock(
		target,
		async () => {
			const read = await readExistingStateForMutation(target);
			requirePolicy(read.kind !== "corrupt", "corrupt authority");
			requirePolicy(read.kind === "valid", "established authority missing");
			return validateManagedTaskDomain(read.value).state_revision;
		},
		{ cwd: enrolled.controlRoot, privateDurable: { directory: path.dirname(target) } },
	);
}

export async function recordManagedNativeObservation(
	binding: ManagedDomainBinding,
	nativeIdentity: string,
	worker: ManagedNativeObservation,
	authorize?: { fence: ManagedNativeEffectFence; expectedVector: string },
): Promise<void> {
	await transactManagedTaskDomain({ binding, internal: true }, async state => {
		const attempt = lookupManagedAttemptByNativeIdentity(state, nativeIdentity);
		requirePolicy(attempt, "managed native identity is not reserved");
		if (authorize) {
			requirePolicy(attempt.fence === "current" && !attempt.retired, "managed attempt is fenced");
			requirePolicy(managedNativeVector(attempt) === authorize.expectedVector, "managed native vector changed");
			if (authorize.fence === "seed") requirePolicy(attempt.worker !== "no-effect", "canceled attempt cannot seed");
		}
		if (worker === "authorized")
			requirePolicy(attempt.worker === "reserved" || attempt.worker === "authorized", "illegal worker observation");
		if (worker === "no-effect")
			requirePolicy(
				attempt.worker === "reserved" || attempt.worker === "no-effect",
				"illegal no-effect observation",
			);
		if (worker === "unknown") requirePolicy(attempt.worker !== "closed", "illegal unknown observation");
		if (worker === "closed") requirePolicy(attempt.worker !== "no-effect", "illegal close observation");
		attempt.worker = worker;
	});
}

export type RestoredManagedAttemptRefs = {
	refs: ManagedAttemptRef[];
	failedRoots: string[];
};

export async function restoreManagedAttemptRefs(agentDir: string): Promise<RestoredManagedAttemptRefs> {
	const identity = await objectIdentity(await fs.realpath(agentDir));
	const refs: ManagedAttemptRef[] = [];
	const failedRoots: string[] = [];
	const enrollment = await loadManagedEnrollmentRecord(agentDir);
	for (const controlRoot of enrollment.controlRoots) {
		try {
			const read = await readExistingStateForMutation(managedTaskDomainPath(controlRoot));
			if (read.kind !== "valid") {
				if (read.kind === "absent" && (enrollment.byRoot[controlRoot] ?? []).length === 0) {
					if (await removeEmptyManagedEnrollment(agentDir, controlRoot)) continue;
				}
				failedRoots.push(controlRoot);
				continue;
			}
			const state = validateManagedTaskDomain(read.value);
			if (state.binding.agentDirIdentity !== identity || state.binding.controlRoot !== controlRoot) {
				failedRoots.push(controlRoot);
				continue;
			}
			await markManagedEnrollmentEstablished(agentDir, controlRoot);
			for (const graph of state.graphs)
				for (const attempt of graph.attempts)
					if (!attempt.retired) refs.push(managedAttemptRefFromState(state, attempt, graph.id));
		} catch {
			failedRoots.push(controlRoot);
		}
	}
	return { refs, failedRoots };
}

export async function loadManagedDomainBinding(controlRoot: string): Promise<ManagedDomainBinding | undefined> {
	try {
		const read = await readExistingStateForMutation(managedTaskDomainPath(controlRoot));
		if (read.kind !== "valid") return undefined;
		return validateManagedTaskDomain(read.value).binding;
	} catch {
		return undefined;
	}
}

import * as path from "node:path";
import { z } from "zod";

const identity = z.string().min(1).max(256);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workspace = z
	.object({
		cwd: z.string().min(1),
		root: z.string().min(1),
		device: identity,
		inode: identity,
		gitCommonDirectory: z.string().min(1).nullable(),
	})
	.strict();
const actor = z.object({ pid: z.number().int().positive(), incarnation: identity }).strict();
const child = z
	.object({
		id: identity,
		parentId: identity.nullable(),
		sessionId: identity,
		tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
		workspace,
		actor,
		phase: z.enum(["pending", "active", "closed", "uncertain"]),
	})
	.strict();
const root = z
	.object({
		id: identity,
		generation: sequence,
		sessionId: identity,
		tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
		actor,
		workspaces: z.array(workspace).min(1),
		phase: z.enum(["active", "draining", "uncertain"]),
		children: z.array(child),
	})
	.strict();

const canonicalPath = z
	.string()
	.min(1)
	.refine(value => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"));
const physicalIdentity = z.string().regex(/^(0|[1-9][0-9]*)$/);
const branch = z
	.object({
		familyId: identity,
		branchId: identity,
		resourceId: identity,
		sessionFile: canonicalPath,
		sourceDirectory: canonicalPath,
		cwd: canonicalPath,
		workspace: workspace.extend({
			cwd: canonicalPath,
			root: canonicalPath,
			device: physicalIdentity,
			inode: physicalIdentity,
			gitCommonDirectory: canonicalPath.nullable(),
		}),
		device: physicalIdentity,
		inode: physicalIdentity,
		storage: z.enum(["managed", "explicit"]),
		managedAgentDir: canonicalPath.nullable(),
		parentBranchId: identity.nullable(),
		anchor: z
			.object({
				entryId: identity.nullable(),
				capturedDigest: z.string().regex(/^[a-f0-9]{64}$/),
				inclusionMode: z.literal("complete-committed-snapshot"),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.superRefine((record, context) => {
		const relative = path.relative(record.sourceDirectory, record.sessionFile);
		if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
			context.addIssue({ code: "custom", message: "Invalid branch location" });
		}
		if (record.cwd !== record.workspace.cwd || (record.storage === "managed") !== (record.managedAgentDir !== null)) {
			context.addIssue({ code: "custom", message: "Invalid branch binding" });
		}
		if (record.parentBranchId !== null && (record.anchor === null || record.parentBranchId === record.branchId)) {
			context.addIssue({ code: "custom", message: "Invalid child branch" });
		}
		if (record.parentBranchId === null && (record.branchId !== record.familyId || record.anchor !== null)) {
			context.addIssue({ code: "custom", message: "Invalid root branch" });
		}
	});

export class SessionFamilyStateError extends Error {
	constructor(readonly code: "invalid_state" | "io_error") {
		super(code === "invalid_state" ? "Invalid session family state." : "Session family state is unavailable.");
		this.name = "SessionFamilyStateError";
	}
}

const stateSchema = z
	.object({
		version: z.literal(1),
		revision: sequence,
		roots: z.array(root),
		branches: z.array(branch),
	})
	.strict()
	.superRefine((state, context) => {
		const ids = new Set<string>();
		const resources = new Set<string>();
		const files = new Set<string>();
		const physical = new Set<string>();
		for (const record of state.branches) {
			const key = `${record.device}:${record.inode}`;
			if (
				ids.has(record.branchId) ||
				resources.has(record.resourceId) ||
				files.has(record.sessionFile) ||
				physical.has(key)
			) {
				context.addIssue({ code: "custom", message: "Duplicate branch identity" });
			}
			ids.add(record.branchId);
			resources.add(record.resourceId);
			files.add(record.sessionFile);
			physical.add(key);
		}
		const byId = new Map(state.branches.map(record => [record.branchId, record]));
		const resolved = new Set<string>();
		for (const record of state.branches) {
			const familyRoot = byId.get(record.familyId);
			if (!familyRoot || familyRoot.parentBranchId !== null || familyRoot.familyId !== record.familyId) {
				context.addIssue({ code: "custom", message: "Missing family root" });
			}
			const chain = new Set<string>();
			let current: typeof record | undefined = record;
			while (current && !resolved.has(current.branchId)) {
				if (chain.has(current.branchId)) {
					context.addIssue({ code: "custom", message: "Cyclic branch lineage" });
					break;
				}
				chain.add(current.branchId);
				if (current.parentBranchId === null) break;
				const parent = byId.get(current.parentBranchId);
				if (!parent || parent.familyId !== current.familyId) {
					context.addIssue({ code: "custom", message: "Invalid branch parent" });
					break;
				}
				current = parent;
			}
			for (const id of chain) resolved.add(id);
		}
	});

export type SessionFamilyReference = z.infer<typeof branch>;
export type SessionFamilyOwnershipState = z.infer<typeof stateSchema>;
export type SessionFamilyRootRecord = z.infer<typeof root>;
export type SessionFamilyChildRecord = z.infer<typeof child>;

export function emptySessionFamilyOwnershipState(): SessionFamilyOwnershipState {
	return { version: 1, revision: 0, roots: [], branches: [] };
}

export function parseSessionFamilyOwnershipState(value: unknown): SessionFamilyOwnershipState {
	const parsed = stateSchema.safeParse(value);
	if (!parsed.success) throw new SessionFamilyStateError("invalid_state");
	return parsed.data;
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { CURRENT_SESSION_VERSION, SessionManager, type TranscriptReadSnapshot } from "../session/session-manager";
import { SessionIndex } from "./broker/session-index";
import {
	type SessionFamilyOwnershipState,
	type SessionFamilyReference,
	SessionFamilyStateError,
} from "./session-family-state";
import {
	assertSessionFamilyWorkspaceUnchanged,
	resolveSessionFamilyWorkspace,
	SessionFamilyWorkspaceError,
	sessionFamilyWorkspacesOverlap,
} from "./session-family-workspace";

export type { SessionFamilyReference } from "./session-family-state";

export interface RegisterExistingSessionFamilyInput {
	sessionFile: string;
	sourceDirectory: string;
	expectedSessionId: string;
	expectedCwd: string;
	storage: "managed" | "explicit";
	managedAgentDir?: string;
}

export type SessionFamilyRegistryErrorCode =
	| "invalid_input"
	| "invalid_state"
	| "invalid_transcript"
	| "identity_conflict"
	| "io_error";

export class SessionFamilyRegistryError extends Error {
	constructor(readonly code: SessionFamilyRegistryErrorCode) {
		super(`Session family registry: ${code}.`);
		this.name = "SessionFamilyRegistryError";
	}
}

const inputSchema = z
	.object({
		sessionFile: z.string().min(1),
		sourceDirectory: z.string().min(1),
		expectedSessionId: z.string().min(1).max(256),
		expectedCwd: z.string().min(1),
		storage: z.enum(["managed", "explicit"]),
		managedAgentDir: z.string().min(1).optional(),
	})
	.strict();
const headerPatchSchema = z
	.object({
		type: z.literal("header_patch"),
		patch: z
			.object({
				cwd: z.string().optional(),
				title: z.string().optional(),
				titleSource: z.enum(["auto", "user"]).optional(),
				starred: z.boolean().optional(),
			})
			.strict(),
	})
	.strict();

function contains(directory: string, file: string): boolean {
	const relative = path.relative(directory, file);
	return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Only metadata is retained; completed bounded passes verify the captured digest. */
function capturedCwd(snapshot: TranscriptReadSnapshot): string {
	let cwd: string | undefined;
	let version = 1;
	let first = true;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let validationError: SessionFamilyRegistryError | undefined;
	snapshot.forEachLine(line => {
		try {
			const record: unknown = JSON.parse(decoder.decode(line));
			if (!record || typeof record !== "object" || Array.isArray(record))
				throw new SessionFamilyRegistryError("invalid_transcript");
			const value = record as Record<string, unknown>;
			if (first) {
				first = false;
				if (value.type !== "session" || value.id !== snapshot.identity.sessionId || typeof value.cwd !== "string") {
					throw new SessionFamilyRegistryError("invalid_transcript");
				}
				if (value.version !== undefined) {
					if (
						typeof value.version !== "number" ||
						!Number.isInteger(value.version) ||
						value.version < 1 ||
						value.version > CURRENT_SESSION_VERSION
					) {
						throw new SessionFamilyRegistryError("invalid_transcript");
					}
					version = value.version;
				}
				cwd = value.cwd;
			} else if (value.type === "session" || typeof value.type !== "string") {
				throw new SessionFamilyRegistryError("invalid_transcript");
			} else if (value.type === "header_patch") {
				const patch = headerPatchSchema.safeParse(value);
				if (!patch.success) throw new SessionFamilyRegistryError("invalid_transcript");
				if (version >= 4 && patch.data.patch.cwd !== undefined) cwd = patch.data.patch.cwd;
			}
			return undefined;
		} catch {
			validationError = new SessionFamilyRegistryError("invalid_transcript");
			return false;
		}
	});
	if (validationError) throw validationError;
	if (!cwd || !path.isAbsolute(cwd)) throw new SessionFamilyRegistryError("invalid_transcript");
	return cwd;
}

/** Durable reference inventory only: registration never grants a writer or lifecycle capability. */
export class SessionFamilyRegistry {
	readonly #index: SessionIndex;

	constructor(authorityDirectory: string) {
		this.#index = new SessionIndex(authorityDirectory);
	}

	async #bounded<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SessionFamilyRegistryError) throw error;
			if (error instanceof SessionFamilyStateError) throw new SessionFamilyRegistryError(error.code);
			if (error instanceof SessionFamilyWorkspaceError && error.code === "identity_conflict")
				throw new SessionFamilyRegistryError("identity_conflict");
			throw new SessionFamilyRegistryError("io_error");
		}
	}

	async registerExisting(
		input: RegisterExistingSessionFamilyInput,
		canPublish?: () => boolean,
	): Promise<SessionFamilyReference> {
		return await this.#bounded(async () => {
			if (
				!inputSchema.safeParse(input).success ||
				(input.storage === "managed") !== (input.managedAgentDir !== undefined)
			) {
				throw new SessionFamilyRegistryError("invalid_input");
			}
			const sourceDirectory = await fs.realpath(input.sourceDirectory);
			const sessionFile = await fs.realpath(input.sessionFile);
			if (!(await fs.stat(sourceDirectory)).isDirectory() || !contains(sourceDirectory, sessionFile)) {
				throw new SessionFamilyRegistryError("identity_conflict");
			}
			const stat = await fs.lstat(sessionFile, { bigint: true });
			if (!stat.isFile() || stat.isSymbolicLink()) throw new SessionFamilyRegistryError("invalid_transcript");
			const workspace = await resolveSessionFamilyWorkspace(input.expectedCwd);
			const managedAgentDir = input.managedAgentDir === undefined ? null : await fs.realpath(input.managedAgentDir);
			if (managedAgentDir !== null && !(await fs.stat(managedAgentDir)).isDirectory())
				throw new SessionFamilyRegistryError("invalid_input");
			const captured = SessionManager.captureTranscriptReadOnly(sessionFile);
			if (captured.kind !== "captured") {
				throw new SessionFamilyRegistryError(
					captured.reason === "unstable" ? "identity_conflict" : "invalid_transcript",
				);
			}
			const snapshot = captured.snapshot;
			try {
				const identity = snapshot.identity;
				if (
					identity.sessionId !== input.expectedSessionId ||
					identity.dev !== stat.dev ||
					identity.ino !== stat.ino ||
					identity.canonicalPath !== sessionFile
				) {
					throw new SessionFamilyRegistryError("identity_conflict");
				}
				let headerCwd: string;
				try {
					headerCwd = capturedCwd(snapshot);
				} catch (error) {
					if (error instanceof SessionFamilyRegistryError) throw error;
					throw new SessionFamilyRegistryError(
						error instanceof SyntaxError ? "invalid_transcript" : "identity_conflict",
					);
				}
				if ((await fs.realpath(headerCwd)) !== workspace.cwd)
					throw new SessionFamilyRegistryError("identity_conflict");
				return await this.#index.updateFamilyOwnership(async state => {
					await assertSessionFamilyWorkspaceUnchanged(workspace);
					if (
						(await fs.realpath(input.sourceDirectory)) !== sourceDirectory ||
						(await fs.realpath(input.sessionFile)) !== sessionFile ||
						(await fs.realpath(headerCwd)) !== workspace.cwd
					) {
						throw new SessionFamilyRegistryError("identity_conflict");
					}
					if (
						input.managedAgentDir !== undefined &&
						(await fs.realpath(input.managedAgentDir)) !== managedAgentDir
					)
						throw new SessionFamilyRegistryError("identity_conflict");
					if (snapshot.revalidate().kind !== "valid") throw new SessionFamilyRegistryError("identity_conflict");
					// The synchronous guard is the publication admission point. A retirement
					// observed before this transaction mutation must not leave a new reference.
					if (canPublish && !canPublish()) throw new SessionFamilyRegistryError("invalid_state");
					const device = String(identity.dev);
					const inode = String(identity.ino);
					const existing = state.branches.find(
						record =>
							record.branchId === identity.sessionId ||
							record.sessionFile === sessionFile ||
							(record.device === device && record.inode === inode),
					);
					if (existing) {
						if (
							existing.branchId !== identity.sessionId ||
							existing.device !== device ||
							existing.inode !== inode ||
							existing.cwd !== workspace.cwd ||
							existing.storage !== input.storage ||
							existing.managedAgentDir !== managedAgentDir ||
							existing.workspace.root !== workspace.root ||
							existing.workspace.device !== workspace.device ||
							existing.workspace.inode !== workspace.inode ||
							existing.workspace.gitCommonDirectory !== workspace.gitCommonDirectory
						) {
							throw new SessionFamilyRegistryError("identity_conflict");
						}
						return structuredClone(existing);
					}
					const reference: SessionFamilyReference = {
						familyId: identity.sessionId,
						branchId: identity.sessionId,
						resourceId: randomUUID(),
						sessionFile,
						sourceDirectory,
						cwd: workspace.cwd,
						workspace,
						device,
						inode,
						storage: input.storage,
						managedAgentDir,
						parentBranchId: null,
						anchor: null,
					};
					state.branches.push(reference);
					return structuredClone(reference);
				});
			} finally {
				snapshot.close();
			}
		});
	}

	async #read<T>(select: (state: SessionFamilyOwnershipState) => T): Promise<T> {
		return await this.#bounded(() => this.#index.readFamilyOwnership(async state => structuredClone(select(state))));
	}

	async listFamily(familyId: string): Promise<readonly SessionFamilyReference[]> {
		return await this.#read(state => state.branches.filter(record => record.familyId === familyId));
	}

	async listForWorkspace(cwd: string): Promise<readonly SessionFamilyReference[]> {
		return await this.#bounded(async () => {
			const workspace = await resolveSessionFamilyWorkspace(cwd);
			return await this.#read(state =>
				state.branches.filter(record => sessionFamilyWorkspacesOverlap(record.workspace, workspace)),
			);
		});
	}

	async getBranch(branchId: string): Promise<SessionFamilyReference | undefined> {
		return await this.#read(state => state.branches.find(record => record.branchId === branchId));
	}
}

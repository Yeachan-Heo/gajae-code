import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentProfileAuthority, getTrustedHomeDir } from "@gajae-code/utils/dirs";
import { observeProcessIncarnation } from "./broker/process-incarnation";
import { SessionIndex } from "./broker/session-index";
import type { SessionFamilyOwnershipState, SessionFamilyRootRecord } from "./session-family-state";
import {
	assertSessionFamilyWorkspaceUnchanged,
	resolveSessionFamilyWorkspace,
	type SessionFamilyWorkspace,
	sessionFamilyWorkspacesOverlap,
} from "./session-family-workspace";

export type SessionFamilyOwnershipErrorCode =
	| "busy_branch"
	| "busy_workspace"
	| "uncertain"
	| "stale_reference"
	| "unsupported";

export class SessionFamilyOwnershipError extends Error {
	constructor(
		readonly code: SessionFamilyOwnershipErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SessionFamilyOwnershipError";
	}
}

/**
 * First-party coordination is independent of per-session transcript/config roots.
 * Custom process profiles must not silently become separate ownership domains.
 * Explicit fixture coordinators use the constructor rather than this resolver.
 */
export function resolveSessionFamilyAuthorityDirectory(): string {
	if (getAgentProfileAuthority() !== "default") {
		throw new SessionFamilyOwnershipError(
			"unsupported",
			"Family sharing requires the default process profile authority.",
		);
	}
	return path.join(getTrustedHomeDir(), CONFIG_DIR_NAME, "session-families");
}

export interface SessionFamilyRootGrant {
	readonly kind: "root";
	readonly id: string;
	readonly generation: number;
	readonly sessionId: string;
	readonly workspace: SessionFamilyWorkspace;
}

export interface SessionFamilyChildGrant {
	readonly kind: "child";
	readonly id: string;
	readonly rootId: string;
	readonly generation: number;
	readonly sessionId: string;
	readonly workspace: SessionFamilyWorkspace;
}

type Grant = SessionFamilyRootGrant | SessionFamilyChildGrant;
interface Capability {
	directory: string;
	rootId: string;
	tokenHash: string;
	pid: number;
	incarnation: string;
	released: boolean;
}

// Public identifiers and serialized lookalikes do not carry release authority.
const capabilities = new WeakMap<Grant, Capability>();

function currentActor(): { pid: number; incarnation: string } {
	const observation = observeProcessIncarnation(process.pid);
	if (observation.status !== "present") {
		throw new SessionFamilyOwnershipError("uncertain", "Runtime process identity could not be established.");
	}
	return { pid: process.pid, incarnation: observation.incarnation };
}

function secretHash(): string {
	return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

function writerActive(state: SessionFamilyOwnershipState, sessionId: string): boolean {
	return state.roots.some(
		root =>
			root.sessionId === sessionId ||
			root.children.some(child => child.sessionId === sessionId && child.phase !== "closed"),
	);
}

function conflict(root: SessionFamilyRootRecord, code: "busy_branch" | "busy_workspace"): never {
	const observation = observeProcessIncarnation(root.actor.pid);
	if (
		root.phase === "uncertain" ||
		observation.status !== "present" ||
		observation.incarnation !== root.actor.incarnation
	) {
		// Death or PID reuse never proves that descendants have stopped. The durable
		// record remains; reclaiming a short index lock cannot remove this fence.
		throw new SessionFamilyOwnershipError("uncertain", "An earlier runtime has no verified clean teardown.");
	}
	throw new SessionFamilyOwnershipError(code, "Another runtime owns the requested conversation or workspace.");
}

function scopeContains(parent: SessionFamilyWorkspace, child: SessionFamilyWorkspace): boolean {
	const relative = path.relative(parent.root, child.root);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Internal coordinator. Production entrypoints must use the same machine authority directory. */
export class SessionFamilyOwnership {
	readonly #directory: string;
	readonly #index: SessionIndex;

	constructor(authorityDirectory: string) {
		this.#directory = path.resolve(authorityDirectory);
		this.#index = new SessionIndex(this.#directory);
	}

	async #transaction<T>(operation: (state: SessionFamilyOwnershipState, directory: string) => Promise<T>): Promise<T> {
		try {
			return await this.#index.updateFamilyOwnership(async state =>
				operation(state, await fs.realpath(this.#directory)),
			);
		} catch (error) {
			if (error instanceof SessionFamilyOwnershipError) throw error;
			throw new SessionFamilyOwnershipError(
				"uncertain",
				"Conversation ownership could not be established durably.",
				{ cause: error },
			);
		}
	}

	#owned(state: SessionFamilyOwnershipState, directory: string, grant: Grant): SessionFamilyRootRecord {
		const capability = capabilities.get(grant);
		const actor = currentActor();
		if (
			!capability ||
			capability.released ||
			capability.directory !== directory ||
			capability.pid !== actor.pid ||
			capability.incarnation !== actor.incarnation
		) {
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership capability is not current.");
		}
		const root = state.roots.find(
			candidate => candidate.id === capability.rootId && candidate.generation === grant.generation,
		);
		if (!root || root.actor.pid !== actor.pid || root.actor.incarnation !== actor.incarnation) {
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership generation is not current.");
		}
		const hash =
			grant.kind === "root" ? root.tokenHash : root.children.find(child => child.id === grant.id)?.tokenHash;
		if (hash !== capability.tokenHash)
			throw new SessionFamilyOwnershipError("stale_reference", "The runtime ownership token does not match.");
		return root;
	}

	async acquireRoot(cwd: string, sessionId: string = Bun.randomUUIDv7()): Promise<SessionFamilyRootGrant> {
		const workspace = await resolveSessionFamilyWorkspace(cwd);
		const actor = currentActor();
		return await this.#transaction(async (state, directory) => {
			await assertSessionFamilyWorkspaceUnchanged(workspace);
			for (const root of state.roots) {
				if (
					root.sessionId === sessionId ||
					root.children.some(child => child.sessionId === sessionId && child.phase !== "closed")
				)
					conflict(root, "busy_branch");
				if (root.workspaces.some(owned => sessionFamilyWorkspacesOverlap(owned, workspace)))
					conflict(root, "busy_workspace");
			}
			const tokenHash = secretHash();
			const grant: SessionFamilyRootGrant = Object.freeze({
				kind: "root",
				id: Bun.randomUUIDv7(),
				generation: state.revision + 1,
				sessionId,
				workspace: Object.freeze(workspace),
			});
			state.roots.push({
				id: grant.id,
				generation: grant.generation,
				sessionId,
				tokenHash,
				actor,
				workspaces: [workspace],
				phase: "active",
				children: [],
			});
			capabilities.set(grant, { directory, rootId: grant.id, tokenHash, ...actor, released: false });
			return grant;
		});
	}

	/** Reserve before child manager construction or dispatch, including nested tasks. */
	async reserveChild(
		parent: Grant,
		sessionId: string = Bun.randomUUIDv7(),
		cwd = parent.workspace.cwd,
	): Promise<SessionFamilyChildGrant> {
		const workspace = await resolveSessionFamilyWorkspace(cwd);
		return await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, parent);
			if (root.phase !== "active")
				throw new SessionFamilyOwnershipError("uncertain", "The root runtime is draining or uncertain.");
			if (parent.kind === "child") {
				const owningChild = root.children.find(child => child.id === parent.id);
				if (owningChild?.phase !== "active" || !scopeContains(parent.workspace, workspace)) {
					throw new SessionFamilyOwnershipError(
						"unsupported",
						"A subordinate cannot expand or replace its ownership scope.",
					);
				}
			}
			await assertSessionFamilyWorkspaceUnchanged(workspace);
			if (writerActive(state, sessionId))
				throw new SessionFamilyOwnershipError("busy_branch", "The child conversation already has an owner.");
			for (const other of state.roots) {
				if (other !== root && other.workspaces.some(owned => sessionFamilyWorkspacesOverlap(owned, workspace)))
					conflict(other, "busy_workspace");
			}
			if (
				!root.workspaces.some(
					owned =>
						owned.root === workspace.root && owned.device === workspace.device && owned.inode === workspace.inode,
				)
			)
				root.workspaces.push(workspace);
			const actor = currentActor();
			const tokenHash = secretHash();
			const grant: SessionFamilyChildGrant = Object.freeze({
				kind: "child",
				id: Bun.randomUUIDv7(),
				rootId: root.id,
				generation: root.generation,
				sessionId,
				workspace: Object.freeze(workspace),
			});
			root.children.push({
				id: grant.id,
				parentId: parent.kind === "child" ? parent.id : null,
				sessionId,
				tokenHash,
				workspace,
				actor,
				phase: "pending",
			});
			capabilities.set(grant, { directory, rootId: root.id, tokenHash, ...actor, released: false });
			return grant;
		});
	}

	async activateChild(grant: SessionFamilyChildGrant): Promise<void> {
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			const child = root.children.find(candidate => candidate.id === grant.id);
			if (root.phase !== "active" || !child || (child.phase !== "pending" && child.phase !== "active")) {
				throw new SessionFamilyOwnershipError("uncertain", "The subordinate no longer has startup admission.");
			}
			await assertSessionFamilyWorkspaceUnchanged(child.workspace);
			child.phase = "active";
		});
	}

	/** A failed teardown is sticky; a later completion message cannot erase uncertainty. */
	async completeChild(grant: SessionFamilyChildGrant, outcome: "closed" | "uncertain"): Promise<void> {
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			const child = root.children.find(candidate => candidate.id === grant.id);
			if (!child || child.phase === "uncertain")
				throw new SessionFamilyOwnershipError("uncertain", "Subordinate teardown is not verified.");
			child.phase = outcome;
			if (outcome === "uncertain") root.phase = "uncertain";
		});
	}

	/** Joining actual runtime teardown is mandatory; detach and deadline expiry are not proof. */
	async releaseAfterTeardown(grant: SessionFamilyRootGrant, teardown: () => Promise<void>): Promise<void> {
		if (grant.kind !== "root")
			throw new SessionFamilyOwnershipError("unsupported", "A subordinate cannot release root ownership.");
		const capability = capabilities.get(grant);
		if (capability?.released) return;
		await this.#transaction(async (state, directory) => {
			const root = this.#owned(state, directory, grant);
			if (root.phase === "uncertain")
				throw new SessionFamilyOwnershipError("uncertain", "Runtime teardown remains uncertain.");
			root.phase = "draining";
		});
		try {
			await teardown();
			await this.#transaction(async (state, directory) => {
				const root = this.#owned(state, directory, grant);
				if (root.phase !== "draining" || root.children.some(child => child.phase !== "closed")) {
					throw new SessionFamilyOwnershipError("uncertain", "Owned subordinate work has not completed teardown.");
				}
				state.roots.splice(state.roots.indexOf(root), 1);
			});
			if (capability) capability.released = true;
		} catch (error) {
			try {
				await this.#transaction(async (state, directory) => {
					this.#owned(state, directory, grant).phase = "uncertain";
				});
			} catch (retentionError) {
				throw new AggregateError([error, retentionError], "Runtime teardown and ownership-fence retention failed.");
			}
			throw error;
		}
	}
}

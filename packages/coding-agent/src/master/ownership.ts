import { randomUUID } from "node:crypto";
import type { MasterOwner as CanonicalMasterOwner } from "./types";

export type MasterOwner = CanonicalMasterOwner;
export type Owner = MasterOwner;

export type WorkerFenceLifecycle = "owned_unprompted" | "prompt_pending" | "active" | "terminal" | "user_registered";

export interface QuarantinedWorkerEvent {
	readonly quarantineId: string;
	readonly workerSessionId: string;
	readonly fence: number;
	readonly event: unknown;
}

export interface WorkerEventRoute {
	readonly disposition: "master" | "user" | "quarantined";
	readonly owner?: MasterOwner;
	readonly masterName?: string;
	readonly quarantineId?: string;
}

export class OwnershipError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.name = "OwnershipError";
		this.code = code;
	}
}

const MASTER_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const OPAQUE_ID = /^[\x20-\x7e]{1,128}$/;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertOpaqueId(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !OPAQUE_ID.test(value))
		throw new OwnershipError("invalid_worker_id", `${field} must be a printable opaque identifier.`);
}

export function assertExactOwner(value: unknown): asserts value is MasterOwner {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new OwnershipError("owner_invalid", "Owner must be an object.");
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "user") {
		if (Object.keys(candidate).length !== 1)
			throw new OwnershipError("owner_invalid", "User owner records cannot carry extra fields.");
		return;
	}
	if (
		candidate.kind === "master" &&
		typeof candidate.masterName === "string" &&
		MASTER_NAME.test(candidate.masterName)
	) {
		if (Object.keys(candidate).length !== 2)
			throw new OwnershipError("owner_invalid", "Master owner records cannot carry extra fields.");
		return;
	}
	throw new OwnershipError("owner_invalid", "Owner must be exactly {kind:user} or {kind:master,masterName}.");
}

export function normalizeOwner(value: unknown): MasterOwner {
	assertExactOwner(value);
	return value.kind === "user" ? { kind: "user" } : { kind: "master", masterName: value.masterName };
}

export function ownerEquals(left: MasterOwner, right: MasterOwner): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "user" || (right.kind === "master" && left.masterName === right.masterName))
	);
}

export const ownersEqual = ownerEquals;

export function ownerKind(value: MasterOwner): "master" | "user" {
	return value.kind;
}

export function isMasterOwner(value: MasterOwner): value is { kind: "master"; masterName: string } {
	return value.kind === "master";
}

export function isUserOwner(value: MasterOwner): value is { kind: "user" } {
	return value.kind === "user";
}

export interface WorkerEventFenceOptions {
	workerSessionId: string;
	owner: MasterOwner;
	fence?: number;
	lifecycle?: WorkerFenceLifecycle;
}

export class WorkerEventFence {
	readonly workerSessionId: string;
	readonly fence: number;
	#owner: MasterOwner;
	#lifecycle: WorkerFenceLifecycle;
	#quarantined: QuarantinedWorkerEvent[] = [];
	#drained = false;

	constructor(options: WorkerEventFenceOptions) {
		assertOpaqueId(options.workerSessionId, "workerSessionId");
		this.workerSessionId = options.workerSessionId;
		this.#owner = normalizeOwner(options.owner);
		const fence = options.fence ?? 1;
		if (!Number.isSafeInteger(fence) || fence < 1)
			throw new OwnershipError("fence_invalid", "Worker fence must be a positive safe integer.");
		this.fence = fence;
		this.#lifecycle = options.lifecycle ?? (this.#owner.kind === "user" ? "user_registered" : "owned_unprompted");
		if (this.#owner.kind === "user" && this.#lifecycle !== "user_registered")
			throw new OwnershipError("lifecycle_owner_mismatch", "User-owned workers must start user_registered.");
	}

	get owner(): MasterOwner {
		return clone(this.#owner);
	}

	get lifecycle(): WorkerFenceLifecycle {
		return this.#lifecycle;
	}

	get isActive(): boolean {
		return this.#lifecycle === "active" || this.#lifecycle === "terminal" || this.#lifecycle === "user_registered";
	}

	setOwner(owner: MasterOwner): void {
		const normalized = normalizeOwner(owner);
		if (
			!ownerEquals(this.#owner, normalized) &&
			this.#lifecycle !== "terminal" &&
			this.#lifecycle !== "user_registered"
		) {
			throw new OwnershipError("owner_change_before_activation", "A pre-active worker fence cannot change owner.");
		}
		this.#owner = normalized;
	}

	markPromptPending(): void {
		if (this.#lifecycle !== "owned_unprompted")
			throw new OwnershipError(
				"lifecycle_transition_invalid",
				"Only an owned_unprompted worker can enter prompt_pending.",
			);
		this.#lifecycle = "prompt_pending";
	}

	record(event: unknown): WorkerEventRoute {
		if (!this.isActive) {
			const quarantineId = `${this.workerSessionId}:quarantine:${this.#quarantined.length + 1}:${randomUUID()}`;
			this.#quarantined.push({ quarantineId, workerSessionId: this.workerSessionId, fence: this.fence, event });
			return { disposition: "quarantined", quarantineId };
		}
		return routeForOwner(this.#owner);
	}

	activate(): readonly QuarantinedWorkerEvent[] {
		if (this.#lifecycle === "terminal") return [];
		if (this.#owner.kind !== "master")
			throw new OwnershipError("activation_owner_invalid", "Only master-owned workers can transition to active.");
		if (
			this.#lifecycle !== "owned_unprompted" &&
			this.#lifecycle !== "prompt_pending" &&
			this.#lifecycle !== "active"
		)
			throw new OwnershipError("lifecycle_transition_invalid", "Worker is not awaiting activation.");
		this.#lifecycle = "active";
		return this.drain();
	}

	markTerminal(): void {
		if (!this.isActive)
			throw new OwnershipError("lifecycle_transition_invalid", "Only an active worker can become terminal.");
		this.#lifecycle = "terminal";
	}

	drain(): readonly QuarantinedWorkerEvent[] {
		if (this.#drained) return [];
		this.#drained = true;
		const drained = this.#quarantined.map(event => ({ ...event }));
		this.#quarantined = [];
		return drained;
	}

	pendingQuarantine(): readonly QuarantinedWorkerEvent[] {
		return this.#quarantined.map(event => ({ ...event }));
	}
}

function routeForOwner(owner: MasterOwner): WorkerEventRoute {
	if (owner.kind === "master") return { disposition: "master", owner: clone(owner), masterName: owner.masterName };
	return { disposition: "user", owner: { kind: "user" } };
}

export function createWorkerEventFence(options: WorkerEventFenceOptions): WorkerEventFence {
	return new WorkerEventFence(options);
}

export const createWorkerFence = createWorkerEventFence;
export const createPreActiveWorkerFence = createWorkerEventFence;

export function quarantineWorkerEvent(fence: WorkerEventFence, event: unknown): WorkerEventRoute {
	return fence.record(event);
}

export const fenceWorkerEvent = quarantineWorkerEvent;

export function activateWorkerFence(fence: WorkerEventFence): readonly QuarantinedWorkerEvent[] {
	return fence.activate();
}

export const activateWorkerEventFence = activateWorkerFence;

export function drainWorkerQuarantine(fence: WorkerEventFence): readonly QuarantinedWorkerEvent[] {
	return fence.drain();
}

export function routeWorkerEvent(
	owner: MasterOwner | undefined,
	fence: WorkerEventFence | undefined,
	event: unknown,
): WorkerEventRoute {
	if (fence !== undefined) return fence.record(event);
	if (owner === undefined) return { disposition: "quarantined", quarantineId: `unknown-owner:${randomUUID()}` };
	return routeForOwner(normalizeOwner(owner));
}

export class OwnershipLedger {
	readonly #owners = new Map<string, MasterOwner>();
	readonly #fences = new Map<string, WorkerEventFence>();

	assignOwner(workerSessionId: string, owner: MasterOwner): MasterOwner {
		assertOpaqueId(workerSessionId, "workerSessionId");
		const normalized = normalizeOwner(owner);
		const existing = this.#owners.get(workerSessionId);
		if (existing !== undefined) {
			if (!ownerEquals(existing, normalized))
				throw new OwnershipError(
					"owner_already_assigned",
					`Worker ${workerSessionId} already has a different owner.`,
				);
			return clone(existing);
		}
		this.#owners.set(workerSessionId, normalized);
		return clone(normalized);
	}

	transferOwner(workerSessionId: string, owner: MasterOwner): MasterOwner {
		assertOpaqueId(workerSessionId, "workerSessionId");
		const normalized = normalizeOwner(owner);
		const existing = this.#owners.get(workerSessionId);
		if (existing === undefined)
			throw new OwnershipError("owner_missing", `Worker ${workerSessionId} has no durable owner.`);
		if (ownerEquals(existing, normalized)) return clone(existing);
		this.#owners.set(workerSessionId, normalized);
		const fence = this.#fences.get(workerSessionId);
		if (fence !== undefined) fence.setOwner(normalized);
		return clone(normalized);
	}

	registerUser(workerSessionId: string): MasterOwner {
		const owner = this.assignOwner(workerSessionId, { kind: "user" });
		if (!this.#fences.has(workerSessionId))
			this.#fences.set(
				workerSessionId,
				new WorkerEventFence({ workerSessionId, owner, lifecycle: "user_registered" }),
			);
		return owner;
	}

	assignMaster(workerSessionId: string, masterName: string): MasterOwner {
		const owner = this.assignOwner(workerSessionId, { kind: "master", masterName });
		if (!this.#fences.has(workerSessionId))
			this.#fences.set(
				workerSessionId,
				new WorkerEventFence({ workerSessionId, owner, lifecycle: "owned_unprompted" }),
			);
		return owner;
	}

	getOwner(workerSessionId: string): MasterOwner | null {
		assertOpaqueId(workerSessionId, "workerSessionId");
		const owner = this.#owners.get(workerSessionId);
		return owner === undefined ? null : clone(owner);
	}

	requireOwner(workerSessionId: string): MasterOwner {
		const owner = this.getOwner(workerSessionId);
		if (owner === null) throw new OwnershipError("owner_missing", `Worker ${workerSessionId} has no durable owner.`);
		return owner;
	}

	ownerCount(workerSessionId: string): number {
		return this.#owners.has(workerSessionId) ? 1 : 0;
	}

	owners(): ReadonlyMap<string, MasterOwner> {
		return new Map([...this.#owners.entries()].map(([id, owner]) => [id, clone(owner)] as const));
	}

	beginWorker(workerSessionId: string, masterName: string, fence = 1): WorkerEventFence {
		const owner = this.assignMaster(workerSessionId, masterName);
		const existing = this.#fences.get(workerSessionId);
		if (existing !== undefined) return existing;
		const created = new WorkerEventFence({ workerSessionId, owner, fence, lifecycle: "owned_unprompted" });
		this.#fences.set(workerSessionId, created);
		return created;
	}

	registerUserWorker(workerSessionId: string): WorkerEventFence {
		this.registerUser(workerSessionId);
		return this.#fences.get(workerSessionId)!;
	}

	getFence(workerSessionId: string): WorkerEventFence | null {
		return this.#fences.get(workerSessionId) ?? null;
	}

	recordWorkerEvent(workerSessionId: string, event: unknown): WorkerEventRoute {
		const fence = this.#fences.get(workerSessionId);
		if (fence === undefined) return { disposition: "quarantined", quarantineId: `unknown-worker:${randomUUID()}` };
		return fence.record(event);
	}

	activateWorker(workerSessionId: string): readonly QuarantinedWorkerEvent[] {
		const fence = this.#fences.get(workerSessionId);
		if (fence === undefined) throw new OwnershipError("worker_missing", `Worker ${workerSessionId} has no fence.`);
		return fence.activate();
	}

	drainWorker(workerSessionId: string): readonly QuarantinedWorkerEvent[] {
		const fence = this.#fences.get(workerSessionId);
		if (fence === undefined) return [];
		return fence.drain();
	}
}

export const WorkerOwnershipLedger = OwnershipLedger;
export const OwnershipPolicy = OwnershipLedger;
export const MasterOwnership = OwnershipLedger;

export function assertSingleOwner(owners: ReadonlyMap<string, MasterOwner>, workerSessionId: string): MasterOwner {
	assertOpaqueId(workerSessionId, "workerSessionId");
	const owner = owners.get(workerSessionId);
	if (owner === undefined)
		throw new OwnershipError("owner_missing", `Worker ${workerSessionId} must have exactly one owner.`);
	return normalizeOwner(owner);
}

export const requireSingleOwner = assertSingleOwner;

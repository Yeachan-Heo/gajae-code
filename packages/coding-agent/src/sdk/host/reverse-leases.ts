import { createHash, randomUUID } from "node:crypto";
import type { SdkFrame } from "./types";

export const REVERSE_HEARTBEAT_MS = 5_000;
export const REVERSE_LEASE_TTL_MS = 15_000;
export const REVERSE_RECLAIM_GRACE_MS = 15_000;
export const MAX_REVERSE_OUTSTANDING = 64;
export const MAX_REVERSE_PAYLOAD_BYTES = 256 * 1024;

export class ReverseLeaseError extends Error {
	constructor(
		readonly code:
			| "lease_unavailable"
			| "lease_expired"
			| "provider_lease_conflict"
			| "provider_required"
			| "not_lease_owner"
			| "payload_too_large"
			| "too_many_outstanding"
			| "unknown_request"
			| "idempotency_conflict",
		message = code,
	) {
		super(message);
	}
}

export interface ProviderLease {
	leaseId: string;
	connectionId: string;
	capability: string;
	definitions: unknown;
	expiresAt: number;
	graceUntil?: number;
	active: boolean;
}

interface Outstanding {
	connectionId: string;
	capability: string;
	leaseId: string;
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

export interface ReverseLeaseOptions {
	now?: () => number;
	leaseTtlMs?: number;
	sendFrame: (connectionId: string, frame: SdkFrame) => void | Promise<void>;
	installDefinitions?: (capability: string, definitions: unknown) => void;
	onCancel?: (requestId: string, reason: "provider_disconnected" | "lease_released") => void;
	onDefinitionsRemoved?: (capability: string) => void;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function registrationFingerprint(capability: string, definitions: unknown, expectedLeaseId?: string): string {
	return createHash("sha256")
		.update(canonicalJson({ capability, definitions, expectedLeaseId: expectedLeaseId ?? null }))
		.digest("hex");
}

/** Session-local directed reverse RPC lease registry. */
export class ReverseLeaseRuntime {
	readonly #now: () => number;
	readonly #leaseTtlMs: number;
	readonly #sendFrame: ReverseLeaseOptions["sendFrame"];
	readonly #installDefinitions?: ReverseLeaseOptions["installDefinitions"];
	readonly #onDefinitionsRemoved?: ReverseLeaseOptions["onDefinitionsRemoved"];
	readonly #onCancel?: ReverseLeaseOptions["onCancel"];
	readonly #leases = new Map<string, ProviderLease>();
	readonly #idempotency = new Map<string, { fingerprint: string; lease: ProviderLease }>();
	readonly #outstanding = new Map<string, Outstanding>();
	readonly #installedCapabilities = new Set<string>();
	readonly #sweepTimer: ReturnType<typeof setInterval>;
	#disposing = false;

	constructor(options: ReverseLeaseOptions) {
		this.#now = options.now ?? Date.now;
		this.#leaseTtlMs = options.leaseTtlMs ?? REVERSE_LEASE_TTL_MS;
		this.#sendFrame = options.sendFrame;
		this.#installDefinitions = options.installDefinitions;
		this.#onDefinitionsRemoved = options.onDefinitionsRemoved;
		this.#onCancel = options.onCancel;
		this.#sweepTimer = setInterval(() => this.#expireStaleLeases(), Math.max(1, this.#leaseTtlMs / 3));
		this.#sweepTimer.unref?.();
	}

	registerProvider(
		connectionId: string,
		capability: string,
		definitions: unknown,
		expectedLeaseId?: string,
		idempotencyKey?: string,
	): ProviderLease {
		if (this.#disposing) throw new Error("reverse runtime is disposing");
		const key = `${connectionId}\u0000${idempotencyKey ?? ""}`;
		const fingerprint = registrationFingerprint(capability, definitions, expectedLeaseId);
		const replay = idempotencyKey ? this.#idempotency.get(key) : undefined;
		if (replay) {
			if (replay.fingerprint !== fingerprint) throw new ReverseLeaseError("idempotency_conflict");
			const current = this.#leases.get(capability);
			if (replay.lease === current && current?.active && current.expiresAt > this.#now()) return { ...replay.lease };
		}
		const now = this.#now();
		const existing = this.#leases.get(capability);
		if (existing && existing.expiresAt <= now) this.#removeDefinitions(existing.capability);
		const pendingHandoff = existing?.active === false && existing.expiresAt > now;
		if (pendingHandoff) {
			if (existing!.connectionId !== connectionId || existing!.leaseId !== expectedLeaseId)
				throw new ReverseLeaseError("provider_lease_conflict");
			this.#installDefinitionsFor(capability, definitions);
			const lease: ProviderLease = {
				leaseId: existing!.leaseId,
				connectionId,
				capability,
				definitions,
				expiresAt: now + this.#leaseTtlMs,
				active: true,
			};
			this.#leases.set(capability, lease);
			if (idempotencyKey) this.#idempotency.set(key, { fingerprint, lease });
			return { ...lease };
		}
		const reclaiming =
			existing?.leaseId === expectedLeaseId && existing?.graceUntil !== undefined && now <= existing.graceUntil;
		const refreshing =
			existing?.active !== false && existing?.connectionId === connectionId && existing.expiresAt > now;
		if (existing && !reclaiming && !refreshing && existing.connectionId !== connectionId && existing.expiresAt > now)
			throw new ReverseLeaseError("provider_lease_conflict");
		this.#installDefinitionsFor(capability, definitions);
		const lease: ProviderLease = {
			leaseId: reclaiming || refreshing ? existing!.leaseId : randomUUID(),
			connectionId,
			capability,
			definitions,
			expiresAt: now + this.#leaseTtlMs,
			active: true,
		};
		this.#leases.set(capability, lease);
		if (idempotencyKey) this.#idempotency.set(key, { fingerprint, lease });
		return { ...lease };
	}

	heartbeat(connectionId: string, leaseId: string): ProviderLease {
		const lease = this.#owner(connectionId, leaseId);
		if (lease.expiresAt <= this.#now()) {
			this.#removeDefinitions(lease.capability);
			throw new ReverseLeaseError("lease_expired");
		}
		lease.expiresAt = this.#now() + this.#leaseTtlMs;
		lease.graceUntil = undefined;
		return { ...lease };
	}

	release(connectionId: string, leaseId: string, handoffTo?: string): ProviderLease {
		const lease = this.#owner(connectionId, leaseId);
		this.#cancelForConnection(connectionId, "lease_released");
		this.#removeDefinitions(lease.capability);
		if (handoffTo) {
			lease.connectionId = handoffTo;
			lease.expiresAt = this.#now() + REVERSE_RECLAIM_GRACE_MS;
			lease.graceUntil = undefined;
			lease.active = false;
			return { ...lease };
		}
		this.#leases.delete(lease.capability);
		return { ...lease };
	}

	disconnect(connectionId: string): void {
		const now = this.#now();
		for (const lease of this.#leases.values())
			if (lease.connectionId === connectionId) {
				lease.expiresAt = now;
				lease.graceUntil = now + REVERSE_RECLAIM_GRACE_MS;
				this.#removeDefinitions(lease.capability);
			}
		this.#cancelForConnection(connectionId, "provider_disconnected");
	}

	request(capability: string, method: string, payload: unknown): Promise<unknown> {
		if (this.#disposing) throw new Error("reverse runtime is disposing");
		this.#assertPayload(payload);
		const lease = this.#liveLease(capability);
		if (!lease) {
			const reservation = this.#leases.get(capability);
			if (reservation?.active === false && reservation.expiresAt > this.#now())
				throw new ReverseLeaseError("lease_unavailable");
			throw new ReverseLeaseError("provider_required");
		}
		if (this.#outstanding.size >= MAX_REVERSE_OUTSTANDING) throw new ReverseLeaseError("too_many_outstanding");
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.#outstanding.set(id, {
				connectionId: lease.connectionId,
				capability,
				leaseId: lease.leaseId,
				resolve,
				reject,
			});
			let delivery: void | Promise<void>;
			try {
				delivery = this.#sendFrame(lease.connectionId, {
					type: "reverse_request",
					id,
					capability,
					connectionId: lease.connectionId,
					leaseId: lease.leaseId,
					payload: { method, payload },
				});
			} catch (error) {
				this.#outstanding.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			Promise.resolve(delivery).catch(error => {
				this.#outstanding.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	respond(
		connectionId: string,
		id: string,
		leaseId: string,
		result: unknown,
		error?: { code: string; message: string },
	): void {
		this.#assertPayload(result);
		const request = this.#outstanding.get(id);
		if (!request) throw new ReverseLeaseError("unknown_request");
		if (request.connectionId !== connectionId || request.leaseId !== leaseId)
			throw new ReverseLeaseError("not_lease_owner");
		this.#outstanding.delete(id);
		if (error) {
			const rejection = new Error(error.message);
			rejection.name = error.code;
			request.reject(rejection);
		} else request.resolve(result);
	}

	getLease(capability: string): ProviderLease | undefined {
		const lease = this.#liveLease(capability);
		return lease && { ...lease };
	}

	/** Installed definitions are observable only while their provider lease is live. */
	getInstalledDefinitions(capability: string): unknown | undefined {
		return this.#liveLease(capability)?.definitions;
	}

	dispose(): void {
		if (this.#disposing) return;
		this.#disposing = true;
		clearInterval(this.#sweepTimer);
		const outstanding = [...this.#outstanding.entries()];
		const installedCapabilities = [...this.#installedCapabilities];
		this.#outstanding.clear();
		this.#installedCapabilities.clear();
		this.#leases.clear();
		this.#idempotency.clear();
		for (const [id, request] of outstanding) {
			request.reject(new Error("request_cancelled"));
			try {
				this.#onCancel?.(id, "lease_released");
			} catch {}
		}
		for (const capability of installedCapabilities) {
			try {
				this.#onDefinitionsRemoved?.(capability);
			} catch {}
		}
		this.#disposing = false;
	}

	#owner(connectionId: string, leaseId: string): ProviderLease {
		const lease = [...this.#leases.values()].find(candidate => candidate.leaseId === leaseId);
		if (!lease?.active || lease.connectionId !== connectionId) throw new ReverseLeaseError("not_lease_owner");
		return lease;
	}
	#liveLease(capability: string): ProviderLease | undefined {
		const lease = this.#leases.get(capability);
		if (!lease?.active || lease.expiresAt <= this.#now()) {
			if (lease?.expiresAt !== undefined && lease.expiresAt <= this.#now()) this.#removeDefinitions(capability);
			return undefined;
		}
		return lease;
	}
	#expireStaleLeases(): void {
		for (const lease of this.#leases.values())
			if (lease.expiresAt <= this.#now()) this.#removeDefinitions(lease.capability);
	}
	#cancelForConnection(connectionId: string, reason: "provider_disconnected" | "lease_released"): void {
		for (const [id, request] of this.#outstanding)
			if (request.connectionId === connectionId) {
				this.#outstanding.delete(id);
				request.reject(new Error("request_cancelled"));
				this.#onCancel?.(id, reason);
			}
	}
	#installDefinitionsFor(capability: string, definitions: unknown): void {
		this.#installDefinitions?.(capability, definitions);
		this.#installedCapabilities.add(capability);
	}
	#removeDefinitions(capability: string): void {
		if (!this.#installedCapabilities.delete(capability)) return;
		this.#onDefinitionsRemoved?.(capability);
	}
	#assertPayload(payload: unknown): void {
		const encoded = JSON.stringify(payload);
		if (encoded !== undefined && Buffer.byteLength(encoded) > MAX_REVERSE_PAYLOAD_BYTES)
			throw new ReverseLeaseError("payload_too_large");
	}
}

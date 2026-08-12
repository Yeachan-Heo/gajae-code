import { randomBytes } from "node:crypto";
import type { MasterOwner, MasterProvider } from "./types";

export interface ProviderIngress {
	readonly kind: "provider";
	readonly provider: MasterProvider;
	readonly channelId: string;
	readonly messageId: string;
	readonly actorId: string;
}

export type ClaimAuthorizationState = "unused" | "consumed" | "expired";
export type OwnershipClaimStatus = "pending_approval" | "approved" | "expired" | "rejected";

export interface ClaimRequestAuthorization {
	readonly authorizationId: string;
	readonly workerSessionId: string;
	readonly requestedMasterName: string;
	readonly ingress: ProviderIngress;
	readonly actorId: string;
	readonly channelId: string;
	readonly messageId: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly state: ClaimAuthorizationState;
}

export interface OwnershipClaim {
	readonly claimId: string;
	readonly authorizationId: string;
	readonly workerSessionId: string;
	readonly requestedMasterName: string;
	readonly requestIngress: ProviderIngress;
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly previousOwner: MasterOwner;
	readonly status: OwnershipClaimStatus;
	readonly approvalIngress: ProviderIngress | null;
	readonly approvedAt: string | null;
}

export interface ClaimAuthorizationMintInput {
	readonly workerSessionId: string;
	readonly requestedMasterName: string;
	readonly ingress: ProviderIngress;
	readonly ttlMs?: number;
	readonly expiresAt?: string;
	readonly idempotencyKey?: string;
}

export interface ModelClaimRequestInput {
	readonly authorizationId: string;
	readonly workerSessionId: string;
	readonly requestedMasterName: string;
	readonly actorKind?: "model";
}

export interface ClaimApprovalInput {
	readonly claimId: string;
	readonly ingress: ProviderIngress;
	readonly actorKind?: "user" | "model";
	readonly authenticated?: boolean;
	readonly idempotencyKey?: string;
}

export interface ClaimApprovalResult {
	readonly claimId: string;
	readonly status: "approved" | "already_approved";
	readonly owner: { kind: "master"; masterName: string };
}

export interface ClaimAuthorizationStoreOptions {
	readonly now?: () => Date;
	readonly defaultTtlMs?: number;
	readonly isBoundIngress?: (ingress: ProviderIngress) => boolean;
	readonly ownership?: OwnershipSink;
}

export interface OwnershipSink {
	getOwner(workerSessionId: string): MasterOwner | null;
	assignOwner(workerSessionId: string, owner: MasterOwner): MasterOwner;
	transferOwner?(workerSessionId: string, owner: MasterOwner): MasterOwner;
}

export class ClaimAuthorizationError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.name = "ClaimAuthorizationError";
		this.code = code;
	}
}

const MASTER_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const OPAQUE_ID = /^[\x20-\x7e]{1,128}$/;
const PROVIDERS = new Set<MasterProvider>(["telegram", "discord"]);
const MAX_TTL_MS = 86_400_000;
const DEFAULT_TTL_MS = 300_000;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function opaque(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !OPAQUE_ID.test(value))
		throw new ClaimAuthorizationError(
			"claim_authorization_invalid",
			`${field} must be an opaque printable identifier.`,
		);
}

function text(value: unknown, field: string): asserts value is string {
	opaque(value, field);
}

function ingress(value: unknown): asserts value is ProviderIngress {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new ClaimAuthorizationError("claim_ingress_invalid", "Claim ingress must be a provider ingress object.");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.kind !== "provider" ||
		typeof candidate.provider !== "string" ||
		!PROVIDERS.has(candidate.provider as MasterProvider)
	)
		throw new ClaimAuthorizationError("claim_ingress_invalid", "Claim ingress provider is invalid.");
	if (Object.keys(candidate).length !== 5)
		throw new ClaimAuthorizationError("claim_ingress_invalid", "Claim ingress contains extra fields.");
	text(candidate.channelId, "channelId");
	text(candidate.messageId, "messageId");
	text(candidate.actorId, "actorId");
}

function copyIngress(value: ProviderIngress): ProviderIngress {
	return {
		kind: "provider",
		provider: value.provider,
		channelId: value.channelId,
		messageId: value.messageId,
		actorId: value.actorId,
	};
}

function sameIngressActor(left: ProviderIngress, right: ProviderIngress): boolean {
	return left.provider === right.provider && left.channelId === right.channelId && left.actorId === right.actorId;
}

function canonicalTimestamp(date: Date, field: string): string {
	if (!Number.isFinite(date.getTime()))
		throw new ClaimAuthorizationError("claim_timestamp_invalid", `${field} must be a valid timestamp.`);
	return date.toISOString();
}

function parseExpiry(value: string, nowMs: number): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || parsed <= nowMs)
		throw new ClaimAuthorizationError(
			"claim_authorization_expired",
			"Claim authorization expiry must be in the future.",
		);
	return new Date(parsed).toISOString();
}

function randomOpaqueId(): string {
	return randomBytes(24).toString("base64url");
}

function defaultUserOwner(): MasterOwner {
	return { kind: "user" };
}

export class ClaimAuthorizationStore {
	readonly #now: () => Date;
	readonly #defaultTtlMs: number;
	readonly #isBoundIngress: (ingressValue: ProviderIngress) => boolean;
	readonly #ownership: OwnershipSink | null;
	readonly #authorizations = new Map<string, ClaimRequestAuthorization>();
	readonly #claims = new Map<string, OwnershipClaim>();
	readonly #mintIdempotency = new Map<string, { digest: string; authorizationId: string }>();
	readonly #approvalIdempotency = new Map<string, { digest: string; result: ClaimApprovalResult }>();

	constructor(options: ClaimAuthorizationStoreOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		const ttlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
			throw new ClaimAuthorizationError(
				"claim_ttl_invalid",
				"Claim authorization TTL is outside the permitted range.",
			);
		this.#defaultTtlMs = ttlMs;
		this.#isBoundIngress = options.isBoundIngress ?? (() => false);
		this.#ownership = options.ownership ?? null;
	}

	mint(input: ClaimAuthorizationMintInput): ClaimRequestAuthorization {
		text(input.workerSessionId, "workerSessionId");
		if (!MASTER_NAME.test(input.requestedMasterName))
			throw new ClaimAuthorizationError("claim_master_invalid", "requestedMasterName is not canonical.");
		ingress(input.ingress);
		if (!this.#isBoundIngress(input.ingress))
			throw new ClaimAuthorizationError(
				"claim_ingress_unbound",
				"Claim ingress is not bound to the requested master channel.",
			);
		const now = this.#now();
		const issuedAt = canonicalTimestamp(now, "issuedAt");
		const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
			throw new ClaimAuthorizationError(
				"claim_ttl_invalid",
				"Claim authorization TTL is outside the permitted range.",
			);
		const expiresAt =
			input.expiresAt === undefined
				? new Date(now.getTime() + ttlMs).toISOString()
				: parseExpiry(input.expiresAt, now.getTime());
		const requestDigest = JSON.stringify({
			workerSessionId: input.workerSessionId,
			requestedMasterName: input.requestedMasterName,
			ingress: input.ingress,
			expiresAt,
		});
		if (input.idempotencyKey !== undefined) {
			opaque(input.idempotencyKey, "idempotencyKey");
			const prior = this.#mintIdempotency.get(input.idempotencyKey);
			if (prior !== undefined) {
				if (prior.digest !== requestDigest)
					throw new ClaimAuthorizationError(
						"claim_idempotency_conflict",
						"Claim authorization idempotency key was reused with different input.",
					);
				return clone(this.#authorizations.get(prior.authorizationId)!);
			}
		}
		const authorization: ClaimRequestAuthorization = {
			authorizationId: randomOpaqueId(),
			workerSessionId: input.workerSessionId,
			requestedMasterName: input.requestedMasterName,
			ingress: copyIngress(input.ingress),
			actorId: input.ingress.actorId,
			channelId: input.ingress.channelId,
			messageId: input.ingress.messageId,
			issuedAt,
			expiresAt,
			state: "unused",
		};
		this.#authorizations.set(authorization.authorizationId, authorization);
		if (input.idempotencyKey !== undefined)
			this.#mintIdempotency.set(input.idempotencyKey, {
				digest: requestDigest,
				authorizationId: authorization.authorizationId,
			});
		return clone(authorization);
	}

	mintClaimAuthorization(input: ClaimAuthorizationMintInput): ClaimRequestAuthorization {
		return this.mint(input);
	}

	consumeForModel(input: ModelClaimRequestInput): OwnershipClaim {
		if (input.actorKind !== undefined && input.actorKind !== "model")
			throw new ClaimAuthorizationError(
				"claim_request_actor_invalid",
				"Claim request consumption is reserved for the model path.",
			);
		opaque(input.authorizationId, "authorizationId");
		text(input.workerSessionId, "workerSessionId");
		if (!MASTER_NAME.test(input.requestedMasterName))
			throw new ClaimAuthorizationError("claim_master_invalid", "requestedMasterName is not canonical.");
		const authorization = this.#authorizations.get(input.authorizationId);
		if (authorization === undefined)
			throw new ClaimAuthorizationError("claim_authorization_invalid", "Claim authorization is unknown or forged.");
		const now = this.#now();
		if (Date.parse(authorization.expiresAt) <= now.getTime()) {
			this.#authorizations.set(authorization.authorizationId, { ...authorization, state: "expired" });
			throw new ClaimAuthorizationError("claim_authorization_expired", "Claim authorization has expired.");
		}
		if (authorization.state !== "unused")
			throw new ClaimAuthorizationError("claim_authorization_consumed", "Claim authorization was already consumed.");
		if (
			authorization.workerSessionId !== input.workerSessionId ||
			authorization.requestedMasterName !== input.requestedMasterName
		)
			throw new ClaimAuthorizationError(
				"claim_authorization_mismatch",
				"Claim authorization target does not match the requested worker/master.",
			);
		const previousOwner = this.#ownership?.getOwner(input.workerSessionId) ?? defaultUserOwner();
		const claim: OwnershipClaim = {
			claimId: randomOpaqueId(),
			authorizationId: authorization.authorizationId,
			workerSessionId: authorization.workerSessionId,
			requestedMasterName: authorization.requestedMasterName,
			requestIngress: copyIngress(authorization.ingress),
			requestedAt: canonicalTimestamp(now, "requestedAt"),
			expiresAt: authorization.expiresAt,
			previousOwner: clone(previousOwner),
			status: "pending_approval",
			approvalIngress: null,
			approvedAt: null,
		};
		this.#authorizations.set(authorization.authorizationId, { ...authorization, state: "consumed" });
		this.#claims.set(claim.claimId, claim);
		return clone(claim);
	}

	consumeClaimAuthorization(input: ModelClaimRequestInput): OwnershipClaim {
		return this.consumeForModel(input);
	}

	approve(input: ClaimApprovalInput): ClaimApprovalResult {
		if (input.actorKind === "model")
			throw new ClaimAuthorizationError("claim_approval_forbidden", "Models cannot approve ownership claims.");
		if (input.actorKind !== undefined && input.actorKind !== "user")
			throw new ClaimAuthorizationError(
				"claim_approval_forbidden",
				"Only authenticated users may approve ownership claims.",
			);
		if (input.authenticated !== true)
			throw new ClaimAuthorizationError(
				"claim_approval_forbidden",
				"Claim approval requires a separately authenticated user ingress.",
			);
		opaque(input.claimId, "claimId");
		ingress(input.ingress);
		if (!this.#isBoundIngress(input.ingress))
			throw new ClaimAuthorizationError(
				"claim_ingress_unbound",
				"Claim approval ingress is not bound to the requested master channel.",
			);
		const claim = this.#claims.get(input.claimId);
		if (claim === undefined) throw new ClaimAuthorizationError("claim_not_found", "Ownership claim is unknown.");
		const requestDigest = JSON.stringify({ claimId: input.claimId, ingress: input.ingress });
		if (input.idempotencyKey !== undefined) {
			opaque(input.idempotencyKey, "idempotencyKey");
			const prior = this.#approvalIdempotency.get(input.idempotencyKey);
			if (prior !== undefined) {
				if (prior.digest !== requestDigest)
					throw new ClaimAuthorizationError(
						"claim_idempotency_conflict",
						"Claim approval idempotency key was reused with different input.",
					);
				return clone(prior.result);
			}
		}
		const now = this.#now();
		if (Date.parse(claim.expiresAt) <= now.getTime()) {
			this.#claims.set(claim.claimId, { ...claim, status: "expired" });
			throw new ClaimAuthorizationError("claim_authorization_expired", "Ownership claim has expired.");
		}
		if (!sameIngressActor(claim.requestIngress, input.ingress))
			throw new ClaimAuthorizationError(
				"claim_approval_actor_mismatch",
				"Claim approval actor/channel does not match the requesting actor.",
			);
		if (input.ingress.messageId === claim.requestIngress.messageId)
			throw new ClaimAuthorizationError(
				"claim_approval_not_distinct",
				"Claim approval must use a distinct authenticated interaction.",
			);
		if (claim.status === "approved") {
			const result: ClaimApprovalResult = {
				claimId: claim.claimId,
				status: "already_approved",
				owner: { kind: "master", masterName: claim.requestedMasterName },
			};
			if (input.idempotencyKey !== undefined)
				this.#approvalIdempotency.set(input.idempotencyKey, { digest: requestDigest, result });
			return clone(result);
		}
		if (claim.status !== "pending_approval")
			throw new ClaimAuthorizationError("claim_not_pending", "Ownership claim is not awaiting approval.");
		const nextOwner: MasterOwner = { kind: "master", masterName: claim.requestedMasterName };
		if (this.#ownership !== null) {
			const currentOwner = this.#ownership.getOwner(claim.workerSessionId);
			if (
				currentOwner !== null &&
				(currentOwner.kind !== claim.previousOwner.kind ||
					(currentOwner.kind === "master" &&
						claim.previousOwner.kind === "master" &&
						currentOwner.masterName !== claim.previousOwner.masterName))
			)
				throw new ClaimAuthorizationError(
					"claim_owner_conflict",
					"Worker ownership changed before claim approval.",
				);
			if (this.#ownership.transferOwner !== undefined)
				this.#ownership.transferOwner(claim.workerSessionId, nextOwner);
			else this.#ownership.assignOwner(claim.workerSessionId, nextOwner);
		}
		const approvalIngress = copyIngress(input.ingress);
		this.#claims.set(claim.claimId, {
			...claim,
			status: "approved",
			approvalIngress,
			approvedAt: canonicalTimestamp(now, "approvedAt"),
		});
		const result: ClaimApprovalResult = {
			claimId: claim.claimId,
			status: "approved",
			owner: { kind: "master", masterName: claim.requestedMasterName },
		};
		if (input.idempotencyKey !== undefined)
			this.#approvalIdempotency.set(input.idempotencyKey, { digest: requestDigest, result });
		return clone(result);
	}

	approveClaim(input: ClaimApprovalInput): ClaimApprovalResult {
		return this.approve(input);
	}

	getAuthorization(authorizationId: string): ClaimRequestAuthorization | null {
		opaque(authorizationId, "authorizationId");
		const value = this.#authorizations.get(authorizationId);
		return value === undefined ? null : clone(value);
	}

	getClaim(claimId: string): OwnershipClaim | null {
		opaque(claimId, "claimId");
		const value = this.#claims.get(claimId);
		return value === undefined ? null : clone(value);
	}

	listClaims(): readonly OwnershipClaim[] {
		return [...this.#claims.values()].map(claim => clone(claim));
	}
}

export const ClaimAuthorizations = ClaimAuthorizationStore;
export const OwnershipClaimStore = ClaimAuthorizationStore;
export const ClaimAuthorizationLedger = ClaimAuthorizationStore;

export function mintClaimRequestAuthorization(
	store: ClaimAuthorizationStore,
	input: ClaimAuthorizationMintInput,
): ClaimRequestAuthorization {
	return store.mint(input);
}

export function consumeClaimAuthorizationForModel(
	store: ClaimAuthorizationStore,
	input: ModelClaimRequestInput,
): OwnershipClaim {
	return store.consumeForModel(input);
}

export function approveOwnershipClaim(store: ClaimAuthorizationStore, input: ClaimApprovalInput): ClaimApprovalResult {
	return store.approve(input);
}

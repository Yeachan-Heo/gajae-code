import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SpawnClaimV2 = {
	version: 2;
	claimId: string;
	lifecycleIdentity: string;
	/** Opaque binding of the raw selector request, retained for catalog-independent replay. */
	requestBindingMac?: string;
	bindingMac: string;
	state:
		| "prepared"
		| "substrate_starting"
		| "authority_active"
		| "seed_prepared"
		| "dispatching"
		| "accepted"
		| "pre_send_rejected"
		| "uncertain"
		| "closed";
	failure?: SpawnSubstrateFailure;
	preSendLease?: { epoch: string; status: "owned" | "consumed" };
	childId?: string;
	seed?: SeedDeliveryV2;
	authorityRef?: string;
	createdAt: number;
	updatedAt: number;
};

export type SpawnSubstrateFailure = {
	substrateKind: "tmux" | "psmux" | "headless";
	code: string;
	message: string;
};

export type SeedDeliveryV2 = {
	version: 2;
	phase: "prepared" | "dispatching" | "accepted" | "pre_send_rejected" | "uncertain";
	clientRef: string;
	commandId?: string;
	turnId?: string;
	acceptedAt?: number;
	lastQ26Status?: "accepted" | "in_flight" | "terminal_ok" | "failed" | "unknown";
	observedAt?: number;
};

/** Live-only capability check. Implementations must not retain either argument. */
export interface MasterCapabilityVerifier {
	verifyMasterCapability(
		ownerSessionId: string,
		rawCapability: string,
		attestationEpoch: string,
	): Promise<{ allowed: boolean }>;
}

/** Structured, shell-free child launch contract owned by the Broker. */
export interface SpawnSubstrateLaunchSpec {
	childSessionId: string;
	cwd: string;
	argv: readonly string[];
	/** Broker-inherited values are filtered to the portable launch subset. */
	inheritedEnv?: Readonly<Record<string, string>>;
	/** Child-specific values are part of this spec and must be shell-safe. */
	env?: Readonly<Record<string, string>>;
}

/** Durable facts required to re-prove one spawned substrate without task material. */
export type SpawnSubstrateProof = {
	substrateKind: "tmux" | "psmux" | "headless";
	providerIdentity: string;
	nativeSessionId?: string;
	pid?: number;
	processIncarnation?: string;
	ownerGeneration?: number;
	stateFileProof?: Readonly<Record<string, string | number>>;
};

export interface SpawnSubstrateProvider {
	launch(
		spec: SpawnSubstrateLaunchSpec,
	): Promise<
		| { ok: true; proof: SpawnSubstrateProof }
		| { ok: false; code: "substrate_unavailable" | "substrate_proof_failed"; message: string }
	>;
	verify(proof: SpawnSubstrateProof): Promise<"verified" | "mismatch" | "gone">;
	close(proof: SpawnSubstrateProof): Promise<{ ok: boolean; code?: string }>;
}

export type SpawnAuthorityCloseState = "active" | "close_requested" | "closed" | "uncertain";

/**
 * Exact, durable ownership evidence for a child substrate. It is deliberately
 * structural: request text, capability material, and their derivatives never
 * belong in this record.
 */
export type SpawnAuthorityV1 = {
	version: 1;
	authorityId: string;
	claimId: string;
	childId: string;
	ownerSessionId: string;
	lifecycleIdentity: string;
	substrateKind: SpawnSubstrateProof["substrateKind"];
	providerIdentity: string;
	nativeSessionId?: string;
	pid?: number;
	processIncarnation?: string;
	ownerGeneration?: number;
	stateFileProof?: Readonly<Record<string, string | number>>;
	/**
	 * Identity of the child HOST endpoint proven at registration. Distinct from
	 * the substrate `pid`/`processIncarnation` above: proving the multiplexer
	 * substrate is intact says nothing about which host answers on that session
	 * id. Optional so pre-pin v1 rows still reopen; recovery treats an absent
	 * pin as missing authority and fails closed rather than matching by id.
	 */
	endpointGeneration?: number;
	endpointPid?: number;
	endpointIncarnation?: string;
	/** Launch locator, so a colliding generation/pid in another workspace cannot pass. */
	endpointCwd?: string;
	endpointStateRoot?: string;
	closeState: SpawnAuthorityCloseState;
	orphanedAt?: number;
	orphanRecoveredAt?: number;
	closeRequestedAt?: number;
	closedAt?: number;
	createdAt: number;
	updatedAt: number;
};

export type SpawnClaimTransition = {
	claimId: string;
	from: SpawnClaimV2["state"];
	to: SpawnClaimV2["state"];
	/** Required when the transition consumes the one pre-send lease. */
	leaseEpoch?: string;
	/** The fresh child ID is committed before substrate launch. */
	childId?: string;
	/** Required for seed and terminal state transitions that carry Q26 facts. */
	seed?: SeedDeliveryV2;
	failure?: SpawnSubstrateFailure;
	/** Required when exact substrate authority becomes active or closes. */
	authority?: SpawnAuthorityV1;
	/** Required to downgrade dispatching only when no frame was handed off. */
	provenNoHandoff?: true;
};

export type SpawnAuthorityTransitionResult = {
	claim: SpawnClaimV2;
	authority?: SpawnAuthorityV1;
};

export class SpawnAuthorityTransitionError extends Error {
	constructor(readonly code: "claim_not_found" | "stale_transition" | "illegal_transition" | "invalid_transition") {
		super("Spawn authority transition was rejected.");
		this.name = "SpawnAuthorityTransitionError";
	}
}

export type SpawnClaimDecision =
	| { kind: "owner"; claim: SpawnClaimV2; recovery: boolean }
	| { kind: "in_progress"; claim: SpawnClaimV2 }
	| { kind: "replay"; claim: SpawnClaimV2 }
	| { kind: "terminal"; claim: SpawnClaimV2 }
	| { kind: "terminal_uncertain"; claim: SpawnClaimV2 }
	| { kind: "idempotency_conflict"; claim: SpawnClaimV2 };

type StoredClaim = {
	version: 1;
	claim: SpawnClaimV2;
	authority?: SpawnAuthorityV1;
	integrity: string;
};

type SpawnAuthorityDurableWrite = {
	claim: SpawnClaimV2;
	authority?: SpawnAuthorityV1;
};

export interface SpawnAuthorityStoreOptions {
	/** Test-only hook that runs before the journal record becomes durable. */
	beforeSyncForTest?: (write: SpawnAuthorityDurableWrite) => Promise<void> | void;
	/** Test-only hook after both file and parent-directory fsync complete. */
	afterSyncForTest?: (write: SpawnAuthorityDurableWrite) => Promise<void> | void;
	/** Test-only hook between the file barrier and the parent-directory barrier. */
	beforeDirectorySyncForTest?: (write: SpawnAuthorityDurableWrite) => Promise<void> | void;
}

const CLAIM_STATES = new Set<SpawnClaimV2["state"]>([
	"prepared",
	"substrate_starting",
	"authority_active",
	"seed_prepared",
	"dispatching",
	"accepted",
	"pre_send_rejected",
	"uncertain",
	"closed",
]);
const SEED_PHASES = new Set<SeedDeliveryV2["phase"]>([
	"prepared",
	"dispatching",
	"accepted",
	"pre_send_rejected",
	"uncertain",
]);
const Q26_STATUSES = new Set<NonNullable<SeedDeliveryV2["lastQ26Status"]>>([
	"accepted",
	"in_flight",
	"terminal_ok",
	"failed",
	"unknown",
]);
const CLOSE_STATES = new Set<SpawnAuthorityCloseState>(["active", "close_requested", "closed", "uncertain"]);
const CLAIM_KEYS = new Set([
	"version",
	"claimId",
	"lifecycleIdentity",
	"requestBindingMac",
	"bindingMac",
	"state",
	"failure",
	"preSendLease",
	"childId",
	"seed",
	"authorityRef",
	"createdAt",
	"updatedAt",
]);
const SEED_KEYS = new Set([
	"version",
	"phase",
	"clientRef",
	"commandId",
	"turnId",
	"acceptedAt",
	"lastQ26Status",
	"observedAt",
]);
const AUTHORITY_KEYS = new Set([
	"version",
	"authorityId",
	"claimId",
	"childId",
	"ownerSessionId",
	"lifecycleIdentity",
	"substrateKind",
	"providerIdentity",
	"nativeSessionId",
	"pid",
	"processIncarnation",
	"ownerGeneration",
	"stateFileProof",
	"endpointGeneration",
	"endpointPid",
	"endpointIncarnation",
	"endpointCwd",
	"endpointStateRoot",
	"closeState",
	"orphanedAt",
	"orphanRecoveredAt",
	"closeRequestedAt",
	"closedAt",
	"createdAt",
	"updatedAt",
]);
const SUBSTRATE_KINDS = new Set<SpawnSubstrateProof["substrateKind"]>(["tmux", "psmux", "headless"]);
const FORBIDDEN_FIELD =
	/(?:task|prompt|capability|idempotency|fingerprint|requesthash|digest|credential|token|secret|password|stderr)/i;
const TRANSITION_EDGES: Readonly<Record<SpawnClaimV2["state"], readonly SpawnClaimV2["state"][]>> = {
	prepared: ["substrate_starting", "pre_send_rejected", "uncertain", "closed"],
	substrate_starting: ["authority_active", "pre_send_rejected", "uncertain", "closed"],
	authority_active: ["seed_prepared", "pre_send_rejected", "uncertain", "closed"],
	seed_prepared: ["dispatching", "pre_send_rejected", "uncertain", "closed"],
	dispatching: ["accepted", "pre_send_rejected", "uncertain", "closed"],
	accepted: ["uncertain", "closed"],
	pre_send_rejected: ["uncertain", "closed"],
	uncertain: ["closed"],
	closed: [],
};

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every(key => keys.has(key) && !FORBIDDEN_FIELD.test(key));
}

function isOpaque(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStateFileProof(value: unknown): value is Readonly<Record<string, string | number>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proof = value as Record<string, unknown>;
	return (
		Object.keys(proof).length <= 64 &&
		Object.entries(proof).every(
			([key, field]) =>
				/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) &&
				!FORBIDDEN_FIELD.test(key) &&
				((typeof field === "string" && isOpaque(field)) || isNonNegativeInteger(field)),
		)
	);
}

export function isSpawnSubstrateProof(value: unknown): value is SpawnSubstrateProof {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proof = value as Record<string, unknown>;
	return (
		Object.keys(proof).every(
			key =>
				key === "substrateKind" ||
				key === "providerIdentity" ||
				key === "nativeSessionId" ||
				key === "pid" ||
				key === "processIncarnation" ||
				key === "ownerGeneration" ||
				key === "stateFileProof",
		) &&
		typeof proof.substrateKind === "string" &&
		SUBSTRATE_KINDS.has(proof.substrateKind as SpawnSubstrateProof["substrateKind"]) &&
		isOpaque(proof.providerIdentity) &&
		(proof.nativeSessionId === undefined || isOpaque(proof.nativeSessionId)) &&
		(proof.pid === undefined || isPositiveInteger(proof.pid)) &&
		(proof.processIncarnation === undefined || isOpaque(proof.processIncarnation)) &&
		(proof.ownerGeneration === undefined || isNonNegativeInteger(proof.ownerGeneration)) &&
		(proof.stateFileProof === undefined || isStateFileProof(proof.stateFileProof)) &&
		(proof.nativeSessionId !== undefined || (proof.pid !== undefined && proof.processIncarnation !== undefined))
	);
}

function isSeed(value: unknown): value is SeedDeliveryV2 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const seed = value as Record<string, unknown>;
	if (
		!hasOnlyKeys(seed, SEED_KEYS) ||
		seed.version !== 2 ||
		typeof seed.phase !== "string" ||
		!SEED_PHASES.has(seed.phase as SeedDeliveryV2["phase"]) ||
		!isOpaque(seed.clientRef) ||
		(seed.commandId !== undefined && !isOpaque(seed.commandId)) ||
		(seed.turnId !== undefined && !isOpaque(seed.turnId)) ||
		(seed.acceptedAt !== undefined && !isTimestamp(seed.acceptedAt)) ||
		(seed.lastQ26Status !== undefined &&
			(typeof seed.lastQ26Status !== "string" ||
				!Q26_STATUSES.has(seed.lastQ26Status as NonNullable<SeedDeliveryV2["lastQ26Status"]>))) ||
		(seed.observedAt !== undefined && !isTimestamp(seed.observedAt))
	)
		return false;
	if (seed.phase === "accepted")
		return isOpaque(seed.commandId) && isOpaque(seed.turnId) && isTimestamp(seed.acceptedAt);
	if (seed.phase === "prepared" || seed.phase === "dispatching" || seed.phase === "pre_send_rejected")
		return seed.commandId === undefined && seed.turnId === undefined && seed.acceptedAt === undefined;
	return true;
}

export function isSpawnAuthorityV1(value: unknown): value is SpawnAuthorityV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const authority = value as Record<string, unknown>;
	return (
		hasOnlyKeys(authority, AUTHORITY_KEYS) &&
		authority.version === 1 &&
		isOpaque(authority.authorityId) &&
		isOpaque(authority.claimId) &&
		isOpaque(authority.childId) &&
		isOpaque(authority.ownerSessionId) &&
		isOpaque(authority.lifecycleIdentity) &&
		typeof authority.substrateKind === "string" &&
		SUBSTRATE_KINDS.has(authority.substrateKind as SpawnSubstrateProof["substrateKind"]) &&
		isOpaque(authority.providerIdentity) &&
		(authority.endpointGeneration === undefined || isNonNegativeInteger(authority.endpointGeneration)) &&
		(authority.endpointPid === undefined || isPositiveInteger(authority.endpointPid)) &&
		(authority.endpointIncarnation === undefined || isOpaque(authority.endpointIncarnation)) &&
		(authority.endpointCwd === undefined || isOpaque(authority.endpointCwd)) &&
		(authority.endpointStateRoot === undefined || isOpaque(authority.endpointStateRoot)) &&
		(authority.nativeSessionId === undefined || isOpaque(authority.nativeSessionId)) &&
		(authority.pid === undefined || isPositiveInteger(authority.pid)) &&
		(authority.processIncarnation === undefined || isOpaque(authority.processIncarnation)) &&
		(authority.ownerGeneration === undefined || isNonNegativeInteger(authority.ownerGeneration)) &&
		(authority.stateFileProof === undefined || isStateFileProof(authority.stateFileProof)) &&
		(authority.nativeSessionId !== undefined ||
			(authority.pid !== undefined && authority.processIncarnation !== undefined)) &&
		typeof authority.closeState === "string" &&
		CLOSE_STATES.has(authority.closeState as SpawnAuthorityCloseState) &&
		(authority.orphanedAt === undefined || isTimestamp(authority.orphanedAt)) &&
		(authority.orphanRecoveredAt === undefined || isTimestamp(authority.orphanRecoveredAt)) &&
		(authority.closeRequestedAt === undefined || isTimestamp(authority.closeRequestedAt)) &&
		(authority.closedAt === undefined || isTimestamp(authority.closedAt)) &&
		isTimestamp(authority.createdAt) &&
		isTimestamp(authority.updatedAt) &&
		authority.updatedAt >= authority.createdAt &&
		(authority.closeState !== "closed" || isTimestamp(authority.closedAt)) &&
		(authority.closeState !== "close_requested" || isTimestamp(authority.closeRequestedAt))
	);
}

function hasClaimStateShape(claim: SpawnClaimV2): boolean {
	switch (claim.state) {
		case "prepared":
			return claim.childId === undefined && claim.seed === undefined && claim.authorityRef === undefined;
		case "substrate_starting":
			return claim.childId !== undefined && claim.seed === undefined && claim.authorityRef === undefined;
		case "authority_active":
			return claim.childId !== undefined && claim.seed === undefined && claim.authorityRef !== undefined;
		case "seed_prepared":
			return claim.childId !== undefined && claim.authorityRef !== undefined && claim.seed?.phase === "prepared";
		case "dispatching":
			return claim.childId !== undefined && claim.authorityRef !== undefined && claim.seed?.phase === "dispatching";
		case "accepted":
			return claim.childId !== undefined && claim.authorityRef !== undefined && claim.seed?.phase === "accepted";
		case "pre_send_rejected":
			return claim.seed === undefined || claim.seed.phase === "pre_send_rejected";
		case "uncertain":
			return claim.seed === undefined || claim.seed.phase === "uncertain";
		case "closed":
			return true;
	}
}

function isSpawnSubstrateFailure(value: unknown): value is SpawnSubstrateFailure {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const failure = value as Record<string, unknown>;
	return (
		Object.keys(failure).every(key => key === "substrateKind" || key === "code" || key === "message") &&
		SUBSTRATE_KINDS.has(failure.substrateKind as SpawnSubstrateProof["substrateKind"]) &&
		isOpaque(failure.code) &&
		isOpaque(failure.message) &&
		failure.message.length <= 2048
	);
}

export function isSpawnClaimV2(value: unknown): value is SpawnClaimV2 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const claim = value as Record<string, unknown>;
	const lease = claim.preSendLease;
	const typed =
		hasOnlyKeys(claim, CLAIM_KEYS) &&
		claim.version === 2 &&
		isOpaque(claim.claimId) &&
		isOpaque(claim.lifecycleIdentity) &&
		(claim.requestBindingMac === undefined ||
			(typeof claim.requestBindingMac === "string" && /^[0-9a-f]{64}$/i.test(claim.requestBindingMac))) &&
		/^[0-9a-f]{64}$/i.test(String(claim.bindingMac)) &&
		typeof claim.state === "string" &&
		CLAIM_STATES.has(claim.state as SpawnClaimV2["state"]) &&
		(lease === undefined ||
			(typeof lease === "object" &&
				lease !== null &&
				!Array.isArray(lease) &&
				Object.keys(lease).every(key => key === "epoch" || key === "status") &&
				isOpaque((lease as { epoch?: unknown }).epoch) &&
				((lease as { status?: unknown }).status === "owned" ||
					(lease as { status?: unknown }).status === "consumed"))) &&
		(claim.childId === undefined || isOpaque(claim.childId)) &&
		(claim.seed === undefined || isSeed(claim.seed)) &&
		(claim.authorityRef === undefined || isOpaque(claim.authorityRef)) &&
		(claim.failure === undefined || isSpawnSubstrateFailure(claim.failure)) &&
		isTimestamp(claim.createdAt) &&
		isTimestamp(claim.updatedAt) &&
		claim.updatedAt >= claim.createdAt;
	return typed && hasClaimStateShape(claim as SpawnClaimV2);
}

function isRecoverablePreSend(claim: SpawnClaimV2): boolean {
	return claim.state === "prepared" || (claim.state === "seed_prepared" && claim.seed?.phase === "prepared");
}

function claimTimestampAfter(current: number): number {
	if (current >= Number.MAX_SAFE_INTEGER) throw new Error("Spawn authority timestamp cannot advance.");
	return Math.max(Date.now(), current + 1);
}

function matchingAuthority(claim: SpawnClaimV2, authority: SpawnAuthorityV1 | undefined): boolean {
	return (
		authority !== undefined &&
		claim.authorityRef === authority.authorityId &&
		claim.claimId === authority.claimId &&
		claim.lifecycleIdentity === authority.lifecycleIdentity &&
		claim.childId === authority.childId
	);
}

function authorityBinding(authority: SpawnAuthorityV1): string {
	const {
		closeState: _closeState,
		orphanedAt: _orphanedAt,
		orphanRecoveredAt: _orphanRecoveredAt,
		closeRequestedAt: _closeRequestedAt,
		closedAt: _closedAt,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		...binding
	} = authority;
	return canonicalJson(binding);
}

function sameAuthorityBinding(left: SpawnAuthorityV1, right: SpawnAuthorityV1): boolean {
	return authorityBinding(left) === authorityBinding(right);
}

function sameSeedIdentity(left: SeedDeliveryV2, right: SeedDeliveryV2): boolean {
	return left.version === right.version && left.clientRef === right.clientRef;
}

function cloneAuthority(authority: SpawnAuthorityV1 | undefined): SpawnAuthorityV1 | undefined {
	return authority === undefined
		? undefined
		: {
				...authority,
				...(authority.stateFileProof === undefined ? {} : { stateFileProof: { ...authority.stateFileProof } }),
			};
}

function cloneClaim(claim: SpawnClaimV2): SpawnClaimV2 {
	return {
		...claim,
		...(claim.preSendLease === undefined ? {} : { preSendLease: { ...claim.preSendLease } }),
		...(claim.seed === undefined ? {} : { seed: { ...claim.seed } }),
	};
}

/**
 * Append-only source of spawn-effect authority. It deliberately records no request
 * input: the opaque identity and raw/canonical structural binding MACs are its
 * only correlators.
 */
export class SpawnAuthorityStore {
	readonly #file: string;
	readonly #identityKey: Buffer;
	readonly #options: SpawnAuthorityStoreOptions;
	readonly #latest = new Map<string, SpawnClaimV2>();
	readonly #authorities = new Map<string, SpawnAuthorityV1>();
	readonly #active = new Set<string>();
	#tail: Promise<void> = Promise.resolve();

	constructor(agentDir: string, brokerIdentityKey: string, options: SpawnAuthorityStoreOptions = {}) {
		if (!/^[0-9a-f]{64}$/i.test(brokerIdentityKey)) throw new Error("Broker identity key is invalid.");
		this.#file = path.join(agentDir, "sdk", "spawn-authority.jsonl");
		this.#identityKey = Buffer.from(brokerIdentityKey, "hex");
		this.#options = options;
	}

	get file(): string {
		return this.#file;
	}

	claims(): readonly SpawnClaimV2[] {
		return [...this.#latest.values()].map(cloneClaim);
	}

	claim(lifecycleIdentity: string): SpawnClaimV2 | undefined {
		const claim = this.#latest.get(lifecycleIdentity);
		return claim === undefined ? undefined : cloneClaim(claim);
	}

	authority(lifecycleIdentity: string): SpawnAuthorityV1 | undefined {
		return cloneAuthority(this.#authorities.get(lifecycleIdentity));
	}

	async open(): Promise<void> {
		await this.#serial(async () => {
			await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
			this.#latest.clear();
			this.#authorities.clear();
			let source = "";
			try {
				source = await Bun.file(this.#file).text();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			for (const line of source.split("\n")) {
				if (!line) continue;
				let row: unknown;
				try {
					row = Bun.JSON5.parse(line);
				} catch {
					throw new Error("Spawn authority journal contains malformed durable evidence.");
				}
				if (!this.#isStoredClaim(row))
					throw new Error("Spawn authority journal contains invalid durable evidence.");
				const stored = row as StoredClaim;
				const prior = this.#latest.get(stored.claim.lifecycleIdentity);
				if (prior && (prior.claimId !== stored.claim.claimId || stored.claim.updatedAt <= prior.updatedAt))
					throw new Error("Spawn authority journal claim history is invalid.");
				this.#latest.set(stored.claim.lifecycleIdentity, stored.claim);
				if (stored.authority) this.#authorities.set(stored.claim.lifecycleIdentity, stored.authority);
				else this.#authorities.delete(stored.claim.lifecycleIdentity);
			}
		});
	}

	async claimOrJoin(
		lifecycleIdentity: string,
		bindingMac: string | undefined,
		requestBindingMac = bindingMac,
	): Promise<SpawnClaimDecision> {
		if (
			!isOpaque(lifecycleIdentity) ||
			(bindingMac !== undefined && !/^[0-9a-f]{64}$/i.test(bindingMac)) ||
			requestBindingMac === undefined ||
			!/^[0-9a-f]{64}$/i.test(requestBindingMac)
		)
			throw new Error("Invalid opaque spawn claim key.");
		return await this.#serial(async () => {
			const current = this.#latest.get(lifecycleIdentity);
			if (!current) {
				if (bindingMac === undefined) throw new Error("A canonical spawn binding is required for a new claim.");
				const now = Date.now();
				const claim: SpawnClaimV2 = {
					version: 2,
					claimId: randomBytes(24).toString("base64url"),
					lifecycleIdentity,
					requestBindingMac,
					bindingMac,
					state: "prepared",
					preSendLease: { epoch: randomBytes(24).toString("base64url"), status: "owned" },
					createdAt: now,
					updatedAt: now,
				};
				await this.#append(claim);
				this.#active.add(lifecycleIdentity);
				return { kind: "owner", claim: cloneClaim(claim), recovery: false };
			}
			const requestMatches =
				current.requestBindingMac === undefined
					? timingSafeEqual(Buffer.from(current.bindingMac, "hex"), Buffer.from(requestBindingMac, "hex"))
					: timingSafeEqual(Buffer.from(current.requestBindingMac, "hex"), Buffer.from(requestBindingMac, "hex"));
			if (
				!requestMatches ||
				(bindingMac !== undefined &&
					!timingSafeEqual(Buffer.from(current.bindingMac, "hex"), Buffer.from(bindingMac, "hex")))
			)
				return { kind: "idempotency_conflict", claim: cloneClaim(current) };
			if (this.#active.has(lifecycleIdentity)) return { kind: "in_progress", claim: cloneClaim(current) };
			if (isRecoverablePreSend(current)) {
				const rotated: SpawnClaimV2 = {
					...current,
					preSendLease: { epoch: randomBytes(24).toString("base64url"), status: "owned" },
					updatedAt: claimTimestampAfter(current.updatedAt),
				};
				await this.#append(rotated, this.#authorities.get(lifecycleIdentity));
				this.#active.add(lifecycleIdentity);
				return { kind: "owner", claim: cloneClaim(rotated), recovery: true };
			}
			if (current.state === "uncertain") return { kind: "terminal_uncertain", claim: cloneClaim(current) };
			if (current.state === "accepted" || current.state === "pre_send_rejected" || current.state === "closed")
				return { kind: "terminal", claim: cloneClaim(current) };
			return { kind: "replay", claim: cloneClaim(current) };
		});
	}

	/**
	 * Fsyncs one allowlisted state edge. Callers cannot patch claims in place,
	 * which prevents a retry from downgrading a handoff-capable state.
	 */
	async persistTransition(
		lifecycleIdentity: string,
		transition: SpawnClaimTransition,
	): Promise<SpawnAuthorityTransitionResult> {
		return await this.#serial(async () => {
			const current = this.#latest.get(lifecycleIdentity);
			if (!current) throw new SpawnAuthorityTransitionError("claim_not_found");
			if (current.claimId !== transition.claimId || current.state !== transition.from)
				throw new SpawnAuthorityTransitionError("stale_transition");
			if (!TRANSITION_EDGES[current.state].includes(transition.to))
				throw new SpawnAuthorityTransitionError("illegal_transition");

			const currentAuthority = this.#authorities.get(lifecycleIdentity);
			let nextAuthority = currentAuthority;
			let next: SpawnClaimV2;
			switch (transition.to) {
				case "substrate_starting": {
					if (
						!isOpaque(transition.childId) ||
						transition.seed !== undefined ||
						transition.authority !== undefined ||
						transition.failure !== undefined
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					next = { ...current, state: "substrate_starting", childId: transition.childId };
					break;
				}
				case "authority_active": {
					const authority = transition.authority;
					if (
						!isOpaque(transition.childId) ||
						!isSpawnAuthorityV1(authority) ||
						authority.claimId !== current.claimId ||
						authority.lifecycleIdentity !== current.lifecycleIdentity ||
						authority.childId !== transition.childId ||
						authority.closeState !== "active" ||
						current.childId !== transition.childId ||
						transition.seed !== undefined
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					nextAuthority = authority;
					next = {
						...current,
						state: "authority_active",
						authorityRef: authority.authorityId,
					};
					break;
				}
				case "seed_prepared": {
					if (
						!matchingAuthority(current, currentAuthority) ||
						!isSeed(transition.seed) ||
						transition.seed.phase !== "prepared" ||
						transition.childId !== undefined ||
						transition.authority !== undefined
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					next = { ...current, state: "seed_prepared", seed: transition.seed };
					break;
				}
				case "dispatching": {
					if (
						currentAuthority === undefined ||
						!matchingAuthority(current, currentAuthority) ||
						currentAuthority.closeState !== "active" ||
						current.preSendLease?.status !== "owned" ||
						!isOpaque(transition.leaseEpoch) ||
						transition.leaseEpoch !== current.preSendLease.epoch ||
						!isSeed(transition.seed) ||
						transition.seed.phase !== "dispatching" ||
						!current.seed ||
						!sameSeedIdentity(current.seed, transition.seed) ||
						transition.childId !== undefined ||
						transition.authority !== undefined
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					next = {
						...current,
						state: "dispatching",
						preSendLease: { ...current.preSendLease, status: "consumed" },
						seed: transition.seed,
					};
					break;
				}
				case "accepted": {
					if (
						!matchingAuthority(current, currentAuthority) ||
						current.preSendLease?.status !== "consumed" ||
						!current.seed ||
						!isSeed(transition.seed) ||
						transition.seed.phase !== "accepted" ||
						!sameSeedIdentity(current.seed, transition.seed) ||
						transition.childId !== undefined ||
						transition.authority !== undefined
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					next = { ...current, state: "accepted", seed: transition.seed };
					break;
				}
				case "pre_send_rejected": {
					if (current.state === "dispatching" && transition.provenNoHandoff !== true)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					if (
						transition.childId !== undefined ||
						transition.authority !== undefined ||
						(transition.failure !== undefined && !isSpawnSubstrateFailure(transition.failure))
					)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					if (current.seed) {
						if (
							!isSeed(transition.seed) ||
							transition.seed.phase !== "pre_send_rejected" ||
							!sameSeedIdentity(current.seed, transition.seed)
						)
							throw new SpawnAuthorityTransitionError("invalid_transition");
						next = { ...current, state: "pre_send_rejected", seed: transition.seed, failure: transition.failure };
					} else {
						if (transition.seed !== undefined) throw new SpawnAuthorityTransitionError("invalid_transition");
						next = {
							...current,
							state: "pre_send_rejected",
							...(transition.failure === undefined ? {} : { failure: transition.failure }),
						};
					}
					break;
				}
				case "uncertain": {
					if (transition.childId !== undefined || transition.authority !== undefined)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					if (current.seed) {
						if (
							!isSeed(transition.seed) ||
							transition.seed.phase !== "uncertain" ||
							!sameSeedIdentity(current.seed, transition.seed)
						)
							throw new SpawnAuthorityTransitionError("invalid_transition");
						next = { ...current, state: "uncertain", seed: transition.seed };
					} else {
						if (transition.seed !== undefined) throw new SpawnAuthorityTransitionError("invalid_transition");
						next = { ...current, state: "uncertain" };
					}
					break;
				}
				case "closed": {
					if (transition.childId !== undefined || transition.seed !== undefined)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					if (currentAuthority) {
						const authority = transition.authority;
						if (
							!isSpawnAuthorityV1(authority) ||
							!sameAuthorityBinding(currentAuthority, authority) ||
							authority.closeState !== "closed" ||
							authority.updatedAt <= currentAuthority.updatedAt
						)
							throw new SpawnAuthorityTransitionError("invalid_transition");
						nextAuthority = authority;
					} else if (transition.authority !== undefined)
						throw new SpawnAuthorityTransitionError("invalid_transition");
					next = { ...current, state: "closed" };
					break;
				}
				case "prepared":
					throw new SpawnAuthorityTransitionError("illegal_transition");
			}
			next = { ...next, updatedAt: claimTimestampAfter(current.updatedAt) };
			if (!isSpawnClaimV2(next) || (nextAuthority !== undefined && !matchingAuthority(next, nextAuthority)))
				throw new SpawnAuthorityTransitionError("invalid_transition");
			await this.#append(next, nextAuthority);
			return {
				claim: cloneClaim(next),
				...(nextAuthority === undefined ? {} : { authority: cloneAuthority(nextAuthority)! }),
			};
		});
	}

	/** Persists only an exact authority lifecycle update, never a proof replacement. */
	async persistAuthority(
		lifecycleIdentity: string,
		authority: SpawnAuthorityV1,
	): Promise<SpawnAuthorityTransitionResult> {
		return await this.#serial(async () => {
			const current = this.#latest.get(lifecycleIdentity);
			const prior = this.#authorities.get(lifecycleIdentity);
			if (!current || !prior) throw new SpawnAuthorityTransitionError("claim_not_found");
			if (
				!isSpawnAuthorityV1(authority) ||
				!matchingAuthority(current, authority) ||
				!sameAuthorityBinding(prior, authority) ||
				authority.updatedAt <= prior.updatedAt ||
				!this.#allowedAuthorityUpdate(prior, authority)
			)
				throw new SpawnAuthorityTransitionError("invalid_transition");
			const next = { ...current, updatedAt: claimTimestampAfter(current.updatedAt) };
			await this.#append(next, authority);
			return { claim: cloneClaim(next), authority: cloneAuthority(authority)! };
		});
	}

	/** Records an observed Q26 status without reopening or changing a state edge. */
	async persistSeedObservation(
		lifecycleIdentity: string,
		seed: SeedDeliveryV2,
	): Promise<SpawnAuthorityTransitionResult> {
		return await this.#serial(async () => {
			const current = this.#latest.get(lifecycleIdentity);
			const authority = this.#authorities.get(lifecycleIdentity);
			if (!current?.seed || !matchingAuthority(current, authority))
				throw new SpawnAuthorityTransitionError("claim_not_found");
			if (
				!isSeed(seed) ||
				seed.phase !== current.seed.phase ||
				!sameSeedIdentity(current.seed, seed) ||
				(seed.observedAt !== undefined &&
					current.seed.observedAt !== undefined &&
					seed.observedAt < current.seed.observedAt)
			)
				throw new SpawnAuthorityTransitionError("invalid_transition");
			const next = { ...current, seed, updatedAt: claimTimestampAfter(current.updatedAt) };
			if (!isSpawnClaimV2(next)) throw new SpawnAuthorityTransitionError("invalid_transition");
			await this.#append(next, authority);
			return { claim: cloneClaim(next), authority: cloneAuthority(authority)! };
		});
	}

	async releaseOwner(lifecycleIdentity: string): Promise<void> {
		await this.#serial(async () => this.#active.delete(lifecycleIdentity));
	}

	#allowedAuthorityUpdate(prior: SpawnAuthorityV1, next: SpawnAuthorityV1): boolean {
		if (next.orphanedAt !== undefined && prior.orphanedAt !== undefined && next.orphanedAt < prior.orphanedAt)
			return false;
		if (
			next.orphanRecoveredAt !== undefined &&
			next.orphanedAt !== undefined &&
			next.orphanRecoveredAt < next.orphanedAt
		)
			return false;
		switch (prior.closeState) {
			case "active":
				return (
					next.closeState === "active" || next.closeState === "close_requested" || next.closeState === "uncertain"
				);
			case "close_requested":
				return (
					next.closeState === "close_requested" || next.closeState === "closed" || next.closeState === "uncertain"
				);
			case "uncertain":
				return next.closeState === "uncertain" || next.closeState === "closed";
			case "closed":
				return false;
		}
	}

	#integrity(claim: SpawnClaimV2, authority?: SpawnAuthorityV1): string {
		return createHmac("sha256", this.#identityKey)
			.update(canonicalJson({ claim, ...(authority === undefined ? {} : { authority }) }))
			.digest("hex");
	}

	#isStoredClaim(value: unknown): value is StoredClaim {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const row = value as Partial<StoredClaim>;
		return (
			Object.keys(row).every(
				key => key === "version" || key === "claim" || key === "authority" || key === "integrity",
			) &&
			row.version === 1 &&
			isSpawnClaimV2(row.claim) &&
			(row.authority === undefined || isSpawnAuthorityV1(row.authority)) &&
			(row.authority === undefined || matchingAuthority(row.claim, row.authority)) &&
			typeof row.integrity === "string" &&
			/^[0-9a-f]{64}$/i.test(row.integrity) &&
			timingSafeEqual(
				Buffer.from(row.integrity, "hex"),
				Buffer.from(this.#integrity(row.claim, row.authority), "hex"),
			)
		);
	}

	async #append(claim: SpawnClaimV2, authority?: SpawnAuthorityV1): Promise<void> {
		if (!isSpawnClaimV2(claim) || (authority !== undefined && !matchingAuthority(claim, authority)))
			throw new Error("Refusing to persist invalid spawn authority evidence.");
		const write: SpawnAuthorityDurableWrite = { claim, ...(authority === undefined ? {} : { authority }) };
		const row: StoredClaim = { version: 1, ...write, integrity: this.#integrity(claim, authority) };
		// The row is appended before the durability barrier, so a barrier failure
		// can leave a physically written line that in-memory state never accepted.
		// A retry would then append a second row for the same claim and reopen
		// would reject the whole journal as invalid history. Roll back to the
		// pre-write length instead, so a failed append leaves no trace at all.
		let priorSize = 0;
		try {
			priorSize = (await fs.stat(this.#file)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const handle = await fs.open(
			this.#file,
			fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT,
			0o600,
		);
		let rollbackFailed = false;
		try {
			try {
				await handle.writeFile(`${canonicalJson(row)}\n`);
				await this.#options.beforeSyncForTest?.(write);
				await handle.sync();
				// The parent-directory barrier belongs INSIDE the rolled-back region:
				// a throw here would otherwise leave a durable row that in-memory
				// state never accepted, and the retry would append a duplicate that
				// makes the journal unreopenable.
				await this.#options.beforeDirectorySyncForTest?.(write);
				const directory = await fs.open(path.dirname(this.#file), fsSync.constants.O_RDONLY);
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			} catch (error) {
				try {
					await handle.truncate(priorSize);
					await handle.sync();
				} catch {
					// A failed rollback may leave a partial row behind. Surface that
					// instead of reporting only the original fault, because the journal
					// can no longer be assumed clean.
					rollbackFailed = true;
				}
				if (rollbackFailed)
					throw new Error("Spawn authority journal append failed and its rollback could not be completed.");
				throw error;
			}
		} finally {
			await handle.close();
		}
		this.#latest.set(claim.lifecycleIdentity, claim);
		if (authority) this.#authorities.set(claim.lifecycleIdentity, authority);
		else this.#authorities.delete(claim.lifecycleIdentity);
		await this.#options.afterSyncForTest?.(write);
	}

	async #serial<T>(operation: () => Promise<T>): Promise<T> {
		const prior = this.#tail;
		const completion = Promise.withResolvers<void>();
		this.#tail = prior.then(() => completion.promise);
		await prior;
		try {
			return await operation();
		} finally {
			completion.resolve();
		}
	}
}

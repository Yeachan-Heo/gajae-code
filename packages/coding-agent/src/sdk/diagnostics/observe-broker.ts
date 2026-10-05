import { loadDiagnosticNativeReadOnly } from "@gajae-code/natives/diagnostic-loader";
import { SdkClient } from "../client/client";

/**
 * Observation-only broker diagnostics facade (SPEC "Result contract").
 *
 * The publication is read ONLY through the approved read-only native lease
 * (`loadDiagnosticNativeReadOnly` -> `openDiagnosticSnapshot` -> bounded read ->
 * revalidate -> close), so every ancestor ACL/owner/mode and filesystem check of the
 * earlier slices governs this route too. Ordinary discovery is deliberately not used: it
 * would bypass that gate. An unsupported runtime tuple or artifact resolves to
 * `unsupported` BEFORE any publication access. The facade then opens exactly ONE client
 * connection with no reconnect attempts, asks the broker for its published diagnostics
 * and returns a detached frozen snapshot. It never ensures, starts, recovers, retires or spawns
 * anything, never touches the session index, ledger or evidence store, and never hands
 * the caller a token, socket coordinate, path, pid or environment value.
 */

/** Allowed unavailability reasons; messages are fixed literals keyed by the enum. */
export type BrokerObservationUnavailableReason =
	| "absent"
	| "stale"
	| "incompatible"
	| "authentication_failed"
	| "unsupported"
	| "generation_mismatch"
	| "transport_unavailable"
	| "timeout"
	| "invalid_response"
	| "unsafe_discovery";

const UNAVAILABLE_MESSAGES: Record<BrokerObservationUnavailableReason, string> = {
	absent: "No broker publication was found for the requested agent directory.",
	stale: "The broker publication is stale.",
	incompatible: "The broker publication is not compatible with this client.",
	authentication_failed: "The broker refused the observation credentials.",
	unsupported: "The broker does not support diagnostic observation.",
	generation_mismatch: "The broker generation does not match the expected generation.",
	transport_unavailable: "The broker transport is unavailable.",
	timeout: "The broker observation timed out.",
	invalid_response: "The broker returned an invalid diagnostic response.",
	unsafe_discovery: "The broker publication namespace is not trusted.",
};

export interface BrokerObservationBuild {
	readonly packageVersion: string;
	readonly buildId: string | null;
}

export interface BrokerObservationSuccess {
	readonly schema: "gjc.broker-observation";
	readonly version: 1;
	readonly ok: true;
	readonly observedAt: string;
	readonly broker: {
		readonly generation: string;
		readonly build: BrokerObservationBuild;
		readonly diagnosticProtocol: 1;
	};
}

export interface BrokerObservationUnavailable {
	readonly schema: "gjc.broker-observation";
	readonly version: 1;
	readonly ok: false;
	readonly observedAt: string;
	readonly unavailable: {
		readonly reason: BrokerObservationUnavailableReason;
		readonly message: string;
	};
}

export type BrokerObservation = BrokerObservationSuccess | BrokerObservationUnavailable;

export interface ObserveExistingBrokerOptions {
	readonly agentDir: string;
	readonly expectedGeneration?: string;
	readonly timeoutMs?: number;
}

/** The broker's published diagnostics operation. */
export const BROKER_DIAGNOSTICS_OPERATION = "broker.diagnostics";

/** The only diagnostic protocol this client understands. */
export const BROKER_DIAGNOSTIC_PROTOCOL = 1;

/** Contract timeout: default 2000 ms, accepted range 1..10000 ms. */
export const OBSERVATION_TIMEOUT_DEFAULT_MS = 2_000;
export const OBSERVATION_TIMEOUT_MIN_MS = 1;
export const OBSERVATION_TIMEOUT_MAX_MS = 10_000;

const MAX_AGENT_DIR_BYTES = 4_096;
const MAX_AGENT_DIR_COMPONENTS = 128;
/** A broker generation is 16 random bytes rendered as lowercase hex. */
const GENERATION_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Monotonic nanosecond clock for the single observation budget.
 *
 * Production always reads `Bun.nanoseconds()`. Tests may install a deterministic clock so
 * the deadline's behaviour -- no socket after expiry, and a late answer discarded -- can be
 * proven instead of argued. The seam replaces only the time source: no branch, capability
 * or output changes with it.
 */
let observationClock: () => number = () => Bun.nanoseconds();

export function setObservationClockForTest(clock: (() => number) | null): void {
	observationClock = clock ?? (() => Bun.nanoseconds());
}

/**
 * Test-only observers for the native stage boundary. Production installs none, and the
 * hooks never change a branch, a budget or an outcome: they only report what the
 * observation did (`onNativeOpen`) and give a test a point to disturb the environment
 * between the first publication read and the connection (`afterInitialRead`), which is how
 * the pre-socket identity recheck is proven instead of argued.
 */
export interface ObservationTestHooks {
	onNativeOpen?: (info: { agentDir: string; budgetMs: number }) => void;
	afterInitialRead?: () => void;
	/** Reports that the retained lease was released, on every exit path. */
	onLeaseClosed?: () => void;
	/**
	 * Decorates the retained lease so a test can identify the real operation phases and make
	 * a chosen phase refuse or throw. Production installs none.
	 */
	wrapLease?: (lease: DiagnosticSnapshotLease) => DiagnosticSnapshotLease;
	/** Replaces the loader result so loader-stage outcomes can be observed deterministically. */
	loaderOverride?: () => DiagnosticNativeLoad;
}

/** Minimal shapes this facade relies on from the approved read-only loader. */
interface DiagnosticSnapshotRead {
	readonly ok: boolean;
	readonly reason?: string | null;
	readonly bytes?: Uint8Array | null;
}

interface DiagnosticSnapshotStatus {
	readonly ok: boolean;
	readonly reason?: string | null;
}

interface DiagnosticSnapshotLease {
	readonly ok: boolean;
	readonly reason?: string | null;
	read(): DiagnosticSnapshotRead;
	revalidate(): DiagnosticSnapshotStatus;
	close(): void;
}

type DiagnosticNativeLoad =
	| { ok: true; value: { openDiagnosticSnapshot(agentDir: string, budgetMs: number): DiagnosticSnapshotLease } }
	| { ok: false; reason: string };

let observationTestHooks: ObservationTestHooks = {};

export function setObservationTestHooksForTest(hooks: ObservationTestHooks | null): void {
	observationTestHooks = hooks ?? {};
}

/** Malformed arguments are a typed caller error, never an observed unavailability. */
export class DiagnosticOptionsError extends Error {
	readonly code = "invalid_arguments" as const;
	readonly field: string;

	constructor(field: string) {
		super(`invalid observation argument: ${field}`);
		this.name = "DiagnosticOptionsError";
		this.field = field;
	}
}

export type ObservationOptionsVerdict =
	| { ok: true; value: { agentDir: string; expectedGeneration?: string; timeoutMs: number } }
	| { ok: false; error: { code: "invalid_arguments"; field: string } };

const KNOWN_OPTION_FIELDS = new Set(["agentDir", "expectedGeneration", "timeoutMs"]);

/** Validate the caller's options against the exact contract. Pure and total. */
export function validateObservationOptions(options: unknown): ObservationOptionsVerdict {
	const invalid = (field: string): ObservationOptionsVerdict => ({
		ok: false,
		error: { code: "invalid_arguments", field },
	});
	if (typeof options !== "object" || options === null) return invalid("options");
	const record = options as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		// An unknown key is reported as the fixed identifier `options`: a caller's raw key
		// could carry a path, a token, newlines or an unbounded string, and the public error
		// contract reflects no caller input.
		if (!KNOWN_OPTION_FIELDS.has(field)) return invalid("options");
	}
	const agentDir = record.agentDir;
	if (typeof agentDir !== "string" || agentDir.length === 0) return invalid("agentDir");
	if (!agentDir.startsWith("/")) return invalid("agentDir");
	if (agentDir.includes("\u0000")) return invalid("agentDir");
	if (Buffer.byteLength(agentDir, "utf8") > MAX_AGENT_DIR_BYTES) return invalid("agentDir");
	if (agentDir.split("/").filter(part => part.length > 0).length > MAX_AGENT_DIR_COMPONENTS) {
		return invalid("agentDir");
	}
	let expectedGeneration: string | undefined;
	if (record.expectedGeneration !== undefined) {
		if (typeof record.expectedGeneration !== "string") return invalid("expectedGeneration");
		if (!GENERATION_PATTERN.test(record.expectedGeneration)) return invalid("expectedGeneration");
		expectedGeneration = record.expectedGeneration;
	}
	let timeoutMs = OBSERVATION_TIMEOUT_DEFAULT_MS;
	if (record.timeoutMs !== undefined) {
		if (typeof record.timeoutMs !== "number" || !Number.isInteger(record.timeoutMs)) return invalid("timeoutMs");
		if (record.timeoutMs < OBSERVATION_TIMEOUT_MIN_MS || record.timeoutMs > OBSERVATION_TIMEOUT_MAX_MS) {
			return invalid("timeoutMs");
		}
		timeoutMs = record.timeoutMs;
	}
	return {
		ok: true,
		value: { agentDir, ...(expectedGeneration === undefined ? {} : { expectedGeneration }), timeoutMs },
	};
}

function unavailable(reason: BrokerObservationUnavailableReason): BrokerObservationUnavailable {
	return Object.freeze({
		schema: "gjc.broker-observation",
		version: 1,
		ok: false,
		observedAt: new Date().toISOString(),
		unavailable: Object.freeze({ reason, message: UNAVAILABLE_MESSAGES[reason] }),
	}) as BrokerObservationUnavailable;
}

function success(generation: string, build: BrokerObservationBuild): BrokerObservationSuccess {
	return Object.freeze({
		schema: "gjc.broker-observation",
		version: 1,
		ok: true,
		observedAt: new Date().toISOString(),
		broker: Object.freeze({
			generation,
			build: Object.freeze({ packageVersion: build.packageVersion, buildId: build.buildId }),
			diagnosticProtocol: BROKER_DIAGNOSTIC_PROTOCOL,
		}),
	}) as BrokerObservationSuccess;
}

/** Bounds that keep every rendered field inside the public output budget. */
const MAX_PUBLICATION_BYTES = 64 * 1024;
const MAX_VERSION_LENGTH = 64;
const MAX_BUILD_ID_LENGTH = 64;
const MAX_OWNER_LENGTH = 64;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const BUILD_ID_PATTERN = /^[0-9A-Za-z._-]{1,64}$/;
const OWNER_PATTERN = /^[0-9a-f]{1,64}$/;
/**
 * Canonical publication endpoint: the owned loopback address, a decimal port with no
 * leading zero, and at most the root path. Anything else -- another host, scheme, path,
 * query or userinfo -- would let the observation leave the endpoint the publisher owns.
 *
 * DESIGN writes the canonical form with a trailing `/`, while the actual publisher emits
 * `ws://127.0.0.1:<port>` without one. The trailing slash is therefore accepted as
 * OPTIONAL: that is a compatibility choice for the existing publisher, not a change to
 * publisher semantics, which this slice deliberately leaves alone.
 */
const LOOPBACK_WS_PATTERN = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/;
const MAX_TCP_PORT = 65_535;

/** Whether the endpoint is the canonical owned loopback endpoint with an in-range port. */
export function canonicalLoopbackEndpoint(url: string): boolean {
	const match = LOOPBACK_WS_PATTERN.exec(url);
	if (match === null) return false;
	const port = Number(match[1]);
	return Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
}
const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;

/**
 * Parse verdicts for the publication bytes. A publication that is well formed but
 * carries no diagnostic capability is NOT malformed: an old broker like that is
 * `unsupported`, never `invalid_response` and never `absent`.
 */
export type PublicationVerdict =
	| { kind: "ok"; value: ObservedPublication }
	| { kind: "no-capability" }
	| { kind: "malformed" };

/** The publication fields this route reads; every other field is ignored, never trusted. */
export interface ObservedPublication {
	readonly url: string;
	readonly token: string;
	readonly ownerId: string;
	readonly pid: number;
	readonly incarnation: string | null;
	readonly agentRoot: string | null;
	readonly generation: string;
	readonly diagnosticProtocol: number;
}

/** Parse the publication bytes the native lease returned. Strict, bounded, total. */
export function parsePublicationVerdict(bytes: Uint8Array): PublicationVerdict {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_PUBLICATION_BYTES) return { kind: "malformed" };
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return { kind: "malformed" };
	}
	if (typeof value !== "object" || value === null) return { kind: "malformed" };
	const record = value as Record<string, unknown>;
	const url = record.url;
	const token = record.token;
	const ownerId = record.ownerId;
	const pid = record.pid;
	const generation = record.diagnosticGeneration;
	const protocol = record.diagnosticProtocol;
	if (typeof url !== "string" || !canonicalLoopbackEndpoint(url)) return { kind: "malformed" };
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return { kind: "malformed" };
	if (typeof ownerId !== "string" || !OWNER_PATTERN.test(ownerId)) return { kind: "malformed" };
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { kind: "malformed" };
	// An old broker omits both capability fields entirely: that is `unsupported`, decided
	// before any socket is opened, and never reported as malformed or absent.
	if (generation === undefined && protocol === undefined) return { kind: "no-capability" };
	// Present but out of contract is a malformed publication, not a missing capability.
	if (typeof generation !== "string" || !GENERATION_PATTERN.test(generation)) return { kind: "malformed" };
	if (typeof protocol !== "number" || !Number.isInteger(protocol)) return { kind: "malformed" };
	const incarnation =
		typeof record.incarnation === "string" && record.incarnation.length <= MAX_OWNER_LENGTH
			? record.incarnation
			: null;
	const agentRoot =
		typeof record.agentRoot === "string" && record.agentRoot.length <= MAX_AGENT_DIR_BYTES ? record.agentRoot : null;
	return {
		kind: "ok",
		value: { url, token, ownerId, pid, incarnation, agentRoot, generation, diagnosticProtocol: protocol },
	};
}

/** Convenience wrapper for callers that only need the accepted shape. */
export function parsePublication(bytes: Uint8Array): ObservedPublication | null {
	const verdict = parsePublicationVerdict(bytes);
	return verdict.kind === "ok" ? verdict.value : null;
}

/** The exact answered payload this client accepts; unknown fields are refused. */
interface AnsweredDiagnostics {
	readonly generation: string;
	readonly build: BrokerObservationBuild;
	readonly identity: { readonly ownerId: string; readonly pid: number; readonly agentRoot: string };
}

const ANSWER_FIELDS = new Set(["diagnosticProtocol", "generation", "build", "identity"]);
const ANSWER_BUILD_FIELDS = new Set(["packageVersion", "buildId"]);
const ANSWER_IDENTITY_FIELDS = new Set(["ownerId", "pid", "agentRoot"]);

/** Strictly validate the broker's answer, mapping every refusal onto the reason enum. */
export function parseAnsweredDiagnostics(
	response: unknown,
): { kind: "ok"; value: AnsweredDiagnostics } | { kind: "unavailable"; reason: BrokerObservationUnavailableReason } {
	const refuse = (reason: BrokerObservationUnavailableReason) => ({ kind: "unavailable" as const, reason });
	if (typeof response !== "object" || response === null) return refuse("invalid_response");
	const envelope = response as Record<string, unknown>;
	if (envelope.ok !== true) {
		const error = envelope.error;
		const code =
			typeof error === "object" && error !== null ? (error as Record<string, unknown>).code : envelope.code;
		if (code === "unauthorized" || code === "forbidden") return refuse("authentication_failed");
		if (code === "unknown_operation" || code === "unsupported_operation") return refuse("unsupported");
		if (code === "timeout" || code === "deadline_exceeded") return refuse("timeout");
		return refuse("transport_unavailable");
	}
	const result = envelope.result;
	if (typeof result !== "object" || result === null) return refuse("invalid_response");
	const record = result as Record<string, unknown>;
	for (const field of Object.keys(record)) {
		if (!ANSWER_FIELDS.has(field)) return refuse("invalid_response");
	}
	if (typeof record.diagnosticProtocol !== "number" || !Number.isInteger(record.diagnosticProtocol)) {
		return refuse("invalid_response");
	}
	if (record.diagnosticProtocol !== BROKER_DIAGNOSTIC_PROTOCOL) return refuse("incompatible");
	if (typeof record.generation !== "string" || !GENERATION_PATTERN.test(record.generation)) {
		return refuse("invalid_response");
	}
	const build = record.build;
	if (typeof build !== "object" || build === null) return refuse("invalid_response");
	const buildRecord = build as Record<string, unknown>;
	for (const field of Object.keys(buildRecord)) {
		if (!ANSWER_BUILD_FIELDS.has(field)) return refuse("invalid_response");
	}
	if (typeof buildRecord.packageVersion !== "string" || !VERSION_PATTERN.test(buildRecord.packageVersion)) {
		return refuse("invalid_response");
	}
	if (buildRecord.packageVersion.length > MAX_VERSION_LENGTH) return refuse("invalid_response");
	let buildId: string | null = null;
	if (buildRecord.buildId !== null) {
		if (typeof buildRecord.buildId !== "string" || !BUILD_ID_PATTERN.test(buildRecord.buildId)) {
			return refuse("invalid_response");
		}
		if (buildRecord.buildId.length > MAX_BUILD_ID_LENGTH) return refuse("invalid_response");
		buildId = buildRecord.buildId;
	}
	const identity = record.identity;
	if (typeof identity !== "object" || identity === null) return refuse("invalid_response");
	const identityRecord = identity as Record<string, unknown>;
	for (const field of Object.keys(identityRecord)) {
		if (!ANSWER_IDENTITY_FIELDS.has(field)) return refuse("invalid_response");
	}
	if (typeof identityRecord.ownerId !== "string" || !OWNER_PATTERN.test(identityRecord.ownerId)) {
		return refuse("invalid_response");
	}
	if (typeof identityRecord.pid !== "number" || !Number.isInteger(identityRecord.pid) || identityRecord.pid <= 0) {
		return refuse("invalid_response");
	}
	if (typeof identityRecord.agentRoot !== "string" || identityRecord.agentRoot.length === 0) {
		return refuse("invalid_response");
	}
	return {
		kind: "ok",
		value: {
			generation: record.generation,
			build: { packageVersion: buildRecord.packageVersion, buildId },
			identity: {
				ownerId: identityRecord.ownerId,
				pid: identityRecord.pid,
				agentRoot: identityRecord.agentRoot,
			},
		},
	};
}

/** Two publication observations describe the same authority. */
export function sameAuthority(first: ObservedPublication, second: ObservedPublication): boolean {
	return (
		first.generation === second.generation &&
		first.ownerId === second.ownerId &&
		first.pid === second.pid &&
		first.incarnation === second.incarnation &&
		first.agentRoot === second.agentRoot
	);
}

/** The broker's answer agrees with the publication on generation and identity. */
export function answerMatchesAuthority(answer: AnsweredDiagnostics, publication: ObservedPublication): boolean {
	if (answer.generation !== publication.generation) return false;
	if (answer.identity.ownerId !== publication.ownerId) return false;
	if (answer.identity.pid !== publication.pid) return false;
	if (publication.agentRoot !== null && answer.identity.agentRoot !== publication.agentRoot) return false;
	return true;
}

/**
 * Observe an already running broker. Never starts, ensures, recovers or retires one.
 */
export async function observeExistingBroker(
	options: ObserveExistingBrokerOptions | unknown,
): Promise<BrokerObservation> {
	const verdict = validateObservationOptions(options);
	if (!verdict.ok) throw new DiagnosticOptionsError(verdict.error.field);
	const { agentDir, expectedGeneration, timeoutMs } = verdict.value;

	// ONE monotonic budget starts before any loader or native work and governs every later
	// step: the lease read, the socket and the response.
	const clock = observationClock;
	const startedAt = clock();
	const elapsedMs = () => Math.max(0, Math.floor((clock() - startedAt) / 1_000_000));
	const expired = () => elapsedMs() >= timeoutMs;
	const remainingMs = () => Math.max(1, timeoutMs - elapsedMs());

	// The runtime tuple and the trusted artifact decide BEFORE any publication access, so
	// an unsupported platform or a missing/mismatched artifact never reaches the
	// filesystem through this route.
	let native: DiagnosticNativeLoad;
	try {
		native = observationTestHooks.loaderOverride?.() ?? loadDiagnosticNativeReadOnly();
	} catch {
		// A loader exception is a low-level native failure on this route, never an escaping
		// error; an expired budget outranks it.
		return unavailable(expired() ? "timeout" : "unsupported");
	}
	// DESIGN:157 keeps the two apart: a live-budget loader failure is `unsupported`, while a
	// failure observed after the budget is spent is the timeout.
	if (!native.ok) return unavailable(expired() ? "timeout" : "unsupported");
	// The loader itself consumes budget: expiry is decided BEFORE the native stage, so an
	// exhausted budget never opens a publication snapshot.
	if (expired()) return unavailable("timeout");
	const nativeBudgetMs = remainingMs();
	// The remaining-budget read itself can cross the deadline: nothing native is entered
	// with a budget that is already spent.
	if (expired()) return unavailable("timeout");

	let lease: DiagnosticSnapshotLease | null = null;
	let client: SdkClient | null = null;
	// Set while the native stage owns the work, so an exception raised there is classified as
	// a native failure instead of a transport failure.
	let nativeStageActive = false;
	try {
		observationTestHooks.onNativeOpen?.({ agentDir, budgetMs: nativeBudgetMs });
		nativeStageActive = true;
		const openedLease = native.value.openDiagnosticSnapshot(agentDir, nativeBudgetMs);
		lease = observationTestHooks.wrapLease?.(openedLease) ?? openedLease;
		// Timeout outranks a native refusal that only describes what a spent budget could no
		// longer observe.
		if (!lease.ok) return unavailable(expired() ? "timeout" : leaseReason(lease.reason));
		// After the native call returns, the budget decides again before the next native step.
		if (expired()) return unavailable("timeout");
		const read = lease.read();
		if (!read.ok || read.bytes === undefined || read.bytes === null) {
			return unavailable(expired() ? "timeout" : leaseReason(read.reason));
		}
		// Timeout outranks a parse verdict that only describes bytes a spent budget could no
		// longer confirm.
		if (expired()) return unavailable("timeout");
		const initial = parsePublicationVerdict(read.bytes);
		if (initial.kind === "no-capability") return unavailable(expired() ? "timeout" : "unsupported");
		if (initial.kind === "malformed") return unavailable(expired() ? "timeout" : "invalid_response");
		const publication = initial.value;
		observationTestHooks.afterInitialRead?.();
		// A capability the client does not speak is unsupported before any socket.
		if (publication.diagnosticProtocol !== BROKER_DIAGNOSTIC_PROTOCOL) return unavailable("unsupported");
		if (expectedGeneration !== undefined && expectedGeneration !== publication.generation) {
			return unavailable("generation_mismatch");
		}
		// All synchronous native work is done.
		if (expired()) return unavailable("timeout");

		// The publication is revalidated immediately BEFORE anything is connected, and the
		// budget is re-checked AFTER that step: the revalidation itself can consume the rest
		// of the budget, and a spent budget must never construct or open a connection.
		const beforeSocket = lease.revalidate();
		if (!beforeSocket.ok) return unavailable(expired() ? "timeout" : leaseReason(beforeSocket.reason));
		// Descriptor identity is not publication identity: re-read the bounded bytes through
		// the SAME retained lease (no reopen, no new trust path) and compare the semantic
		// identity with the first observation. A replacement published over the same inode is
		// refused here, before any socket exists.
		if (expired()) return unavailable("timeout");
		const preSocketRead = lease.read();
		if (!preSocketRead.ok || preSocketRead.bytes === undefined || preSocketRead.bytes === null) {
			return unavailable(expired() ? "timeout" : leaseReason(preSocketRead.reason));
		}
		if (expired()) return unavailable("timeout");
		const preSocket = parsePublicationVerdict(preSocketRead.bytes);
		if (preSocket.kind === "no-capability") return unavailable(expired() ? "timeout" : "unsupported");
		if (preSocket.kind === "malformed") return unavailable(expired() ? "timeout" : "invalid_response");
		if (!sameAuthority(publication, preSocket.value)) {
			return unavailable(expired() ? "timeout" : "generation_mismatch");
		}
		if (expired()) return unavailable("timeout");

		// The remaining budget is read first and the budget is re-checked immediately before
		// the client exists, so no connection is ever constructed with a spent budget.
		const connectBudgetMs = remainingMs();
		if (expired()) return unavailable("timeout");
		client = new SdkClient(publication.url, publication.token, {
			// One connection: no reconnect, no late connect to a replacement publication.
			reconnectAttempts: 0,
			timeoutMs: connectBudgetMs,
			// The client stage inherits the observation's ONE absolute budget, so a socket that
			// opens late cannot buy the handshake a fresh relative timeout on top of it.
			deadline: Date.now() + connectBudgetMs,
		});
		nativeStageActive = false;
		await client.connect();
		if (expired()) return unavailable("timeout");

		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const response = await Promise.race([
			client.request({ type: "broker_request", operation: BROKER_DIAGNOSTICS_OPERATION, input: {} }),
			new Promise<"deadline">(resolve => {
				deadlineTimer = setTimeout(() => resolve("deadline"), remainingMs());
			}),
		]).finally(() => {
			// The budget timer is always cleared: no pending handle outlives the call.
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		});
		// A result that arrives after the budget is discarded, not rendered.
		if (response === "deadline" || expired()) return unavailable("timeout");

		const answered = parseAnsweredDiagnostics(response);
		if (answered.kind === "unavailable") return unavailable(answered.reason);

		// After the response, the publication must still be the same authority, and the
		// answer must agree with it on generation and the internal owner/process/root
		// identity.
		if (expired()) return unavailable("timeout");
		nativeStageActive = true;
		const afterResponse = lease.revalidate();
		if (!afterResponse.ok) return unavailable(expired() ? "timeout" : leaseReason(afterResponse.reason));
		if (expired()) return unavailable("timeout");
		const finalRead = lease.read();
		if (!finalRead.ok || finalRead.bytes === undefined || finalRead.bytes === null) {
			return unavailable(expired() ? "timeout" : leaseReason(finalRead.reason));
		}
		if (expired()) return unavailable("timeout");
		const finalVerdict = parsePublicationVerdict(finalRead.bytes);
		if (finalVerdict.kind === "no-capability") return unavailable(expired() ? "timeout" : "unsupported");
		if (finalVerdict.kind === "malformed") return unavailable(expired() ? "timeout" : "invalid_response");
		const finalPublication = finalVerdict.value;
		if (expired()) return unavailable("timeout");
		if (!sameAuthority(publication, finalPublication)) return unavailable("generation_mismatch");
		if (!answerMatchesAuthority(answered.value, finalPublication)) return unavailable("generation_mismatch");
		if (expectedGeneration !== undefined && expectedGeneration !== answered.value.generation) {
			return unavailable("generation_mismatch");
		}
		return success(answered.value.generation, answered.value.build);
	} catch (error) {
		if (error instanceof DiagnosticOptionsError) throw error;
		// An expired budget outranks a low-level failure that only describes what a spent
		// budget could no longer complete.
		if (expired()) return unavailable("timeout");
		// A native/lease exception raised while the budget was still live is a low-level
		// native failure (DESIGN:157), distinct from a transport failure of the client stage.
		if (nativeStageActive) return unavailable("unsupported");
		return unavailable(clientFailureReason(error));
	} finally {
		// Every exit path releases the single connection and the lease.
		try {
			await client?.close();
		} catch {
			// The connection is already gone; nothing else to release.
		}
		try {
			lease?.close();
			if (lease !== null) observationTestHooks.onLeaseClosed?.();
		} catch {
			// The lease is already closed; nothing else to release.
		}
	}
}

/** Map a native lease refusal onto the public reason enum. */
function leaseReason(reason: string | null | undefined): BrokerObservationUnavailableReason {
	switch (reason) {
		case "absent":
			return "absent";
		case "stale":
			return "stale";
		case "unsafe_discovery":
			return "unsafe_discovery";
		case "unsupported":
			return "unsupported";
		case "timeout":
			return "timeout";
		default:
			return "unsafe_discovery";
	}
}

/** Map an SdkClient failure onto the public reason enum. */
function clientFailureReason(error: unknown): BrokerObservationUnavailableReason {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "unauthorized" || code === "forbidden") return "authentication_failed";
	if (code === "timeout" || code === "deadline_exceeded") return "timeout";
	if (code === "unknown_operation" || code === "unsupported_operation") return "unsupported";
	return "transport_unavailable";
}

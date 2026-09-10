/**
 * Local interactive-master CLI surface.
 *
 * `gjc sdk spawn` is legal only inside a live master session: the master's Bash
 * tool threads the transient capability only through a strict direct spawn
 * command, and the Broker still verifies it against the live effective host
 * before any effect.
 * No output path may echo the task or capability.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { PublicCommandFailure } from "../../cli/public-command-errors";
import { type IndexedSession, isSessionAuthorityEligible, SessionIndex } from "../broker/session-index";
import { SdkClientError } from "../client";
import { dispatchSpawnGlobal } from "../lifecycle/broker-client";
import { sdkPublicFailure } from "./session-cli";

const MASTER_CAPABILITY_ENV = "GJC_MASTER_CAPABILITY";
const MASTER_SESSION_ENV = "GJC_MASTER_OWNER_SESSION_ID";
const SPAWN_TIMEOUT_MS = 120_000;

export class SdkMasterCliError extends PublicCommandFailure {
	constructor(
		readonly code: string,
		_message: string,
		readonly exitCode: 1 | 2 = 1,
	) {
		super(sdkPublicFailure(exitCode === 2 ? "usage" : code, undefined, "pre-effect").input);
		this.name = "SdkMasterCliError";
	}
}

export interface SdkSpawnArgs {
	cwd?: string;
	prompt?: string;
	model?: string;
	profile?: string;
	agentDir?: string;
	idempotencyKey?: string;
	json?: boolean;
}

/** The allowlisted spawn result projection rendered to the operator. */
export interface SdkSpawnRendered {
	code: string;
	claimId?: string;
	sessionId?: string;
	substrateKind?: string;
	seed?: { phase?: string; clientRef?: string; commandId?: string; turnId?: string; status?: string };
}

export interface SdkSpawnDependencies {
	env: Record<string, string | undefined>;
	dispatch: (agentDir: string, input: Record<string, unknown>, idempotencyKey: string) => Promise<unknown>;
	resolveAttestationEpoch: (agentDir: string, ownerSessionId: string) => Promise<string | undefined>;
}

async function brokerSpawnDispatch(
	agentDir: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
): Promise<unknown> {
	return await dispatchSpawnGlobal(agentDir, input, idempotencyKey, SPAWN_TIMEOUT_MS);
}

/**
 * Select the newest retained master attestation for an owner session.
 *
 * `listSessionIdentities()` can retain both the direct-role row and one or
 * more endpoint generations. Its iteration order is a projection detail, not
 * authority ordering, so selecting the first matching row can resurrect an
 * older epoch after a master relaunch. The broker's monotonically increasing
 * `indexSeq` is the authoritative retained ordering.
 */
export function selectNewestMasterAttestationEpoch(
	rows: readonly IndexedSession[],
	ownerSessionId: string,
): string | undefined {
	const processIdentity = (row: IndexedSession): string | undefined => row.hostIncarnation ?? row.processIncarnation;
	const matchesAttestation = (
		left: NonNullable<IndexedSession["masterRole"]>,
		right: NonNullable<IndexedSession["masterRole"]>,
	) =>
		left.version === right.version &&
		left.ownerSessionId === right.ownerSessionId &&
		left.launchPid === right.launchPid &&
		left.launchProcessIncarnation === right.launchProcessIncarnation &&
		left.role === right.role &&
		left.attestationEpoch === right.attestationEpoch;
	const hasDirectAttestation = (effective: IndexedSession): boolean =>
		rows.some(
			row =>
				row.sessionId === effective.sessionId &&
				row.endpointGeneration === 0 &&
				row.pid === effective.masterRole?.launchPid &&
				processIdentity(row) === effective.masterRole?.launchProcessIncarnation &&
				row.masterRole !== undefined &&
				effective.masterRole !== undefined &&
				matchesAttestation(row.masterRole, effective.masterRole),
		);
	let newest: { indexSeq: number; epoch: string } | undefined;
	for (const row of rows) {
		const attestation = row.masterRole;
		if (
			!Number.isSafeInteger(row.indexSeq) ||
			attestation === undefined ||
			attestation.version !== 2 ||
			attestation.role !== "master" ||
			attestation.ownerSessionId !== ownerSessionId ||
			row.endpointGeneration <= 0 ||
			row.live !== true ||
			row.terminal ||
			row.terminalUncertain ||
			!isSessionAuthorityEligible(row) ||
			attestation.launchPid !== row.pid ||
			attestation.launchProcessIncarnation !== processIdentity(row) ||
			!hasDirectAttestation(row) ||
			typeof attestation.attestationEpoch !== "string" ||
			attestation.attestationEpoch.length === 0 ||
			attestation.attestationEpoch.length > 512 ||
			!/^[A-Za-z0-9_-]+$/u.test(attestation.attestationEpoch)
		)
			continue;
		if (newest === undefined || row.indexSeq > newest.indexSeq)
			newest = { indexSeq: row.indexSeq, epoch: attestation.attestationEpoch };
	}
	return newest?.epoch;
}

async function indexAttestationEpoch(agentDir: string, ownerSessionId: string): Promise<string | undefined> {
	const index = await new SessionIndex(agentDir).open();
	return selectNewestMasterAttestationEpoch(index.listSessionIdentities(), ownerSessionId);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function opaque(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

/** Projects an arbitrary Broker response onto the allowlisted render shape. */
export function safeSpawnRender(
	response: unknown,
	idempotencyKey?: string,
): { rendered: SdkSpawnRendered; exitCode: 0 } {
	const outer = record(response);
	if (outer?.ok === true) {
		const result = record(outer.result);
		const seed = record(result?.seed);
		return {
			rendered: {
				code: opaque(result?.code) ?? "spawn_accepted",
				...(opaque(result?.claimId) === undefined ? {} : { claimId: opaque(result?.claimId) }),
				...(opaque(result?.sessionId) === undefined ? {} : { sessionId: opaque(result?.sessionId) }),
				...(opaque(result?.substrateKind) === undefined ? {} : { substrateKind: opaque(result?.substrateKind) }),
				...(seed === undefined
					? {}
					: {
							seed: {
								...(opaque(seed.phase) === undefined ? {} : { phase: opaque(seed.phase) }),
								...(opaque(seed.clientRef) === undefined ? {} : { clientRef: opaque(seed.clientRef) }),
								...(opaque(seed.commandId) === undefined ? {} : { commandId: opaque(seed.commandId) }),
								...(opaque(seed.turnId) === undefined ? {} : { turnId: opaque(seed.turnId) }),
								...(opaque(seed.status) === undefined ? {} : { status: opaque(seed.status) }),
							},
						}),
			},
			exitCode: 0,
		};
	}
	const error = record(outer?.error);
	const result = record(outer?.result);
	const seed = record(result?.seed);
	const failure = sdkPublicFailure(typeof error?.code === "string" ? error.code : "operation_failed", error);
	const resultReferences = sdkPublicFailure("operation_failed", result).input.references ?? [];
	const seedReferences = sdkPublicFailure("operation_failed", seed).input.references ?? [];
	throw new PublicCommandFailure({
		...failure.input,
		references: [
			...(failure.input.references ?? []),
			...resultReferences,
			...seedReferences,
			...(idempotencyKey === undefined ? [] : [{ kind: "idempotencyKey" as const, value: idempotencyKey }]),
		],
	});
}

export function renderSpawnTable(rendered: SdkSpawnRendered): string {
	const lines = [`Result: ${rendered.code}`];
	if (rendered.claimId) lines.push(`Claim: ${rendered.claimId}`);
	if (rendered.sessionId) lines.push(`Child session: ${rendered.sessionId}`);
	if (rendered.substrateKind) lines.push(`Substrate: ${rendered.substrateKind}`);
	if (rendered.seed?.phase) lines.push(`Seed phase: ${rendered.seed.phase}`);
	if (rendered.seed?.status) lines.push(`Seed status: ${rendered.seed.status}`);

	return lines.join("\n");
}

/**
 * Runs one local master spawn. A caller-provided idempotency key replays the
 * matching durable claim; otherwise each invocation receives a fresh key.
 */
export async function runSdkSpawn(
	args: SdkSpawnArgs,
	dependencies: Partial<SdkSpawnDependencies> = {},
): Promise<{ rendered: SdkSpawnRendered; exitCode: 0 }> {
	const deps: SdkSpawnDependencies = {
		env: dependencies.env ?? process.env,
		dispatch: dependencies.dispatch ?? brokerSpawnDispatch,
		resolveAttestationEpoch: dependencies.resolveAttestationEpoch ?? indexAttestationEpoch,
	};
	if (!args.cwd) throw new SdkMasterCliError("invalid_input", "sdk spawn requires --cwd <dir>.", 2);
	if (!args.prompt) throw new SdkMasterCliError("invalid_input", "sdk spawn requires --prompt <task>.", 2);
	const capability = deps.env[MASTER_CAPABILITY_ENV];
	const ownerSessionId = deps.env[MASTER_SESSION_ENV];
	if (!capability || !ownerSessionId)
		throw new SdkMasterCliError(
			"master_context_required",
			"sdk spawn is available only inside a live interactive master session.",
			1,
		);
	const agentDir = args.agentDir ?? getAgentDir();
	const attestationEpoch = await deps.resolveAttestationEpoch(agentDir, ownerSessionId);
	if (!attestationEpoch)
		throw new SdkMasterCliError(
			"master_context_required",
			"No master role attestation exists for this session; relaunch with gjc --master.",
			1,
		);
	const idempotencyKey = args.idempotencyKey ?? randomUUID();
	try {
		const response = await deps.dispatch(
			agentDir,
			{
				task: args.prompt,
				masterCapability: capability,
				ownerSessionId,
				attestationEpoch,
				cwd: args.cwd === undefined ? undefined : path.resolve(args.cwd),
				...(args.model === undefined ? {} : { modelId: args.model }),
				...(args.profile === undefined ? {} : { modelPreset: args.profile }),
			},
			idempotencyKey,
		);
		return safeSpawnRender(response, idempotencyKey);
	} catch (error) {
		if (error instanceof PublicCommandFailure) throw error;
		if (error instanceof SdkClientError) {
			const failure = sdkPublicFailure(error.code, error.details);
			throw new PublicCommandFailure({
				...failure.input,
				references: [...(failure.input.references ?? []), { kind: "idempotencyKey", value: idempotencyKey }],
			});
		}
		throw new PublicCommandFailure({
			kind: "operation_failed",
			references: [{ kind: "idempotencyKey", value: idempotencyKey }],
		});
	}
}

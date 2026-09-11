import type { DaemonStatus } from "../daemon/control-types";
import {
	type EvidenceClassification,
	type EvidenceContinuation,
	type EvidenceReference,
	type EvidenceReferenceKind,
	type EvidenceUnavailableReason,
	publishCommandEvidence,
} from "./public-command-evidence";

export type PublicFailureKind =
	| "usage"
	| "invalid_json"
	| "unavailable"
	| "broker_unavailable"
	| "endpoint_stale"
	| "broker_restarting"
	| "authorization_denied"
	| "timeout"
	| "wait_timeout"
	| "uncertain_after_send"
	| "daemon_unhealthy"
	| "daemon_stale"
	| "daemon_mixed"
	| "operation_failed"
	| "internal";
export type PublicEffectProof = "pre-send" | "pre-effect" | "accepted" | "completed" | "sent" | "unknown";
export interface PublicDaemonTargetOutcome {
	kind: "telegram" | "discord" | "slack";
	outcome: "not-applied" | "applied" | "unknown";
}
export interface PublicCommandFailureInput {
	kind: PublicFailureKind;
	proof?: PublicEffectProof;
	references?: readonly EvidenceReference[];
	daemonKind?: "telegram" | "discord" | "slack";
	restartJustified?: boolean;
	targets?: readonly PublicDaemonTargetOutcome[];
	partialStatuses?: readonly DaemonStatus[];
	diagnostics?: readonly PublicCommandDiagnosticCode[];
}
export class PublicCommandFailure extends Error {
	readonly input: PublicCommandFailureInput;
	constructor(input: PublicCommandFailureInput) {
		super("Public command failed");
		this.name = "PublicCommandFailure";
		this.input = input;
	}
}
export interface PublicRecoveryStep {
	description: string;
	disruption: "none" | "interrupts-work" | "force-kill";
	requiresConfirmation: boolean;
	executable?: "gjc";
	argv?: string[];
}
export interface ClassifiedPublicCommandFailure extends EvidenceClassification {
	message: string;
	references: EvidenceReference[];
	nextSteps: PublicRecoveryStep[];
	partialStatuses?: DaemonStatus[];
	exitCode: 1 | 2;
}
export const EVIDENCE_UNAVAILABLE_WARNING =
	"Necessary reconciliation evidence could not be retained; no lossless continuation is available. Do not blindly retry the original operation.";
export type PublicEvidenceStatus =
	| { status: "inline" }
	| { status: "retained"; id: string; sha256: string; bytes: number; expiresAt: string }
	| {
			status: "unavailable";
			reason: EvidenceUnavailableReason;
			requiredBytes: number | null;
			missingKinds: string[];
			warning: typeof EVIDENCE_UNAVAILABLE_WARNING;
	  };
export const PUBLIC_COMMAND_DIAGNOSTICS = {
	macos_nofile_limit_low:
		"The macOS open-file limit is below the recommended minimum; increase it before starting additional concurrent work.",
	router_cleanup_failed: "SDK session Router cleanup failed.",
	broker_cleanup_failed: "SDK broker client cleanup failed.",
} as const;
export type PublicCommandDiagnosticCode = keyof typeof PUBLIC_COMMAND_DIAGNOSTICS;
export interface PublicCommandDiagnostic {
	code: PublicCommandDiagnosticCode;
	message: string;
}
export interface PublicCommandErrorEnvelope {
	schema: "gjc.command-error";
	version: 1;
	ok: false;
	command: string[];
	error: Omit<ClassifiedPublicCommandFailure, "exitCode">;
	diagnostics?: PublicCommandDiagnostic[];
	omittedOptional: { path: string; reason: string }[];
	complete: boolean;
	evidence: PublicEvidenceStatus;
	continuation: EvidenceContinuation | null;
}
export interface RenderPublicCommandFailureOptions {
	command: readonly string[];
	json?: boolean;
	agentDir?: string;
	scopeAgentDir?: string;
	diagnostics?: readonly PublicCommandDiagnosticCode[];
}
export interface RenderedPublicCommandFailure {
	stdout: string;
	stderr: string;
	exitCode: 1 | 2;
	envelope: PublicCommandErrorEnvelope;
}

const referenceKinds = new Set<EvidenceReferenceKind>([
	"sessionId",
	"operationRef",
	"idempotencyKey",
	"claimId",
	"commandId",
	"turnId",
]);
const messages: Record<PublicFailureKind, string> = {
	usage: "The command arguments are invalid.",
	invalid_json: "The command JSON input is invalid.",
	unavailable: "The requested service is unavailable.",
	broker_unavailable: "The SDK broker is unavailable.",
	endpoint_stale: "The SDK endpoint is stale or unavailable.",
	broker_restarting: "The SDK broker is restarting. Do not initiate another restart.",
	authorization_denied: "The operation was denied by authorization policy.",
	timeout: "The operation timed out; its outcome requires reconciliation.",
	wait_timeout: "Waiting timed out after the operation was accepted. Do not replay it.",
	uncertain_after_send: "The request was sent but its outcome is uncertain. Reconcile before any replay.",
	daemon_unhealthy: "The selected daemon is unhealthy.",
	daemon_stale: "The selected daemon has stale runtime state.",
	daemon_mixed: "Some daemon targets failed. Do not repeat mutations that already succeeded.",
	operation_failed: "The operation failed. Its outcome could not be established.",
	internal: "The command encountered an internal failure.",
};
function commandPath(command: readonly string[]): string[] {
	if (
		command.length > 0 &&
		command.length <= 5 &&
		["sdk", "daemon"].includes(command[0]!) &&
		command.every(token => /^[a-z][a-z-]{0,31}$/.test(token))
	)
		return [...command];
	return [command[0] === "daemon" ? "daemon" : "sdk"];
}
function safeReferences(references: readonly EvidenceReference[] | undefined): EvidenceReference[] {
	if (!Array.isArray(references)) return [];
	return references
		.filter(ref => ref && referenceKinds.has(ref.kind) && typeof ref.value === "string")
		.map(ref => ({ kind: ref.kind, value: ref.value }));
}
export function normalizePublicCommandFailure(error: unknown): PublicCommandFailure {
	if (error instanceof PublicCommandFailure && error.input && Object.hasOwn(messages, error.input.kind)) return error;
	return new PublicCommandFailure({ kind: "operation_failed" });
}
function step(
	description: string,
	argv?: string[],
	disruption: PublicRecoveryStep["disruption"] = "none",
): PublicRecoveryStep {
	return {
		description,
		disruption,
		requiresConfirmation: disruption !== "none",
		...(argv ? { executable: "gjc" as const, argv } : {}),
	};
}
export function classifyPublicCommandFailure(
	error: unknown,
	command: readonly string[],
): ClassifiedPublicCommandFailure {
	const input = normalizePublicCommandFailure(error).input;
	const kind = input.kind;
	const references = safeReferences(input.references);
	const canonical = commandPath(command);
	const beforeEffect = input.proof === "pre-send" || input.proof === "pre-effect";
	let outcomeCertainty: EvidenceClassification["outcomeCertainty"] = beforeEffect
		? "not-applied"
		: input.proof === "accepted" || input.proof === "completed"
			? "applied"
			: "unknown";
	let retryability: EvidenceClassification["retryability"] = "unknown";
	let category: EvidenceClassification["category"] = "operation";
	const nextSteps: PublicRecoveryStep[] = [];
	const usage = kind === "usage" || kind === "invalid_json";
	if (usage) {
		category = "usage";
		outcomeCertainty = "not-applied";
		retryability = "no";
		nextSteps.push(step("Read the exact command help and correct the input.", [...canonical, "--help"]));
	} else if (kind === "authorization_denied") {
		category = "authorization";
		retryability = "no";
		nextSteps.push(step("Use the authorized caller and required master context. Do not print or share credentials."));
	} else if (kind === "wait_timeout") {
		category = "timeout";
		outcomeCertainty = "applied";
		retryability = "no";
	} else if (kind === "timeout") category = "timeout";
	else if (kind === "uncertain_after_send") {
		category = "uncertain";
		outcomeCertainty = "unknown";
	} else if (
		[
			"unavailable",
			"broker_unavailable",
			"endpoint_stale",
			"broker_restarting",
			"daemon_unhealthy",
			"daemon_stale",
		].includes(kind)
	)
		category = "unavailable";
	else if (kind === "internal") category = "internal";
	if (kind === "daemon_mixed") {
		const targets = input.targets;
		outcomeCertainty =
			targets?.length && targets.every(target => target.outcome === "applied")
				? "applied"
				: targets?.length && targets.every(target => target.outcome === "not-applied")
					? "not-applied"
					: "unknown";
		// Only the bounded allowlisted target identity and typed outcome are rendered.
		for (const daemonKind of ["telegram", "discord", "slack"] as const) {
			const matches = targets?.filter(target => target.kind === daemonKind);
			if (!matches?.length) continue;
			const outcome = matches.every(target => target.outcome === "applied")
				? "applied"
				: matches.every(target => target.outcome === "not-applied")
					? "not-applied"
					: "unknown";
			nextSteps.push(
				step(`${daemonKind}: outcome ${outcome}. Inspect this target; do not replay a successful mutation.`, [
					"daemon",
					"status",
					daemonKind,
				]),
			);
		}
	}
	if (!usage) {
		if (kind === "broker_restarting")
			nextSteps.push(step("Wait for the existing restart to finish, then inspect status; do not restart again."));
		const session = references.find(ref => ref.kind === "sessionId");
		const operation = references.find(ref => ref.kind === "operationRef");
		if (
			canonical[0] === "sdk" &&
			session &&
			operation &&
			executableValue(session.value) &&
			executableValue(operation.value)
		) {
			nextSteps.push(
				step(
					"Reconcile the existing operation by its complete session and operation references before any replay.",
					["sdk", "session", "status", session.value, operation.value],
				),
			);
		} else if (canonical[0] === "sdk" && kind !== "authorization_denied") {
			nextSteps.push(
				step("Inspect existing session state before deciding whether another operation is safe.", [
					"sdk",
					"session",
					"list",
				]),
			);
		}
		if (
			canonical[0] === "daemon" &&
			input.daemonKind &&
			["telegram", "discord", "slack"].includes(input.daemonKind)
		) {
			nextSteps.push(step("Inspect only the affected daemon target.", ["daemon", "status", input.daemonKind]));
			if ((kind === "daemon_unhealthy" || kind === "daemon_stale") && input.restartJustified === true)
				nextSteps.push(
					step(
						"Restart only this diagnosed daemon after confirming interruption of its work is acceptable.",
						["daemon", "restart", input.daemonKind],
						"interrupts-work",
					),
				);
		}
		if (outcomeCertainty === "unknown")
			nextSteps.push(
				step("The operation outcome is unknown. Reconcile available evidence and do not blindly retry."),
			);
	}
	return {
		code: kind,
		category,
		message: messages[kind],
		retryability,
		outcomeCertainty,
		references,
		nextSteps,
		...(input.partialStatuses === undefined ? {} : { partialStatuses: [...input.partialStatuses].slice(0, 3) }),
		exitCode: usage ? 2 : 1,
	};
}
function executableValue(value: string): boolean {
	return value.length > 0 && value.length <= 1024 && !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value);
}
function serialize(envelope: PublicCommandErrorEnvelope, json: boolean): string {
	if (json) return `${JSON.stringify(envelope)}\n`;
	// JSON quoting escapes terminal controls and preserves complete values. Display
	// strings are not shell commands: executable suggestions remain argv arrays.
	return `COMMAND ${JSON.stringify(envelope.command)}\nERROR ${JSON.stringify(envelope.error)}\n${envelope.diagnostics ? `DIAGNOSTICS ${JSON.stringify(envelope.diagnostics)}\n` : ""}COMPLETE ${envelope.complete}\nEVIDENCE ${JSON.stringify(envelope.evidence)}\nOMITTED_OPTIONAL ${JSON.stringify(envelope.omittedOptional)}\nCONTINUATION ${JSON.stringify(envelope.continuation)}\n`.replace(
		/[\x7f-\x9f\u2028\u2029]/g,
		character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
function fits(envelope: PublicCommandErrorEnvelope, json: boolean): boolean {
	return Buffer.byteLength(serialize(envelope, json)) <= 8192;
}
function trimSteps(envelope: PublicCommandErrorEnvelope, json: boolean): void {
	while (!fits(envelope, json) && envelope.error.nextSteps.length) {
		envelope.error.nextSteps.pop();
		if (!envelope.omittedOptional.some(item => item.path === "error.nextSteps"))
			envelope.omittedOptional.push({ path: "error.nextSteps", reason: "output_budget" });
	}
}

function reserveDiagnostics(
	envelope: PublicCommandErrorEnvelope,
	options: RenderPublicCommandFailureOptions,
	failureDiagnostics?: readonly PublicCommandDiagnosticCode[],
): PublicCommandDiagnostic[] {
	// Iterate the static allowlist, not caller-sized input; messages are never caller supplied.
	const diagnostics = (Object.keys(PUBLIC_COMMAND_DIAGNOSTICS) as PublicCommandDiagnosticCode[])
		.filter(code => options.diagnostics?.includes(code) || failureDiagnostics?.includes(code))
		.map(code => ({ code, message: PUBLIC_COMMAND_DIAGNOSTICS[code] }));
	if (diagnostics.length) envelope.omittedOptional.push({ path: "diagnostics", reason: "output_budget" });
	return diagnostics;
}

function includeDiagnostics(
	envelope: PublicCommandErrorEnvelope,
	diagnostics: PublicCommandDiagnostic[],
	json: boolean,
): void {
	if (!diagnostics.length) return;
	const omissions = envelope.omittedOptional;
	envelope.omittedOptional = omissions.filter(item => item.path !== "diagnostics");
	envelope.diagnostics = diagnostics;
	if (!fits(envelope, json)) {
		delete envelope.diagnostics;
		envelope.omittedOptional = omissions;
	}
}
export async function renderPublicCommandFailure(
	error: unknown,
	options: RenderPublicCommandFailureOptions,
): Promise<RenderedPublicCommandFailure> {
	const classified = classifyPublicCommandFailure(error, options.command);
	const { exitCode, ...safeError } = classified;
	const references = safeError.references;
	const json = options.json === true;
	if (options.scopeAgentDir !== undefined) {
		for (const recovery of safeError.nextSteps) {
			if (recovery.argv?.[0] !== "sdk" || recovery.argv.at(-1) === "--help") continue;
			if (options.scopeAgentDir.length <= 1024 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(options.scopeAgentDir))
				recovery.argv.push(`--agent-dir=${options.scopeAgentDir}`);
			else {
				delete recovery.executable;
				delete recovery.argv;
			}
		}
	}
	const envelope: PublicCommandErrorEnvelope = {
		schema: "gjc.command-error",
		version: 1,
		ok: false,
		command: commandPath(options.command),
		error: { ...safeError, references: [] },
		omittedOptional: [],
		complete: true,
		evidence: { status: "inline" },
		continuation: null,
	};
	const diagnostics = reserveDiagnostics(envelope, options, normalizePublicCommandFailure(error).input.diagnostics);
	// Avoid serializing a caller-sized reference merely to discover it cannot fit.
	let overflow = false;
	for (const reference of references) {
		if (reference.value.length > 8192) {
			overflow = true;
			continue;
		}
		envelope.error.references.push(reference);
		if (!fits(envelope, json)) trimSteps(envelope, json);
		if (!fits(envelope, json)) {
			envelope.error.references.pop();
			overflow = true;
		}
	}
	trimSteps(envelope, json);
	if (overflow) {
		envelope.complete = false;
		const retained =
			options.agentDir === undefined
				? { status: "unavailable" as const, reason: "io_error" as const, requiredBytes: null }
				: await publishCommandEvidence(
						{ agentDir: options.agentDir, command: envelope.command, error: classified, references },
						{ family: envelope.command[0] as "sdk" | "daemon", scopeAgentDir: options.scopeAgentDir, json },
					);
		if (retained.status === "retained") {
			envelope.evidence = {
				status: "retained",
				id: retained.id,
				sha256: retained.sha256,
				bytes: retained.bytes,
				expiresAt: retained.expiresAt,
			};
			envelope.continuation = retained.continuation;
		} else {
			envelope.evidence = {
				status: "unavailable",
				reason: retained.reason,
				requiredBytes: retained.requiredBytes,
				missingKinds: [...new Set(references.map(ref => ref.kind))],
				warning: EVIDENCE_UNAVAILABLE_WARNING,
			};
		}
		trimSteps(envelope, json);
		while (!fits(envelope, json) && envelope.error.references.length) envelope.error.references.pop();
		if (envelope.evidence.status === "unavailable") {
			const included = new Set(envelope.error.references);
			envelope.evidence.missingKinds = [
				...new Set(references.filter(ref => !included.has(ref)).map(ref => ref.kind)),
			];
		}
	}
	// Text control escaping can expand a locator beyond its JSON admission size.
	// Never advertise a continuation that cannot be represented within this mode.
	if (!fits(envelope, json)) {
		envelope.complete = false;
		envelope.continuation = null;
		envelope.evidence = {
			status: "unavailable",
			reason: "locator_too_large",
			requiredBytes: envelope.evidence.status === "retained" ? envelope.evidence.bytes : null,
			missingKinds: [...new Set(references.map(ref => ref.kind))],
			warning: EVIDENCE_UNAVAILABLE_WARNING,
		};
		trimSteps(envelope, json);
		while (!fits(envelope, json) && envelope.error.references.length) envelope.error.references.pop();
	}
	includeDiagnostics(envelope, diagnostics, json);
	const output = serialize(envelope, json);
	return { stdout: json ? output : "", stderr: json ? "" : output, exitCode, envelope };
}

/** Retrieval failures never recursively publish evidence or replay an operation. */
export function renderPublicEvidenceUnavailable(
	unavailable: { reason: EvidenceUnavailableReason; requiredBytes: number | null },
	options: RenderPublicCommandFailureOptions,
): RenderedPublicCommandFailure {
	const { exitCode: _exitCode, ...error } = classifyPublicCommandFailure(
		new PublicCommandFailure({ kind: "operation_failed", proof: "pre-effect" }),
		options.command,
	);
	const envelope: PublicCommandErrorEnvelope = {
		schema: "gjc.command-error",
		version: 1,
		ok: false,
		command: commandPath(options.command),
		error: {
			...error,
			code: "evidence_unavailable",
			message: "Retained command evidence is unavailable; do not replay the original operation.",
		},
		omittedOptional: [],
		complete: false,
		evidence: {
			status: "unavailable",
			reason: unavailable.reason,
			requiredBytes: unavailable.requiredBytes,
			missingKinds: [],
			warning: EVIDENCE_UNAVAILABLE_WARNING,
		},
		continuation: null,
	};
	const diagnostics = reserveDiagnostics(envelope, options);
	trimSteps(envelope, options.json === true);
	includeDiagnostics(envelope, diagnostics, options.json === true);
	const output = serialize(envelope, options.json === true);
	return { stdout: options.json ? output : "", stderr: options.json ? "" : output, exitCode: 1, envelope };
}

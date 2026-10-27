import * as crypto from "node:crypto";

interface ManagedOwnerBindingBase {
	schema_version: 3;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	created_at: string;
}
export interface ManagedOwnerOpaqueBinding extends ManagedOwnerBindingBase {
	binding_kind: "opaque";
}
export interface ManagedOwnerRecoverableBinding extends ManagedOwnerBindingBase {
	binding_kind: "recoverable";
	command: string[];
	command_sha256: string;
}
export type ManagedOwnerBinding = ManagedOwnerOpaqueBinding | ManagedOwnerRecoverableBinding;
export interface ManagedOwnerSigabrtReceipt {
	schema_version: 2;
	generation: string;
	session_id: string;
	run_id: string;
	endpoint_incarnation: string;
	child_token: string;
	command_sha256: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	child_pid: number;
	child_start_time: string;
	signal: "SIGABRT";
	signal_number: 6;
	exit_code: number | null;
	received_at: string;
}
export interface ManagedOwnerBindingIdentity {
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
	token: string;
}
const identityKeys = ["generation", "session_id", "run_id", "endpoint_incarnation", "child_token"] as const;
const baseKeys = [
	"schema_version",
	"binding_kind",
	...identityKeys,
	"supervisor_pid",
	"supervisor_start_time",
	"created_at",
];
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
function timestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
	const time = Date.parse(value);
	return (
		Number.isFinite(time) &&
		new Date(time).toISOString() === (value.includes(".") ? value : value.replace(/Z$/, ".000Z"))
	);
}
function positivePid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function managedOwnerCommandDigest(command: readonly string[]): string {
	return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
/** A runnable argv: a nonempty executable; later arguments may be empty but never contain NUL. */
export function isManagedOwnerCommand(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(argument => typeof argument === "string" && !argument.includes("\0")) &&
		(value[0] as string).length > 0
	);
}
export function isManagedOwnerBinding(
	value: unknown,
	expected?: ManagedOwnerBindingIdentity,
): value is ManagedOwnerBinding {
	if (
		!record(value) ||
		value.schema_version !== 3 ||
		!identityKeys.every(key => nonempty(value[key])) ||
		!positivePid(value.supervisor_pid) ||
		!nonempty(value.supervisor_start_time) ||
		!timestamp(value.created_at)
	)
		return false;
	if (
		expected &&
		(value.generation !== expected.generation ||
			value.session_id !== expected.sessionId ||
			value.run_id !== expected.runId ||
			value.endpoint_incarnation !== expected.incarnation ||
			value.child_token !== expected.token)
	)
		return false;
	if (value.binding_kind === "opaque") return exactKeys(value, baseKeys);
	return (
		value.binding_kind === "recoverable" &&
		exactKeys(value, [...baseKeys, "command", "command_sha256"]) &&
		isManagedOwnerCommand(value.command) &&
		value.command_sha256 === managedOwnerCommandDigest(value.command)
	);
}
export function isManagedOwnerSigabrtReceipt(
	value: unknown,
	binding: ManagedOwnerRecoverableBinding,
): value is ManagedOwnerSigabrtReceipt {
	return (
		record(value) &&
		binding.binding_kind === "recoverable" &&
		exactKeys(value, [
			"schema_version",
			...identityKeys,
			"command_sha256",
			"supervisor_pid",
			"supervisor_start_time",
			"child_pid",
			"child_start_time",
			"signal",
			"signal_number",
			"exit_code",
			"received_at",
		]) &&
		value.schema_version === 2 &&
		identityKeys.every(key => value[key] === binding[key]) &&
		value.command_sha256 === binding.command_sha256 &&
		value.supervisor_pid === binding.supervisor_pid &&
		value.supervisor_start_time === binding.supervisor_start_time &&
		positivePid(value.child_pid) &&
		nonempty(value.child_start_time) &&
		value.signal === "SIGABRT" &&
		value.signal_number === 6 &&
		(value.exit_code === null || (typeof value.exit_code === "number" && Number.isSafeInteger(value.exit_code))) &&
		timestamp(value.received_at)
	);
}

/**
 * Darwin: one per generation, published no-replace by the generation's supervisor
 * after its binding. A close reads this exact file instead of scanning the
 * lifecycle root, so retained history from earlier generations never matters.
 */
export interface ManagedOwnerSupervisorIndex {
	schema_version: 1;
	generation: string;
	session_id: string;
	child_token: string;
	supervisor_pid: number;
	supervisor_start_time: string;
}
export function isManagedOwnerSupervisorIndex(value: unknown): value is ManagedOwnerSupervisorIndex {
	return (
		record(value) &&
		exactKeys(value, [
			"schema_version",
			"generation",
			"session_id",
			"child_token",
			"supervisor_pid",
			"supervisor_start_time",
		]) &&
		value.schema_version === 1 &&
		nonempty(value.generation) &&
		nonempty(value.session_id) &&
		nonempty(value.child_token) &&
		positivePid(value.supervisor_pid) &&
		nonempty(value.supervisor_start_time)
	);
}

/**
 * Darwin: published no-replace by the exact supervisor, under the generation lock,
 * as `relay-<generation>.pending.json` before it relays SIGTERM for one cooperative
 * intent. Only after the signal was sent does it publish `relay-<generation>.json`,
 * whose `relayed_at` was sampled immediately before delivery, and remove the
 * pending record. Only the confirmed record proves delivery: an operator-shutdown
 * verdict requires it, and never for an observation earlier than `relayed_at`. A pending record without confirmation is uncertain and blocks retirement; an
 * expired intent with neither was provably never delivered and may be retired.
 */
export interface ManagedOwnerRelayRecord {
	schema_version: 1;
	intent_id: string;
	dispatch_id: string;
	generation: string;
	session_id: string;
	server_key: string;
	child_token: string;
	supervisor_pid: number;
	supervisor_start_time: string;
	relayed_at: string;
}
export function isManagedOwnerRelayRecord(value: unknown): value is ManagedOwnerRelayRecord {
	return (
		record(value) &&
		exactKeys(value, [
			"schema_version",
			"intent_id",
			"dispatch_id",
			"generation",
			"session_id",
			"server_key",
			"child_token",
			"supervisor_pid",
			"supervisor_start_time",
			"relayed_at",
		]) &&
		value.schema_version === 1 &&
		nonempty(value.intent_id) &&
		nonempty(value.dispatch_id) &&
		nonempty(value.generation) &&
		nonempty(value.session_id) &&
		nonempty(value.server_key) &&
		nonempty(value.child_token) &&
		positivePid(value.supervisor_pid) &&
		nonempty(value.supervisor_start_time) &&
		timestamp(value.relayed_at)
	);
}

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
		Array.isArray(value.command) &&
		value.command.length > 0 &&
		value.command.every(
			argument => typeof argument === "string" && argument.length > 0 && !argument.includes("\0"),
		) &&
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

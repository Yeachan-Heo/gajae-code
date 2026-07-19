import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import { assertSafeCodexEndpoint } from "./codex-wake-publisher";

export const CODEX_WAKE_EVENT_KINDS = [
	"question.opened",
	"turn.waiting_for_answer",
	"turn.completed",
	"turn.failed",
	"turn.cancelled",
	"turn.superseded",
] as const;

export type CodexWakeEventKind = (typeof CODEX_WAKE_EVENT_KINDS)[number];

export type CodexHandoffEndpoint = { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number };
export interface CodexHandoffOriginV1 {
	gjc_session_id: string | null;
	gjc_turn_id: string | null;
	codex_thread_id: string;
	codex_turn_id: string | null;
	codex_host_session_id: string | null;
	delegation_id: string;
	workflow: string;
	bound_at: string;
}

export interface CodexHandoffRegistrationV1 {
	schema_version: 1;
	work_unit: string;
	thread_id: string;
	endpoint: CodexHandoffEndpoint;
	token_file: string | null;
	registered_at: string;
	updated_at: string;
	origin?: CodexHandoffOriginV1;
}

export interface CodexWakeEventV1 {
	schema_version: 1;
	key: string;
	work_unit: string;
	event_seq: number;
	event_kind: CodexWakeEventKind;
	turn_id: string | null;
	question_id: string | null;
	summary: string;
	status: "pending" | "published" | "acked" | "failed";
	attempts: number;
	client_user_message_id: string;
	created_at: string;
	updated_at: string;
	last_error: string | null;
}
export const CODEX_WAKE_LIFECYCLE_SCHEMA_VERSION = 1;

export type CodexWakeLifecycle = "requested" | "delivered" | "acknowledged" | "failed";

export function codexWakeLifecycle(status: CodexWakeEventV1["status"]): CodexWakeLifecycle {
	switch (status) {
		case "pending":
			return "requested";
		case "published":
			return "delivered";
		case "acked":
			return "acknowledged";
		case "failed":
			return "failed";
	}
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export function isCodexWakeEventKind(value: string): value is CodexWakeEventKind {
	return (CODEX_WAKE_EVENT_KINDS as readonly string[]).includes(value);
}

export function codexWakeKey(workUnit: string, eventSeq: number): string {
	return `${workUnit}:${eventSeq}`;
}

export function codexClientUserMessageId(key: string): string {
	return `gjc-wake-${key}`;
}

function assertWorkUnit(workUnit: string): string {
	if (!SAFE_ID.test(workUnit)) throw new Error("invalid_work_unit");
	return workUnit;
}

function assertThreadId(threadId: string): string {
	if (!SAFE_ID.test(threadId)) throw new Error("invalid_thread_id");
	return threadId;
}

function assertEventSeq(eventSeq: number): number {
	if (!Number.isInteger(eventSeq) || eventSeq < 0) throw new Error("invalid_event_seq");
	return eventSeq;
}

function handoffPath(namespaceDir: string, workUnit: string): string {
	return path.join(namespaceDir, "codex-handoffs", `${assertWorkUnit(workUnit)}.json`);
}

function wakeEventPath(namespaceDir: string, workUnit: string, eventSeq: number): string {
	return path.join(namespaceDir, "codex-wake-events", `${assertWorkUnit(workUnit)}__${assertEventSeq(eventSeq)}.json`);
}

async function fsyncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const handle = await fs.open(temp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temp, file);
	await fsyncDirectory(path.dirname(file));
}

async function writeExclusive(file: string, value: unknown): Promise<boolean> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await fs.open(temp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.link(temp, file);
	} catch (error) {
		await fs.unlink(temp).catch(() => {});
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			await fsyncDirectory(path.dirname(file));
			return false;
		}
		throw error;
	}
	await fs.unlink(temp);
	await fsyncDirectory(path.dirname(file));
	return true;
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("state_corrupt");
	}
}

function isTokenFileReference(value: string): boolean {
	return value.length > 0 && value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value);
}

function boundSummary(value: string): string {
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
function isBoundString(value: unknown, maximum = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function assertCodexHandoffOrigin(value: unknown): asserts value is CodexHandoffOriginV1 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("state_corrupt");
	const origin = value as Record<string, unknown>;
	if (
		!(
			origin.gjc_session_id === null ||
			(typeof origin.gjc_session_id === "string" && SAFE_ID.test(origin.gjc_session_id))
		) ||
		!(origin.gjc_turn_id === null || (typeof origin.gjc_turn_id === "string" && SAFE_ID.test(origin.gjc_turn_id))) ||
		!(typeof origin.codex_thread_id === "string" && SAFE_ID.test(origin.codex_thread_id)) ||
		!(origin.codex_turn_id === null || isBoundString(origin.codex_turn_id)) ||
		!(
			origin.codex_host_session_id === null ||
			(typeof origin.codex_host_session_id === "string" && SAFE_ID.test(origin.codex_host_session_id))
		) ||
		!(typeof origin.delegation_id === "string" && SAFE_ID.test(origin.delegation_id)) ||
		!["plan", "execute", "team"].includes(origin.workflow as string) ||
		!(typeof origin.bound_at === "string" && Number.isFinite(Date.parse(origin.bound_at)))
	)
		throw new Error("state_corrupt");
}

function assertCodexHandoff(value: unknown, workUnit: string): asserts value is CodexHandoffRegistrationV1 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("state_corrupt");
	const registration = value as Record<string, unknown>;
	if (
		registration.schema_version !== 1 ||
		registration.work_unit !== workUnit ||
		typeof registration.thread_id !== "string" ||
		!SAFE_ID.test(registration.thread_id) ||
		(registration.token_file !== null &&
			(typeof registration.token_file !== "string" || !isTokenFileReference(registration.token_file))) ||
		typeof registration.registered_at !== "string" ||
		typeof registration.updated_at !== "string"
	)
		throw new Error("state_corrupt");
	if (Object.hasOwn(registration, "origin")) assertCodexHandoffOrigin(registration.origin);
	try {
		assertSafeCodexEndpoint(registration.endpoint);
	} catch {
		throw new Error("state_corrupt");
	}
}

function assertWakeEvent(value: CodexWakeEventV1): void {
	if (
		value === null ||
		typeof value !== "object" ||
		value.schema_version !== 1 ||
		!SAFE_ID.test(value.work_unit) ||
		value.key !== codexWakeKey(value.work_unit, value.event_seq) ||
		!Number.isInteger(value.event_seq) ||
		value.event_seq < 0 ||
		!isCodexWakeEventKind(value.event_kind) ||
		!["pending", "published", "acked", "failed"].includes(value.status) ||
		!Number.isInteger(value.attempts) ||
		value.attempts < 0 ||
		typeof value.summary !== "string" ||
		value.client_user_message_id !== codexClientUserMessageId(value.key) ||
		typeof value.created_at !== "string" ||
		typeof value.updated_at !== "string" ||
		!(value.turn_id === null || typeof value.turn_id === "string") ||
		!(value.question_id === null || typeof value.question_id === "string") ||
		!(value.last_error === null || typeof value.last_error === "string")
	)
		throw new Error("state_corrupt");
}

function eventPathForKey(namespaceDir: string, key: string): string {
	const match = /^(.*):(\d+)$/.exec(key);
	if (!match) throw new Error("resource_gone");
	try {
		return wakeEventPath(namespaceDir, match[1], Number(match[2]));
	} catch {
		throw new Error("resource_gone");
	}
}

export async function registerCodexHandoff(
	namespaceDir: string,
	input: {
		work_unit: string;
		thread_id: string;
		endpoint: CodexHandoffEndpoint;
		token_file?: string | null;
		origin?: unknown;
	},
): Promise<CodexHandoffRegistrationV1> {
	if (Object.hasOwn(input, "token")) throw new Error("token_material_not_allowed");
	const workUnit = assertWorkUnit(input.work_unit);
	const threadId = assertThreadId(input.thread_id);
	const tokenFile = input.token_file ?? null;
	if (tokenFile !== null && (typeof tokenFile !== "string" || !isTokenFileReference(tokenFile)))
		throw new Error("token_material_not_allowed");
	if (input.origin !== undefined) assertCodexHandoffOrigin(input.origin);
	const endpoint = assertSafeCodexEndpoint(input.endpoint);
	const file = handoffPath(namespaceDir, workUnit);
	const existing = await readCodexHandoff(namespaceDir, workUnit);
	const now = new Date().toISOString();
	const registration: CodexHandoffRegistrationV1 = {
		schema_version: 1,
		work_unit: workUnit,
		thread_id: threadId,
		endpoint,
		token_file: tokenFile,
		registered_at: existing?.registered_at ?? now,
		updated_at: now,
		...(input.origin === undefined ? {} : { origin: input.origin }),
	};
	await writeAtomic(file, registration);
	return registration;
}

export async function readCodexHandoff(
	namespaceDir: string,
	workUnit: string,
): Promise<CodexHandoffRegistrationV1 | null> {
	const registration = await readJson<unknown>(handoffPath(namespaceDir, workUnit));
	if (registration === null) return null;
	assertCodexHandoff(registration, workUnit);
	return registration;
}

export async function bindDelegateCodexHandoff(
	namespaceDir: string,
	input: {
		work_unit: string;
		source: CodexHandoffRegistrationV1;
		origin: unknown;
	},
): Promise<{ created: boolean; handoff: CodexHandoffRegistrationV1 }> {
	const workUnit = assertWorkUnit(input.work_unit);
	assertCodexHandoff(input.source, input.source.work_unit);
	assertCodexHandoffOrigin(input.origin);
	if ((input.origin as CodexHandoffOriginV1).codex_thread_id !== input.source.thread_id)
		throw new Error("state_corrupt");
	const file = handoffPath(namespaceDir, workUnit);
	const existing = await readCodexHandoff(namespaceDir, workUnit);
	if (existing) return { created: false, handoff: existing };
	const now = new Date().toISOString();
	const handoff: CodexHandoffRegistrationV1 = {
		schema_version: 1,
		work_unit: workUnit,
		thread_id: input.source.thread_id,
		endpoint: input.source.endpoint,
		token_file: input.source.token_file,
		registered_at: now,
		updated_at: now,
		origin: input.origin,
	};
	if (await writeExclusive(file, handoff)) return { created: true, handoff };
	const concurrent = await readCodexHandoff(namespaceDir, workUnit);
	if (!concurrent) throw new Error("state_corrupt");
	return { created: false, handoff: concurrent };
}

export async function listCodexHandoffs(namespaceDir: string): Promise<CodexHandoffRegistrationV1[]> {
	const directory = path.join(namespaceDir, "codex-handoffs");
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error("state_corrupt");
	}
	const handoffs: CodexHandoffRegistrationV1[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const workUnit = name.slice(0, -".json".length);
		try {
			assertWorkUnit(workUnit);
		} catch {
			throw new Error("state_corrupt");
		}
		const handoff = await readCodexHandoff(namespaceDir, workUnit);
		if (handoff) handoffs.push(handoff);
	}
	return handoffs.sort((left, right) => left.work_unit.localeCompare(right.work_unit));
}

export async function recordCodexWakeEvent(
	namespaceDir: string,
	input: {
		work_unit: string;
		event_seq: number;
		event_kind: CodexWakeEventKind;
		turn_id?: string | null;
		question_id?: string | null;
		summary: string;
	},
): Promise<{ created: boolean; event: CodexWakeEventV1 }> {
	const workUnit = assertWorkUnit(input.work_unit);
	const eventSeq = assertEventSeq(input.event_seq);
	if (!isCodexWakeEventKind(input.event_kind) || typeof input.summary !== "string")
		throw new Error("invalid_wake_event");
	const file = wakeEventPath(namespaceDir, workUnit, eventSeq);
	return await withFileLock(file, async () => {
		const existing = await readJson<CodexWakeEventV1>(file);
		if (existing !== null) {
			assertWakeEvent(existing);
			return { created: false, event: existing };
		}
		const now = new Date().toISOString();
		const key = codexWakeKey(workUnit, eventSeq);
		const event: CodexWakeEventV1 = {
			schema_version: 1,
			key,
			work_unit: workUnit,
			event_seq: eventSeq,
			event_kind: input.event_kind,
			turn_id: input.turn_id ?? null,
			question_id: input.question_id ?? null,
			summary: boundSummary(input.summary),
			status: "pending",
			attempts: 0,
			client_user_message_id: codexClientUserMessageId(key),
			created_at: now,
			updated_at: now,
			last_error: null,
		};
		if (!(await writeExclusive(file, event))) {
			const concurrent = await readJson<CodexWakeEventV1>(file);
			if (concurrent === null) throw new Error("state_corrupt");
			assertWakeEvent(concurrent);
			return { created: false, event: concurrent };
		}
		return { created: true, event };
	});
}

export async function updateCodexWakeEvent(
	namespaceDir: string,
	key: string,
	patch: { status?: CodexWakeEventV1["status"]; last_error?: string | null; attempts_delta?: number },
): Promise<CodexWakeEventV1> {
	const file = eventPathForKey(namespaceDir, key);
	if (patch.status !== undefined && !["pending", "published", "acked", "failed"].includes(patch.status))
		throw new Error("invalid_wake_event_status");
	if (patch.attempts_delta !== undefined && !Number.isInteger(patch.attempts_delta))
		throw new Error("invalid_attempts_delta");
	return await withFileLock(file, async () => {
		const event = await readJson<CodexWakeEventV1>(file);
		if (event === null) throw new Error("resource_gone");
		assertWakeEvent(event);
		if (event.status === "acked") return event;
		if (patch.status !== undefined && !(event.status === "published" && patch.status === "pending"))
			event.status = patch.status;
		if (patch.last_error !== undefined) event.last_error = patch.last_error;
		if (patch.attempts_delta !== undefined) event.attempts += patch.attempts_delta;
		event.updated_at = new Date().toISOString();
		await writeAtomic(file, event);
		return event;
	});
}

export async function ackCodexWakeEvent(namespaceDir: string, key: string): Promise<CodexWakeEventV1> {
	const file = eventPathForKey(namespaceDir, key);
	return await withFileLock(file, async () => {
		const event = await readJson<CodexWakeEventV1>(file);
		if (event === null) throw new Error("resource_gone");
		assertWakeEvent(event);
		if (event.status === "acked") return event;
		event.status = "acked";
		event.updated_at = new Date().toISOString();
		await writeAtomic(file, event);
		return event;
	});
}

export async function listCodexWakeEvents(namespaceDir: string, workUnit?: string): Promise<CodexWakeEventV1[]> {
	if (workUnit !== undefined) assertWorkUnit(workUnit);
	const directory = path.join(namespaceDir, "codex-wake-events");
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error("state_corrupt");
	}
	const events: CodexWakeEventV1[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const event = await readJson<CodexWakeEventV1>(path.join(directory, name));
		if (event === null) continue;
		assertWakeEvent(event);
		if (workUnit === undefined || event.work_unit === workUnit) events.push(event);
	}
	return events.sort((left, right) => left.event_seq - right.event_seq);
}

export async function listPendingCodexWakeEvents(namespaceDir: string, workUnit: string): Promise<CodexWakeEventV1[]> {
	return (await listCodexWakeEvents(namespaceDir, workUnit)).filter(
		event => event.status === "pending" || event.status === "failed",
	);
}

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEEP_INTERVIEW_DRAFT_KINDS,
	type DeepInterviewDraftKind,
	type DraftArrayDescriptor,
	type DraftDescriptor,
	type DraftLeafDescriptor,
	type DraftObjectDescriptor,
	deepInterviewDraftSchema,
	validateDraftPayload,
} from "./deep-interview-payload";
import { type DeepInterviewRepairResult, runDeepInterviewRepairCommand } from "./deep-interview-repair";
import { canonicalDeepInterviewJson, validateDeepInterviewV1Envelope } from "./deep-interview-state";
import { modeStatePath } from "./session-layout";
import {
	readExistingStateForMutation,
	transformGuardedWorkflowEnvelopeAtomic,
	verifyWorkflowEnvelopeReceiptValue,
} from "./state-writer";

const DRAFT_VERSION = 1;
const ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
const CONSUMED_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 50;
const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 256;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DRAFT_ID = /^[a-f0-9]{32}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

type Scalar = string | number | boolean | null;
interface Draft {
	version: 1;
	id: string;
	workspace: string;
	session_id: string;
	kind: DeepInterviewDraftKind;
	base_revision: number;
	draft_revision: number;
	created_at: string;
	updated_at: string;
	expires_at: string;
	status: "active" | "consumed";
	round_key?: string;
	identity: Record<string, string>;
	payload: Record<string, unknown>;
	receipt?: Record<string, unknown>;
	attempt?: { state_revision: number; request_digest: string; effect_digest: string };
}

export interface DeepInterviewDraftResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

function response(status: number, value: unknown): DeepInterviewDraftResult {
	return status === 0
		? { status, stdout: `${JSON.stringify(value)}\n` }
		: { status, stderr: `${JSON.stringify({ ok: false, issue: { code: value, message: value } })}\n` };
}
function code(error: unknown): string {
	return error instanceof Error ? error.message : "DI_DRAFT_INTERNAL_ERROR";
}
function inside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function safeDirectory(target: string, create: boolean): Promise<string> {
	if (!path.isAbsolute(target)) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
	let metadata: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		metadata = await fs.lstat(target);
	} catch {
		throw new Error("DI_DRAFT_UNSAFE_ROOT");
	}
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	const uid = process.getuid?.();
	if (uid !== undefined && metadata.uid !== uid) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	try {
		await fs.chmod(target, 0o700);
		metadata = await fs.lstat(target);
	} catch {
		throw new Error("DI_DRAFT_UNSAFE_ROOT");
	}
	if ((metadata.mode & 0o077) !== 0) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	try {
		return await fs.realpath(target);
	} catch {
		throw new Error("DI_DRAFT_UNSAFE_ROOT");
	}
}

async function root(cwd: string): Promise<string> {
	const configured = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
	const candidate = configured === undefined ? path.join(os.tmpdir(), "gjc-deep-interview-drafts") : configured;
	if (!path.isAbsolute(candidate)) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	const workspace = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	const workspaceGjc = path.join(workspace, ".gjc");
	const storage = await safeDirectory(path.resolve(candidate), true);
	if (inside(workspace, storage) || inside(workspaceGjc, storage)) throw new Error("DI_DRAFT_UNSAFE_ROOT");
	return storage;
}

function workspaceKey(cwd: string): string {
	return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
}

async function dir(cwd: string): Promise<string> {
	const storage = await root(cwd);
	const directory = path.join(storage, workspaceKey(cwd));
	const workspace = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	const workspaceGjc = path.join(workspace, ".gjc");
	const resolved = await safeDirectory(directory, true);
	if (inside(workspace, resolved) || inside(workspaceGjc, resolved) || !inside(storage, resolved))
		throw new Error("DI_DRAFT_UNSAFE_ROOT");
	return resolved;
}

async function file(cwd: string, id: string): Promise<string> {
	if (!DRAFT_ID.test(id)) throw new Error("DI_INVALID_DRAFT_ID");
	return path.join(await dir(cwd), `${id}.json`);
}

async function safeFile(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
	let metadata: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		metadata = await fs.lstat(target);
	} catch {
		throw new Error("DI_DRAFT_NOT_FOUND");
	}
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DRAFT_BYTES)
		throw new Error("DI_DRAFT_CORRUPT");
	const uid = process.getuid?.();
	if (uid !== undefined && metadata.uid !== uid) throw new Error("DI_DRAFT_CORRUPT");
	if ((metadata.mode & 0o077) !== 0) throw new Error("DI_DRAFT_CORRUPT");
	return metadata;
}
async function secureRead(target: string, limit: number, errorCode: string): Promise<string> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = await handle.stat();
		const uid = process.getuid?.();
		if (
			!metadata.isFile() ||
			metadata.size > limit ||
			(uid !== undefined && metadata.uid !== uid) ||
			(metadata.mode & 0o077) !== 0
		)
			throw new Error(errorCode);
		return await handle.readFile({ encoding: "utf8" });
	} catch (error) {
		if (error instanceof Error && error.message === errorCode) throw error;
		throw new Error(errorCode);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function withLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const directory = await dir(cwd);
	const lock = path.join(directory, ".lock");
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			const handle = await fs.open(lock, "wx", 0o600);
			const created = await handle.stat();
			try {
				return await fn();
			} finally {
				await handle.close();
				const current = await fs.lstat(lock).catch(() => undefined);
				if (
					current?.isFile() &&
					!current.isSymbolicLink() &&
					current.dev === created.dev &&
					current.ino === created.ino
				)
					await fs.unlink(lock).catch(() => undefined);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const current = await fs.lstat(lock).catch(() => undefined);
			if (!current?.isFile() || current.isSymbolicLink()) throw new Error("DI_DRAFT_UNSAFE_ROOT");
			if (Date.now() - current.mtimeMs > LOCK_STALE_MS) await fs.unlink(lock).catch(() => undefined);
			else await Bun.sleep(10);
		}
	}
	throw new Error("DI_DRAFT_LOCK_TIMEOUT");
}

async function cleanup(cwd: string): Promise<void> {
	const directory = await dir(cwd);
	const entries = await fs.readdir(directory, { withFileTypes: true });
	if (entries.length > MAX_SCAN_FILES) throw new Error("DI_DRAFT_STORAGE_QUOTA");
	let total = 0;
	const now = Date.now();
	for (const entry of entries) {
		if (entry.name === ".lock") continue;
		const target = path.join(directory, entry.name);
		const metadata = await fs.lstat(target);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("DI_DRAFT_STORAGE_QUOTA");
		total += metadata.size;
		if (total > MAX_SCAN_BYTES) throw new Error("DI_DRAFT_STORAGE_QUOTA");
		if (!entry.name.endsWith(".json")) continue;
		if (metadata.size > MAX_DRAFT_BYTES) throw new Error("DI_DRAFT_STORAGE_QUOTA");
		try {
			const value = JSON.parse(await secureRead(target, MAX_DRAFT_BYTES, "DI_DRAFT_STORAGE_QUOTA")) as Draft;
			const age = now - Date.parse(value.updated_at);
			if (age > (value.status === "consumed" ? CONSUMED_MS : ACTIVE_MS)) await fs.unlink(target);
		} catch {
			await fs.unlink(target).catch(() => undefined);
		}
	}
}

async function write(cwd: string, draft: Draft): Promise<void> {
	const target = await file(cwd, draft.id);
	const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", 0o600);
		await handle.writeFile(JSON.stringify(draft), "utf8");
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		await fs.rename(temporary, target);
		const metadata = await safeFile(target);
		if (metadata.size > MAX_DRAFT_BYTES) throw new Error("DI_DRAFT_STORAGE_QUOTA");
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.unlink(temporary).catch(() => undefined);
	}
}

async function read(cwd: string, id: string): Promise<Draft> {
	const target = await file(cwd, id);
	await safeFile(target);
	let value: unknown;
	try {
		value = JSON.parse(await secureRead(target, MAX_DRAFT_BYTES, "DI_DRAFT_NOT_FOUND"));
	} catch {
		throw new Error("DI_DRAFT_NOT_FOUND");
	}
	if (!value || typeof value !== "object") throw new Error("DI_DRAFT_CORRUPT");
	const draft = value as Draft;
	if (draft.version !== DRAFT_VERSION || draft.workspace !== path.resolve(cwd)) throw new Error("DI_DRAFT_NOT_FOUND");
	if (draft.status === "active" && Date.parse(draft.expires_at) <= Date.now()) throw new Error("DI_DRAFT_EXPIRED");
	return draft;
}
function args(input: readonly string[]): Map<string, string> {
	const flags = new Map<string, string>();
	for (let i = 1; i < input.length; i++) {
		const key = input[i];
		if (!key.startsWith("--") || key.includes("=") || flags.has(key)) throw new Error("DI_INVALID_ARGUMENT");
		if (key === "--null") {
			flags.set(key, "true");
			continue;
		}
		if (key === "--json") {
			// draftCommandArgs normalizes the native router's standalone --json to --json true.
			if (input[i + 1] === "true") i++;
			flags.set(key, "true");
			continue;
		}
		const value = input[++i];
		if (value === undefined || value.startsWith("--")) throw new Error("DI_INVALID_ARGUMENT");
		flags.set(key, value);
	}
	return flags;
}
function allow(flags: Map<string, string>, allowed: readonly string[]): void {
	for (const key of flags.keys()) if (!allowed.includes(key)) throw new Error("DI_INVALID_ARGUMENT");
}
function required(flags: Map<string, string>, name: string): string {
	const value = flags.get(name);
	if (!value) throw new Error("DI_INVALID_ARGUMENT");
	return value;
}
async function revision(cwd: string, session: string): Promise<{ revision: number; state: Record<string, unknown> }> {
	const stateFile = modeStatePath(cwd, session, "deep-interview");
	const observed = await readExistingStateForMutation(stateFile);
	if (observed.kind === "absent") throw new Error("DI_STATE_ABSENT");
	if (observed.kind === "corrupt") throw new Error("DI_STATE_CORRUPT");
	const receipt = verifyWorkflowEnvelopeReceiptValue(observed.value, stateFile);
	if (receipt === "receipt-malformed") throw new Error("DI_RECEIPT_MALFORMED");
	if (receipt === "receipt-missing") throw new Error("DI_RECEIPT_MISSING");
	if (receipt === "checksum-mismatch") throw new Error("DI_RECEIPT_CHECKSUM_MISMATCH");
	try {
		if (receipt === "native-valid") validateDeepInterviewV1Envelope(observed.value);
	} catch {
		throw new Error("DI_STATE_SCHEMA_INVALID");
	}
	if (
		observed.value.current_phase === "complete" ||
		observed.value.current_phase === "handoff" ||
		observed.value.active === false
	)
		throw new Error("DI_PHASE_NOT_REPAIRABLE");
	const stateRevision = observed.value.state_revision ?? 0;
	if (!Number.isSafeInteger(stateRevision) || (stateRevision as number) < 0)
		throw new Error("DI_STATE_SCHEMA_INVALID");
	const state = asRecord(observed.value.state);
	if (!Object.keys(state).length) throw new Error("DI_STATE_SCHEMA_INVALID");
	return { revision: stateRevision as number, state };
}
function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function pointer(pointer: string): string[] {
	if (!pointer.startsWith("/") || pointer.includes("//")) throw new Error("DI_DRAFT_INVALID_PATH");
	const parts = pointer
		.slice(1)
		.split("/")
		.map(part => {
			if (!part || /~(?:[^01]|$)/.test(part)) throw new Error("DI_DRAFT_INVALID_PATH");
			const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
			if (FORBIDDEN.has(decoded)) throw new Error("DI_DRAFT_INVALID_PATH");
			return decoded;
		});
	return parts;
}
function scaffold(descriptor: DraftDescriptor): Record<string, unknown> | unknown[] {
	if (descriptor.kind === "object") return {};
	if (descriptor.kind === "array") return [];
	throw new Error("DI_DRAFT_INVALID_PATH");
}
function child(object: DraftObjectDescriptor, key: string): DraftDescriptor {
	const descriptor = object.fields[key] ?? object.dynamicValue;
	if (!descriptor || (object.dynamicValue && !ID.test(key))) throw new Error("DI_DRAFT_INVALID_PATH");
	return descriptor;
}
function index(key: string, length: number): number {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("DI_DRAFT_INVALID_PATH");
	const value = Number(key);
	if (!Number.isSafeInteger(value) || value < 0 || value >= length) throw new Error("DI_DRAFT_INVALID_PATH");
	return value;
}
function locate(
	payload: Record<string, unknown>,
	kind: DeepInterviewDraftKind,
	parts: string[],
): { parent: Record<string, unknown> | unknown[]; key: string; descriptor: DraftDescriptor } {
	let current: Record<string, unknown> | unknown[] = payload;
	let schema: DraftObjectDescriptor | DraftArrayDescriptor = deepInterviewDraftSchema(kind);
	for (let position = 0; position < parts.length - 1; position++) {
		const key = parts[position]!;
		let descriptor: DraftDescriptor;
		if (schema.kind === "object") {
			descriptor = child(schema, key);
			if (descriptor.kind === "leaf") throw new Error("DI_DRAFT_INVALID_PATH");
			const record = current as Record<string, unknown>;
			if (record[key] === undefined) record[key] = scaffold(descriptor);
			if (
				!record[key] ||
				typeof record[key] !== "object" ||
				Array.isArray(record[key]) !== (descriptor.kind === "array")
			)
				throw new Error("DI_DRAFT_INVALID_PATH");
			current = record[key] as Record<string, unknown> | unknown[];
		} else {
			const array = current as unknown[];
			const itemIndex = index(key, array.length);
			descriptor = schema.item;
			if (
				descriptor.kind === "leaf" ||
				!array[itemIndex] ||
				typeof array[itemIndex] !== "object" ||
				Array.isArray(array[itemIndex])
			)
				throw new Error("DI_DRAFT_INVALID_PATH");
			current = array[itemIndex] as Record<string, unknown> | unknown[];
		}
		schema = descriptor as DraftObjectDescriptor | DraftArrayDescriptor;
	}
	const key = parts.at(-1)!;
	const descriptor = schema.kind === "object" ? child(schema, key) : schema.item;
	if (schema.kind === "array") index(key, (current as unknown[]).length);
	return { parent: current, key, descriptor };
}
function coerce(value: string, descriptor: DraftLeafDescriptor): Scalar {
	if (descriptor.maxBytes !== undefined && Buffer.byteLength(value) > descriptor.maxBytes)
		throw new Error("DI_DRAFT_INVALID_VALUE");
	switch (descriptor.type) {
		case "string":
		case "text":
			return value;
		case "id":
			if (!ID.test(value)) throw new Error("DI_DRAFT_INVALID_VALUE");
			return value;
		case "enum":
			if (!descriptor.values?.includes(value)) throw new Error("DI_DRAFT_INVALID_VALUE");
			return value;
		case "boolean":
			if (value !== "true" && value !== "false") throw new Error("DI_DRAFT_INVALID_VALUE");
			return value === "true";
		case "number": {
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) throw new Error("DI_DRAFT_INVALID_VALUE");
			return parsed;
		}
		case "safe-int": {
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > 10_000) throw new Error("DI_DRAFT_INVALID_VALUE");
			return parsed;
		}
		case "score": {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || !Number.isInteger(parsed * 10_000) || parsed < 0 || parsed > 1)
				throw new Error("DI_DRAFT_INVALID_VALUE");
			return parsed;
		}
	}
}
async function suppliedValue(flags: Map<string, string>, descriptor: DraftLeafDescriptor): Promise<Scalar> {
	const supplied = [flags.has("--value"), flags.has("--value-file"), flags.has("--null")].filter(Boolean).length;
	if (supplied !== 1) throw new Error("DI_INVALID_ARGUMENT");
	if (flags.has("--null")) {
		if (!descriptor.nullable) throw new Error("DI_DRAFT_INVALID_VALUE");
		return null;
	}
	if (flags.has("--value-file")) {
		if (descriptor.type !== "string" && descriptor.type !== "text") throw new Error("DI_DRAFT_INVALID_VALUE");
		const filename = required(flags, "--value-file");
		const metadata = await fs.lstat(filename).catch(() => {
			throw new Error("DI_DRAFT_INVALID_VALUE");
		});
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
			throw new Error("DI_DRAFT_INVALID_VALUE");
		return coerce(await secureRead(filename, 4096, "DI_DRAFT_INVALID_VALUE"), descriptor);
	}
	return coerce(required(flags, "--value"), descriptor);
}
async function editPayload(draft: Draft, flags: Map<string, string>): Promise<void> {
	const op = required(flags, "--op");
	const { parent, key, descriptor } = locate(draft.payload, draft.kind, pointer(required(flags, "--path")));
	const existing = Array.isArray(parent) ? parent[index(key, parent.length)] : parent[key];
	if (op === "remove") {
		if (flags.has("--value") || flags.has("--value-file") || flags.has("--null"))
			throw new Error("DI_INVALID_ARGUMENT");
		if (Array.isArray(parent)) parent.splice(index(key, parent.length), 1);
		else {
			if (!descriptor.optional) throw new Error("DI_DRAFT_INVALID_PATH");
			delete parent[key];
		}
		return;
	}
	if (op === "set") {
		if (descriptor.kind !== "leaf") throw new Error("DI_DRAFT_INVALID_PATH");
		const value = await suppliedValue(flags, descriptor);
		if (Array.isArray(parent)) parent[index(key, parent.length)] = value;
		else parent[key] = value;
		return;
	}
	if (op !== "append" || flags.has("--null")) throw new Error("DI_INVALID_ARGUMENT");
	if (descriptor.kind !== "array") throw new Error("DI_DRAFT_INVALID_PATH");
	const target = Array.isArray(parent) ? existing : parent[key];
	const output = target === undefined ? [] : target;
	if (!Array.isArray(output) || output.length >= descriptor.maxItems) throw new Error("DI_DRAFT_INVALID_PATH");
	if (descriptor.item.kind === "object") {
		if (flags.has("--value") || flags.has("--value-file")) throw new Error("DI_DRAFT_INVALID_ARGUMENT");
		output.push({});
	} else {
		if (!flags.has("--value") && !flags.has("--value-file") && target === undefined) {
			// A valueless append initializes a missing scalar array without admitting raw JSON.
			if (!Array.isArray(parent)) parent[key] = output;
			return;
		}
		output.push(await suppliedValue(flags, descriptor.item));
	}
	if (!Array.isArray(parent)) parent[key] = output;
}
function requestDigest(draft: Draft): string {
	return createHash("sha256")
		.update(
			canonicalDeepInterviewJson({
				kind: draft.kind,
				session_id: draft.session_id,
				round_key: draft.round_key ?? null,
				identity: draft.identity,
				payload: draft.payload,
			}),
		)
		.digest("hex");
}

function attemptMatchesDraft(draft: Draft): boolean {
	return draft.attempt?.request_digest === requestDigest(draft);
}
function semanticallyEqual(left: unknown, right: unknown): boolean {
	return left === undefined || right === undefined
		? left === right
		: canonicalDeepInterviewJson(left) === canonicalDeepInterviewJson(right);
}
function mutationEffectDigest(draft: Draft, state: Record<string, unknown>): string {
	const evidence =
		draft.kind === "initialize-context"
			? Object.fromEntries(
					Object.keys(draft.payload).map(key => [
						key,
						Object.hasOwn(state, key) ? { present: true, value: state[key] } : { present: false },
					]),
				)
			: draft.kind === "confirm-topology"
				? state.topology
				: draft.kind === "record-answer"
					? state.rounds
					: undefined;
	return createHash("sha256")
		.update(canonicalDeepInterviewJson(evidence ?? null))
		.digest("hex");
}

function committedDraftMutation(draft: Draft, state: Record<string, unknown>): boolean {
	if (draft.kind === "initialize-context")
		return Object.entries(draft.payload).every(([key, value]) => semanticallyEqual(state[key], value));
	if (draft.kind === "confirm-topology") {
		const topology = asRecord(state.topology);
		const { status: _status, confirmed_at: _confirmedAt, ...value } = topology;
		return (
			topology.status === "confirmed" &&
			canonicalDeepInterviewJson(value) === canonicalDeepInterviewJson(draft.payload)
		);
	}
	if (draft.kind === "record-answer") {
		return (Array.isArray(state.rounds) ? state.rounds : [])
			.map(asRecord)
			.some(
				round =>
					round.round === Number(draft.identity.round) &&
					round.question_id === draft.identity["question-id"] &&
					round.round_id === (draft.identity["round-id"] || undefined) &&
					round.component === (draft.identity["component-id"] || undefined) &&
					round.dimension === (draft.identity.dimension || undefined) &&
					round.question_text === draft.payload.question &&
					semanticallyEqual(round.selected_options, asRecord(draft.payload.answer).selected_options) &&
					round.custom_input === asRecord(draft.payload.answer).custom_input &&
					round.lifecycle === "answered",
			);
	}
	return false;
}

async function injectCompetingWrite(cwd: string, draft: Draft, revision: number): Promise<void> {
	if (process.env.GJC_DEEP_INTERVIEW_DRAFT_INJECT_COMPETING_WRITE !== "1") return;
	await transformGuardedWorkflowEnvelopeAtomic(modeStatePath(cwd, draft.session_id, "deep-interview"), {
		cwd,
		expectedRevision: revision,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview test competing write",
			sessionId: draft.session_id,
			nowIso: new Date().toISOString(),
		},
		transform(current) {
			const state = asRecord(current.state);
			return { kind: "write", value: { ...current, state: { ...state, injected_competing_write: true } } };
		},
	});
}

async function runDeepInterviewDraftCommandInternal(
	input: readonly string[],
	cwd: string,
	allowInternalConsume: boolean,
): Promise<DeepInterviewDraftResult> {
	try {
		const action = input[0];
		if (
			!action ||
			![
				...["create", "edit", "show", "check", "rebase", "discard"],
				...(allowInternalConsume ? ["consume-internal"] : []),
			].includes(action)
		)
			throw new Error("DI_UNKNOWN_COMMAND");
		const flags = args(input);
		const allowed: Record<string, readonly string[]> = {
			create: [
				"--for",
				"--kind",
				"--session-id",
				"--round-key",
				"--round",
				"--question-id",
				"--round-id",
				"--component-id",
				"--dimension",
			],
			edit: ["--draft-id", "--expected-draft-revision", "--op", "--path", "--value", "--value-file", "--null"],
			show: ["--draft-id"],
			check: ["--draft-id"],
			rebase: ["--draft-id", "--expected-draft-revision", "--to-state-revision"],
			discard: ["--draft-id", "--expected-draft-revision"],
			"consume-internal": ["--draft-id", "--expected-draft-revision", "--kind"],
		};
		allow(flags, [...allowed[action], "--json"]);
		if (action !== "consume-internal" && !flags.has("--json")) throw new Error("DI_INVALID_ARGUMENT");
		return await withLock(cwd, async () => {
			if (action === "create") await cleanup(cwd);
			if (action === "create") {
				const suppliedKinds = [flags.has("--for"), flags.has("--kind")].filter(Boolean).length;
				if (suppliedKinds !== 1) throw new Error("DI_INVALID_ARGUMENT");
				const kind = (flags.get("--for") ?? flags.get("--kind")) as DeepInterviewDraftKind;
				const session = required(flags, "--session-id");
				if (!DEEP_INTERVIEW_DRAFT_KINDS.includes(kind) || !ID.test(session)) throw new Error("DI_INVALID_ARGUMENT");
				const current = await revision(cwd, session);
				const now = new Date();
				const draft: Draft = {
					version: 1,
					id: randomBytes(16).toString("hex"),
					workspace: path.resolve(cwd),
					session_id: session,
					kind,
					base_revision: current.revision,
					draft_revision: 1,
					created_at: now.toISOString(),
					updated_at: now.toISOString(),
					expires_at: new Date(now.getTime() + ACTIVE_MS).toISOString(),
					status: "active",
					round_key: flags.get("--round-key"),
					identity: Object.fromEntries(
						["--round", "--question-id", "--round-id", "--component-id", "--dimension"].flatMap(key =>
							flags.has(key) ? [[key.slice(2), flags.get(key)!]] : [],
						),
					),
					payload: {},
				};
				if (kind === "record-answer" && (!draft.identity.round || !draft.identity["question-id"]))
					throw new Error("DI_INVALID_ARGUMENT");
				if (kind === "apply-round-result") {
					const shells = (Array.isArray(current.state.rounds) ? current.state.rounds : [])
						.map(asRecord)
						.filter(item => item.lifecycle === "answered");
					if (!draft.round_key && shells.length === 0) throw new Error("DI_PENDING_SHELL_NOT_FOUND");
					if (!draft.round_key && shells.length !== 1) throw new Error("DI_PENDING_SHELL_AMBIGUOUS");
					const shell = draft.round_key ? shells.find(item => item.round_key === draft.round_key) : shells[0];
					if (!shell) throw new Error("DI_PENDING_SHELL_NOT_FOUND");
					draft.round_key = String(shell.round_key);
					draft.identity = {
						round: String(shell.round),
						"question-id": String(shell.question_id),
						"round-id": String(shell.round_id ?? ""),
						"component-id": String(shell.component ?? ""),
						dimension: String(shell.dimension ?? ""),
					};
				}
				await write(cwd, draft);
				return response(0, { ok: true, draft });
			}
			const id = required(flags, "--draft-id");
			const draft = await read(cwd, id);
			await cleanup(cwd);
			if (action === "show") return response(0, { ok: true, draft });
			if (action === "discard") {
				if (Number(required(flags, "--expected-draft-revision")) !== draft.draft_revision)
					throw new Error("DI_DRAFT_REVISION_CONFLICT");
				await fs.unlink(await file(cwd, id));
				return response(0, { ok: true, draft_id: id, discarded: true });
			}
			if (action === "edit") {
				if (
					draft.status !== "active" ||
					Number(required(flags, "--expected-draft-revision")) !== draft.draft_revision
				)
					throw new Error("DI_DRAFT_REVISION_CONFLICT");
				await editPayload(draft, flags);
				draft.draft_revision++;
				draft.updated_at = new Date().toISOString();
				await write(cwd, draft);
				return response(0, { ok: true, draft });
			}
			if (action === "rebase") {
				if (
					draft.status !== "active" ||
					Number(required(flags, "--expected-draft-revision")) !== draft.draft_revision
				)
					throw new Error("DI_DRAFT_REVISION_CONFLICT");
				const current = await revision(cwd, draft.session_id);
				if (Number(required(flags, "--to-state-revision")) !== current.revision)
					throw new Error("DI_STATE_REVISION_CONFLICT");
				validateDraftPayload(draft.kind, draft.payload, current.state);
				draft.base_revision = current.revision;
				draft.attempt = undefined;
				draft.draft_revision++;
				draft.updated_at = new Date().toISOString();
				await write(cwd, draft);
				return response(0, { ok: true, draft });
			}
			if (action === "consume-internal") {
				if (flags.get("--kind") !== draft.kind) throw new Error("DI_INPUT_MODE_CONFLICT");
				if (Number(required(flags, "--expected-draft-revision")) !== draft.draft_revision)
					throw new Error("DI_DRAFT_REVISION_CONFLICT");
			}
			if (draft.status === "consumed")
				return response(0, { ok: true, draft_id: id, consumed: true, receipt: draft.receipt });
			const current = await revision(cwd, draft.session_id);
			let schemaIssue: string | undefined;
			try {
				validateDraftPayload(draft.kind, draft.payload, current.state);
			} catch (error) {
				schemaIssue = code(error);
			}
			if (action === "check")
				return response(0, {
					ok: true,
					draft_id: id,
					valid: schemaIssue === undefined,
					state_revision: current.revision,
					stale: draft.base_revision !== current.revision,
					issues: schemaIssue ? [{ code: schemaIssue, message: schemaIssue }] : [],
				});
			if (schemaIssue) throw new Error(schemaIssue);
			const legacy = [
				draft.kind,
				"--json",
				"--session-id",
				draft.session_id,
				"--schema-version",
				"1",
				"--expected-revision",
				String(draft.attempt ? current.revision : draft.base_revision),
			];
			if (draft.kind === "initialize-context" || draft.kind === "confirm-topology")
				legacy.push("--input-json", JSON.stringify(draft.payload));
			if (draft.kind === "record-answer")
				legacy.push(
					"--round",
					required(new Map(Object.entries(draft.identity)), "round"),
					"--question-id",
					required(new Map(Object.entries(draft.identity)), "question-id"),
					"--question-json",
					String(draft.payload.question),
					"--answer-json",
					JSON.stringify(draft.payload.answer),
				);
			if (draft.kind === "record-answer")
				for (const key of ["round-id", "component-id", "dimension"]) {
					const value = draft.identity[key];
					if (value) legacy.push(`--${key}`, value);
				}
			if (draft.kind === "apply-round-result") {
				const shell = (Array.isArray(current.state.rounds) ? current.state.rounds : [])
					.map(asRecord)
					.find(round => round.round_key === draft.round_key);
				if (!shell) throw new Error("DI_PENDING_SHELL_NOT_FOUND");
				legacy.push(
					"--round",
					String(shell.round),
					"--question-id",
					String(shell.question_id),
					"--result-json",
					JSON.stringify({
						...draft.payload,
						...(draft.payload.bookkeeping
							? {
									bookkeeping: {
										...asRecord(draft.payload.bookkeeping),
										resolution:
											asRecord(draft.payload.bookkeeping).resolution === "complete"
												? "direct"
												: asRecord(draft.payload.bookkeeping).resolution,
									},
								}
							: {}),
					}),
				);
				if (typeof shell.round_id === "string") legacy.push("--round-id", shell.round_id);
			}
			const replayingAttempt = draft.attempt !== undefined;
			if (!draft.attempt) {
				draft.attempt = {
					state_revision: current.revision,
					request_digest: requestDigest(draft),
					effect_digest: mutationEffectDigest(draft, current.state),
				};
				draft.updated_at = new Date().toISOString();
				await write(cwd, draft);
				await injectCompetingWrite(cwd, draft, current.revision);
			} else if (
				current.revision !== draft.attempt.state_revision + 1 ||
				!attemptMatchesDraft(draft) ||
				draft.attempt.effect_digest === mutationEffectDigest(draft, current.state) ||
				!committedDraftMutation(draft, current.state)
			) {
				throw new Error("DI_STATE_REVISION_CONFLICT");
			}
			const result: DeepInterviewRepairResult = await runDeepInterviewRepairCommand(legacy, cwd);
			if (result.status !== 0) {
				if (result.stderr?.includes("DI_REVISION_CONFLICT")) throw new Error("DI_STATE_REVISION_CONFLICT");
				return result;
			}
			draft.status = "consumed";
			draft.updated_at = new Date().toISOString();
			draft.receipt = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
			draft.attempt = undefined;
			if (process.env.GJC_DEEP_INTERVIEW_DRAFT_FAIL_RECEIPT_PERSISTENCE === "1" && !replayingAttempt)
				throw new Error("DI_DRAFT_RECEIPT_PERSIST_FAILED");
			await write(cwd, draft);
			return response(0, { ok: true, draft_id: id, consumed: true, receipt: draft.receipt });
		});
	} catch (error) {
		return response(code(error) === "DI_STATE_REVISION_CONFLICT" ? 3 : 2, code(error));
	}
}
export async function runDeepInterviewDraftCommand(
	input: readonly string[],
	cwd: string,
): Promise<DeepInterviewDraftResult> {
	return runDeepInterviewDraftCommandInternal(input, cwd, false);
}

export async function runDeepInterviewDraftInternalConsumeCommand(
	draftId: string,
	expectedDraftRevision: number,
	kind: DeepInterviewDraftKind,
	cwd: string,
): Promise<DeepInterviewDraftResult> {
	return runDeepInterviewDraftCommandInternal(
		[
			"consume-internal",
			"--draft-id",
			draftId,
			"--expected-draft-revision",
			String(expectedDraftRevision),
			"--kind",
			kind,
		],
		cwd,
		true,
	);
}

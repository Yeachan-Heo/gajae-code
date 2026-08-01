import { createHash, type Hash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	openRecoveryFsRoot,
	type RecoveryFsFile,
	type RecoveryFsIdentity,
	type RecoveryFsRoot,
} from "@gajae-code/natives";

export const CODEX_PROVIDER_ID = "openai-codex";
export const CODEX_CONVERTER_VERSION = 1;
export const CODEX_SANITIZER_VERSION = 1;
export const CODEX_MAPPING_VERSION = 3;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_QUARANTINE_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 100_000;
const MAX_SESSION_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_INDEX_LINE_BYTES = 64 * 1024;
const MAX_SESSION_TITLE_CHARACTERS = 200;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/iu;
const CODEX_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/u;
const SECRET_VALUE =
	/(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b)/giu;
const JWT_VALUE = /\b[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}\b/gu;
const SECRET_ASSIGNMENT =
	/(\b(?:password|passwd|secret|token|api[-_]?key|access[-_]?key)\b\s*[:=]\s*)(?:"[^"\r\n]{4,4096}"|'[^'\r\n]{4,4096}'|[^\s,;]{4,4096})/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{1,65536}?-----END [A-Z ]*PRIVATE KEY-----/gu;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const RESERVED_CONTROL = /<\|[^|\r\n]{1,128}\|>/gu;
const HOSTILE_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const C0_C1 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

interface CodexWorkspaceIdentity {
	dev: string;
	ino: string;
}

export interface CodexSessionSource {
	id: string;
	path: string;
	cwd: string;
	timestamp: string;
	title?: string;
	cliVersion?: string;
	modelProvider?: string;
	identity?: RecoveryFsIdentity;
	workspaceIdentity?: CodexWorkspaceIdentity;
	authority?: { root: RecoveryFsRoot; relativePath: string };
}

export type CodexMappedEvent =
	| { kind: "user"; timestamp: string; text: string }
	| { kind: "assistant"; timestamp: string; text: string }
	| { kind: "tool_call"; timestamp: string; callId: string; name: string; arguments: Record<string, unknown> }
	| { kind: "tool_result"; timestamp: string; callId: string; output: string };

export interface CodexQuarantineRecord {
	line: number;
	timestamp?: string;
	eventType: string;
	reason: string;
	payload: unknown;
}

export interface CodexConversion {
	source: CodexSessionSource;
	sourceSha256: string;
	sourceBytes: number;
	mapped: CodexMappedEvent[];
	quarantine: CodexQuarantineRecord[];
	quarantineTruncated: boolean;
	counts: { input: number; mapped: number; quarantined: number; dropped: number; redacted: number };
}

export class CodexImportError extends Error {
	constructor(
		readonly code:
			| "source_not_found"
			| "source_untrusted"
			| "source_changed"
			| "malformed_source"
			| "content_too_large",
		readonly phase: "discovery" | "source" | "source_line" | "source_event" | "quarantine",
		message: string,
		readonly limitBytes?: number,
		readonly observedBytes?: number,
	) {
		super(message);
		this.name = "CodexImportError";
	}
}
export type CodexMappedEventSink = (event: CodexMappedEvent) => void | Promise<void>;

export function sanitizeImportedString(value: string): { value: string; redacted: number } {
	let redacted = 0;
	const replace = (input: string, pattern: RegExp, token: string): string =>
		input.replace(pattern, () => {
			redacted++;
			return token;
		});
	let next = value;
	if (next.includes("\u001b")) next = replace(next, ANSI_ESCAPE, "[control-sequence]");
	if (next.search(HOSTILE_UNICODE) >= 0) next = replace(next, HOSTILE_UNICODE, "[unicode-control]");
	if (next.search(C0_C1) >= 0) next = replace(next, C0_C1, "[control-character]");
	if (next.includes("<|")) next = replace(next, RESERVED_CONTROL, "[provider-control]");
	if (/(?:Bearer\s|(?:sk[-_]|ghp_|github_pat_)|AKIA[A-Z0-9]{16})/iu.test(next))
		next = replace(next, SECRET_VALUE, "[redacted-secret]");
	if (next.includes(".")) next = replace(next, JWT_VALUE, "[redacted-secret]");
	if (/(?:password|passwd|secret|token|api[-_]?key|access[-_]?key)\s*[:=]/iu.test(next)) {
		next = next.replace(SECRET_ASSIGNMENT, (_match, prefix: string) => {
			redacted++;
			return `${prefix}[redacted-secret]`;
		});
	}
	if (next.includes("PRIVATE KEY-----")) next = replace(next, PRIVATE_KEY, "[redacted-private-key]");
	if (next.includes("://")) {
		next = next.replace(URL_CREDENTIAL, (_match, scheme: string) => {
			redacted++;
			return `${scheme}[redacted-credentials]@`;
		});
	}
	return { value: next, redacted };
}

export function sanitizeImportedValue(value: unknown, depth = 0): { value: unknown; redacted: number } {
	if (depth > 64) return { value: "[depth-limit]", redacted: 1 };
	if (typeof value === "string") return sanitizeImportedString(value);
	if (Array.isArray(value)) {
		let redacted = 0;
		const mapped = value.slice(0, 65_536).map(item => {
			const sanitized = sanitizeImportedValue(item, depth + 1);
			redacted += sanitized.redacted;
			return sanitized.value;
		});
		if (value.length > mapped.length) {
			mapped.push("[array-limit]");
			redacted++;
		}
		return { value: mapped, redacted };
	}
	if (value && typeof value === "object") {
		let redacted = 0;
		const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value).slice(0, 4096)) {
			const sanitizedKey = sanitizeImportedString(key);
			redacted += sanitizedKey.redacted;
			const safeKey = ["__proto__", "constructor", "prototype"].includes(sanitizedKey.value)
				? `[redacted-key-${Object.keys(out).length}]`
				: sanitizedKey.value;
			if (safeKey !== sanitizedKey.value) redacted++;
			if (SENSITIVE_KEY.test(key)) {
				out[safeKey] = "[redacted-field]";
				redacted++;
				continue;
			}
			const sanitized = sanitizeImportedValue(item, depth + 1);
			out[safeKey] = sanitized.value;
			redacted += sanitized.redacted;
		}
		return { value: out, redacted };
	}
	return { value, redacted: 0 };
}

function textContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(item => {
			if (!item || typeof item !== "object") return [];
			const record = item as Record<string, unknown>;
			return ["input_text", "output_text", "text"].includes(String(record.type)) && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}

function safeTimestamp(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
	return new Date(value).toISOString();
}

function mapResponseItem(
	payload: Record<string, unknown>,
	timestamp: string,
): CodexMappedEvent | { quarantine: string } | { drop: true } {
	const type = String(payload.type ?? "unknown");
	if (type === "message") {
		const role = String(payload.role ?? "");
		if (role !== "user" && role !== "assistant") return { quarantine: `prohibited_role:${role || "missing"}` };
		const text = textContent(payload.content);
		if (!text) return { drop: true };
		return { kind: role, timestamp, text };
	}
	if (type === "function_call" || type === "custom_tool_call") {
		const callId = String(payload.call_id ?? payload.id ?? "");
		const name = String(payload.name ?? "codex_tool");
		if (!callId) return { quarantine: "missing_tool_call_id" };
		const raw = type === "function_call" ? payload.arguments : payload.input;
		let args: unknown = raw;
		if (typeof raw === "string") {
			try {
				args = JSON.parse(raw);
			} catch {
				args = { raw };
			}
		}
		return {
			kind: "tool_call",
			timestamp,
			callId,
			name,
			arguments:
				args && typeof args === "object" && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: { value: args },
		};
	}
	if (type === "function_call_output" || type === "custom_tool_call_output") {
		const callId = String(payload.call_id ?? "");
		if (!callId) return { quarantine: "missing_tool_result_id" };
		const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? null);
		return { kind: "tool_result", timestamp, callId, output };
	}
	if (["reasoning", "computer_tool_call", "web_search_call"].includes(type))
		return { quarantine: `unsupported:${type}` };
	return { quarantine: `unknown:${type}` };
}

function parseSessionMeta(file: string, buffer: Buffer): CodexSessionSource | null {
	const newline = buffer.indexOf(0x0a);
	if (newline < 0) return null;
	const first = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
	if (first.type !== "session_meta" || !first.payload || typeof first.payload !== "object") return null;
	const payload = first.payload as Record<string, unknown>;
	const id = String(payload.id ?? payload.session_id ?? "");
	const cwd = String(payload.cwd ?? "");
	if (!CODEX_SESSION_ID.test(id) || !cwd) return null;
	return {
		id,
		path: file,
		cwd,
		timestamp: safeTimestamp(payload.timestamp, safeTimestamp(first.timestamp, new Date(0).toISOString())),
		cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
		modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
	};
}

function sameSourceIdentity(left: RecoveryFsIdentity, right: RecoveryFsIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === "1" &&
		right.nlink === "1" &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sameRetainedIdentity(left: RecoveryFsIdentity, right: RecoveryFsIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function boundedSessionTitle(value: string): string | undefined {
	const sanitized = sanitizeImportedString(value).value.trim();
	if (!sanitized) return undefined;
	return Array.from(sanitized).slice(0, MAX_SESSION_TITLE_CHARACTERS).join("");
}

function inferredSessionTitle(text: string): string | undefined {
	const trimmed = text.trim();
	if (
		!trimmed ||
		trimmed.startsWith("# AGENTS.md instructions") ||
		trimmed.startsWith("<environment_context>") ||
		trimmed.startsWith("<INSTRUCTIONS>")
	)
		return undefined;
	const firstLine = trimmed
		.split(/\r?\n/u)
		.map(line => line.trim())
		.find(Boolean)
		?.replace(/^#{1,6}\s+/u, "");
	return firstLine ? boundedSessionTitle(firstLine) : undefined;
}

function readCodexSessionTitles(codexHome: string): Map<string, string> {
	let root: RecoveryFsRoot | undefined;
	let file: RecoveryFsFile | undefined;
	try {
		root = openRecoveryFsRoot(codexHome);
		file = root.openFile("session_index.jsonl");
		const initial = file.identity();
		if (!initial.ok || !initial.identity || initial.identity.nlink !== "1") return new Map();
		if (BigInt(initial.identity.size) > BigInt(MAX_SESSION_INDEX_BYTES)) return new Map();
		const chunks: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const chunk = file.readChunk(offset, 1024 * 1024);
			if (!chunk.ok || !chunk.data || !chunk.identity || !sameSourceIdentity(initial.identity, chunk.identity))
				return new Map();
			if (chunk.data.byteLength === 0) break;
			offset += chunk.data.byteLength;
			if (offset > MAX_SESSION_INDEX_BYTES) return new Map();
			chunks.push(Buffer.from(chunk.data));
		}
		const terminal = file.identity();
		if (!terminal.ok || !terminal.identity || !sameSourceIdentity(initial.identity, terminal.identity))
			return new Map();
		const titles = new Map<string, string>();
		for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
			if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_SESSION_INDEX_LINE_BYTES) continue;
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (!row || typeof row !== "object" || Array.isArray(row)) continue;
			const record = row as Record<string, unknown>;
			if (
				typeof record.id !== "string" ||
				!CODEX_SESSION_ID.test(record.id) ||
				typeof record.thread_name !== "string"
			)
				continue;
			const title = boundedSessionTitle(record.thread_name);
			if (title) titles.set(record.id, title);
		}
		return titles;
	} catch {
		return new Map();
	} finally {
		file?.close();
		if (root) closeRetainedRoot(root);
	}
}

async function workspaceIdentity(directory: string): Promise<CodexWorkspaceIdentity | null> {
	const stat = await fs.lstat(directory, { bigint: true }).catch(() => null);
	if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
	return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameWorkspaceIdentity(
	left: CodexWorkspaceIdentity | undefined,
	right: CodexWorkspaceIdentity | null,
): boolean {
	return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

export async function assertCodexWorkspaceIdentity(source: CodexSessionSource): Promise<void> {
	const current = await workspaceIdentity(source.cwd);
	if (!sameWorkspaceIdentity(source.workspaceIdentity, current))
		throw new CodexImportError(
			"source_untrusted",
			"discovery",
			"The workspace changed after Codex session discovery.",
		);
}

async function readSessionMeta(
	file: string,
): Promise<{ meta: CodexSessionSource; identity: RecoveryFsIdentity } | null> {
	const handle = await fs.open(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
	try {
		const initial = await handle.stat({ bigint: true });
		if (!initial.isFile() || initial.nlink !== 1n) return null;
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const meta = parseSessionMeta(file, buffer.subarray(0, bytesRead));
		if (!meta) return null;
		const terminal = await handle.stat({ bigint: true });
		const named = await fs.lstat(file, { bigint: true });
		const identity = {
			dev: initial.dev.toString(),
			ino: initial.ino.toString(),
			nlink: initial.nlink.toString(),
			size: initial.size.toString(),
			mtimeNs: initial.mtimeNs.toString(),
			ctimeNs: initial.ctimeNs.toString(),
		};
		const terminalIdentity = {
			dev: terminal.dev.toString(),
			ino: terminal.ino.toString(),
			nlink: terminal.nlink.toString(),
			size: terminal.size.toString(),
			mtimeNs: terminal.mtimeNs.toString(),
			ctimeNs: terminal.ctimeNs.toString(),
		};
		const namedIdentity = {
			dev: named.dev.toString(),
			ino: named.ino.toString(),
			nlink: named.nlink.toString(),
			size: named.size.toString(),
			mtimeNs: named.mtimeNs.toString(),
			ctimeNs: named.ctimeNs.toString(),
		};
		if (
			named.isSymbolicLink() ||
			!sameSourceIdentity(identity, terminalIdentity) ||
			!sameSourceIdentity(identity, namedIdentity)
		)
			return null;
		return { meta, identity };
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

function readRetainedSessionMeta(
	root: RecoveryFsRoot,
	relativePath: string,
	displayPath: string,
): { meta: CodexSessionSource; identity: RecoveryFsIdentity } | null {
	let file: RecoveryFsFile;
	try {
		file = root.openFile(relativePath);
	} catch {
		return null;
	}
	try {
		const initial = file.identity();
		const chunk = file.readChunk(0, 64 * 1024);
		const terminal = file.identity();
		if (
			!initial.ok ||
			!initial.identity ||
			!chunk.ok ||
			!chunk.data ||
			!chunk.identity ||
			!terminal.ok ||
			!terminal.identity ||
			!sameSourceIdentity(initial.identity, chunk.identity) ||
			!sameSourceIdentity(initial.identity, terminal.identity)
		)
			return null;
		const meta = parseSessionMeta(displayPath, Buffer.from(chunk.data));
		return meta ? { meta, identity: initial.identity } : null;
	} finally {
		file.close();
	}
}

function sameWorkspace(left: string, right: string): boolean {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function closeRetainedRoot(root: RecoveryFsRoot): void {
	const closed = root.close();
	if (!closed.ok && closed.code !== "closed") throw new Error(closed.code ?? "source_authority_close_failed");
}

export async function discoverCodexSessions(
	cwd: string,
	requestedIds: readonly string[],
	codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
	retainSourceAuthority = false,
): Promise<CodexSessionSource[]> {
	const sessionsRoot = path.join(codexHome, "sessions");
	let rootAuthority: RecoveryFsRoot | undefined;
	let retainedRootIdentity: RecoveryFsIdentity | undefined;
	if (retainSourceAuthority) {
		if (process.platform !== "linux")
			throw new CodexImportError(
				"source_untrusted",
				"discovery",
				"Descriptor-relative Codex source authority is unavailable on this platform.",
			);
		try {
			rootAuthority = openRecoveryFsRoot(sessionsRoot);
		} catch {
			throw new CodexImportError("source_not_found", "discovery", "Codex sessions directory was not found.");
		}
		const retained = rootAuthority.identity();
		if (!retained.ok || !retained.identity) {
			closeRetainedRoot(rootAuthority);
			throw new CodexImportError("source_untrusted", "discovery", "Codex sessions directory is not trusted.");
		}
		retainedRootIdentity = retained.identity;
	}
	try {
		const rootStat = await fs.lstat(sessionsRoot, { bigint: true }).catch(() => null);
		if (!rootStat?.isDirectory() || rootStat.isSymbolicLink())
			throw new CodexImportError("source_not_found", "discovery", "Codex sessions directory was not found.");
		const canonicalSessionsRoot = await fs.realpath(sessionsRoot);
		const canonicalWorkspace = await fs.realpath(cwd).catch(() => null);
		if (!canonicalWorkspace)
			throw new CodexImportError("source_not_found", "discovery", "The current workspace was not found.");
		const discoveredWorkspaceIdentity = await workspaceIdentity(canonicalWorkspace);
		if (!discoveredWorkspaceIdentity)
			throw new CodexImportError("source_untrusted", "discovery", "The current workspace identity is unavailable.");
		const sanitizedWorkspace = sanitizeImportedString(canonicalWorkspace);
		if (sanitizedWorkspace.value !== canonicalWorkspace)
			throw new CodexImportError(
				"source_untrusted",
				"discovery",
				"The canonical workspace path contains secret-shaped or control content.",
			);
		const sessionTitles = readCodexSessionTitles(codexHome);
		const requested = new Set(requestedIds);
		const found = new Map<string, CodexSessionSource>();
		let relativePaths: string[];
		if (rootAuthority) {
			const listed = rootAuthority.listFiles(MAX_DISCOVERY_ENTRIES);
			if (
				!listed.ok ||
				!listed.data ||
				!listed.identity ||
				!retainedRootIdentity ||
				!sameRetainedIdentity(retainedRootIdentity, listed.identity)
			)
				throw new CodexImportError(
					"source_untrusted",
					"discovery",
					"Codex session discovery changed while it was being enumerated.",
				);
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.from(listed.data).toString("utf8"));
			} catch {
				throw new CodexImportError("source_untrusted", "discovery", "Codex session discovery was malformed.");
			}
			if (
				!Array.isArray(parsed) ||
				parsed.some(relative => typeof relative !== "string" || path.isAbsolute(relative))
			)
				throw new CodexImportError("source_untrusted", "discovery", "Codex session discovery was malformed.");
			relativePaths = parsed.filter(relative => relative.endsWith(".jsonl")).sort();
		} else {
			const glob = new Bun.Glob("**/*.jsonl");
			relativePaths = [];
			for await (const relative of glob.scan({ cwd: sessionsRoot, onlyFiles: true, dot: false }))
				relativePaths.push(relative);
			relativePaths.sort();
		}
		for (const relative of relativePaths) {
			const displayPath = path.resolve(sessionsRoot, relative);
			if (!displayPath.startsWith(`${path.resolve(sessionsRoot)}${path.sep}`)) continue;
			const read = rootAuthority
				? readRetainedSessionMeta(rootAuthority, relative, displayPath)
				: await readSessionMeta(displayPath);
			if (!read) continue;
			const { meta, identity } = read;
			if (!rootAuthority) {
				const canonicalFile = await fs.realpath(displayPath).catch(() => null);
				const expectedCanonicalFile = path.resolve(canonicalSessionsRoot, relative);
				if (!canonicalFile || !sameWorkspace(canonicalFile, expectedCanonicalFile)) continue;
			}
			meta.identity = identity;
			const canonicalMetadataWorkspace = await fs.realpath(meta.cwd).catch(() => null);
			if (!canonicalMetadataWorkspace || !sameWorkspace(canonicalMetadataWorkspace, canonicalWorkspace)) continue;
			meta.cwd = canonicalMetadataWorkspace;
			meta.title = sessionTitles.get(meta.id);
			meta.workspaceIdentity = discoveredWorkspaceIdentity;
			if (rootAuthority) meta.authority = { root: rootAuthority, relativePath: relative };
			if (requested.size > 0 && !requested.has(meta.id)) continue;
			if (found.has(meta.id))
				throw new CodexImportError(
					"malformed_source",
					"discovery",
					`Multiple Codex session files declare the same session ID: ${meta.id}`,
				);
			found.set(meta.id, meta);
		}
		if (requested.size > 0) {
			const missing = [...requested].filter(id => !found.has(id));
			if (missing.length > 0)
				throw new CodexImportError(
					"source_not_found",
					"discovery",
					`Codex session not found in this workspace: ${missing.join(", ")}`,
				);
		}
		const sources = [...found.values()].sort(
			(a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
		);
		if (sources.length === 0 && rootAuthority) {
			closeRetainedRoot(rootAuthority);
			rootAuthority = undefined;
		}
		return sources;
	} catch (error) {
		if (rootAuthority) closeRetainedRoot(rootAuthority);
		throw error;
	}
}

export async function closeCodexSessionAuthorities(sources: readonly CodexSessionSource[]): Promise<void> {
	const roots = new Set(sources.flatMap(source => (source.authority ? [source.authority.root] : [])));
	for (const root of roots) closeRetainedRoot(root);
}

async function closeCodexSourceHandle(handle: fs.FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
	}
}
async function* retainedCodexChunks(file: RecoveryFsFile, expected: RecoveryFsIdentity): AsyncGenerator<Uint8Array> {
	let offset = 0;
	for (;;) {
		const chunk = file.readChunk(offset, 1024 * 1024);
		if (!chunk.ok || !chunk.data || !chunk.identity || !sameSourceIdentity(expected, chunk.identity))
			throw new CodexImportError("source_changed", "source", "Retained Codex source read failed.");
		if (chunk.data.byteLength === 0) return;
		offset += chunk.data.byteLength;
		yield chunk.data;
	}
}

async function* boundedCodexLines(stream: AsyncIterable<Uint8Array>, hash: Hash): AsyncGenerator<Buffer> {
	let pending = Buffer.alloc(0);
	for await (const rawChunk of stream) {
		const chunk = Buffer.from(rawChunk);
		hash.update(chunk);
		pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk], pending.length + chunk.length);
		for (;;) {
			const newline = pending.indexOf(0x0a);
			if (newline < 0) break;
			if (newline > MAX_LINE_BYTES)
				throw new CodexImportError(
					"content_too_large",
					"source_line",
					"Codex session contains an oversized JSONL record.",
					MAX_LINE_BYTES,
					newline,
				);
			const line = Buffer.from(pending.subarray(0, newline));
			pending = Buffer.from(pending.subarray(newline + 1));
			yield line;
		}
		if (pending.length > MAX_LINE_BYTES)
			throw new CodexImportError(
				"content_too_large",
				"source_line",
				"Codex session contains an oversized JSONL record.",
				MAX_LINE_BYTES,
				pending.length,
			);
	}
	if (pending.length > 0) yield pending;
}

export async function convertCodexSession(
	source: CodexSessionSource,
	mappedEventSink?: CodexMappedEventSink,
): Promise<CodexConversion> {
	if (!source.identity)
		throw new CodexImportError("source_untrusted", "source", "Codex session source identity is unavailable.");
	let retainedFile: RecoveryFsFile | undefined;
	let handle: fs.FileHandle | undefined;
	let nodeStream: nodeFs.ReadStream | undefined;
	let nodeInitial: nodeFs.BigIntStats | undefined;
	let initialIdentity: RecoveryFsIdentity;
	let stream: AsyncIterable<Uint8Array>;
	await assertCodexWorkspaceIdentity(source);
	if (source.authority) {
		try {
			retainedFile = source.authority.root.openFile(source.authority.relativePath);
		} catch {
			throw new CodexImportError("source_untrusted", "source", "Retained Codex source authority is unavailable.");
		}
		const retainedIdentity = retainedFile.identity();
		if (
			!retainedIdentity.ok ||
			!retainedIdentity.identity ||
			!sameSourceIdentity(source.identity, retainedIdentity.identity)
		) {
			retainedFile.close();
			throw new CodexImportError("source_untrusted", "source", "Codex session source identity changed.");
		}
		initialIdentity = retainedIdentity.identity;
		stream = retainedCodexChunks(retainedFile, initialIdentity);
	} else {
		handle = await fs.open(source.path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		nodeInitial = await handle.stat({ bigint: true });
		const namedInitial = await fs.lstat(source.path, { bigint: true });
		initialIdentity = {
			dev: nodeInitial.dev.toString(),
			ino: nodeInitial.ino.toString(),
			nlink: nodeInitial.nlink.toString(),
			size: nodeInitial.size.toString(),
			mtimeNs: nodeInitial.mtimeNs.toString(),
			ctimeNs: nodeInitial.ctimeNs.toString(),
		};
		const namedIdentity = {
			dev: namedInitial.dev.toString(),
			ino: namedInitial.ino.toString(),
			nlink: namedInitial.nlink.toString(),
			size: namedInitial.size.toString(),
			mtimeNs: namedInitial.mtimeNs.toString(),
			ctimeNs: namedInitial.ctimeNs.toString(),
		};
		if (
			!nodeInitial.isFile() ||
			namedInitial.isSymbolicLink() ||
			!sameSourceIdentity(initialIdentity, namedIdentity) ||
			!sameSourceIdentity(initialIdentity, source.identity)
		) {
			await handle.close();
			throw new CodexImportError(
				"source_untrusted",
				"source",
				"Codex session source is not a trusted regular file.",
			);
		}
		nodeStream = handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
		stream = nodeStream;
	}
	const sourceBytes = Number(initialIdentity.size);
	if (BigInt(initialIdentity.size) > BigInt(MAX_SOURCE_BYTES)) {
		if (retainedFile) retainedFile.close();
		if (handle) await handle.close();
		throw new CodexImportError(
			"content_too_large",
			"source",
			"Codex session exceeds the import source limit.",
			MAX_SOURCE_BYTES,
			sourceBytes,
		);
	}
	const hash = createHash("sha256");
	const mapped: CodexMappedEvent[] = [];
	const quarantine: CodexQuarantineRecord[] = [];
	const counts = { input: 0, mapped: 0, quarantined: 0, dropped: 0, redacted: 0 };
	let quarantineBytes = 0;
	let quarantineTruncated = false;
	let lineNumber = 0;
	const seenToolCallIds = new Set<string>();
	const pendingToolCallIds = new Set<string>();
	let metadataValidated = false;
	try {
		for await (const lineBytes of boundedCodexLines(stream, hash)) {
			lineNumber++;
			let line: string;
			try {
				line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
			} catch {
				throw new CodexImportError(
					"malformed_source",
					"source_event",
					`Codex session contains invalid UTF-8 at line ${lineNumber}.`,
				);
			}
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				throw new CodexImportError(
					"malformed_source",
					"source_event",
					`Codex session contains malformed JSON at line ${lineNumber}.`,
				);
			}
			if (!record || typeof record !== "object" || Array.isArray(record))
				throw new CodexImportError(
					"malformed_source",
					"source_event",
					`Codex session contains a non-object JSON value at line ${lineNumber}.`,
				);
			if (record.type === "session_meta") {
				const payload =
					record.payload && typeof record.payload === "object"
						? (record.payload as Record<string, unknown>)
						: undefined;
				const id = String(payload?.id ?? payload?.session_id ?? "");
				const cwd = String(payload?.cwd ?? "");
				const canonicalCwd = await fs.realpath(cwd).catch(() => null);
				if (lineNumber !== 1 || id !== source.id || !canonicalCwd || !sameWorkspace(canonicalCwd, source.cwd))
					throw new CodexImportError(
						"source_changed",
						"source_event",
						"Codex session identity changed between discovery and import.",
					);
				metadataValidated = true;
				continue;
			}
			counts.input++;
			const timestamp = safeTimestamp(record.timestamp, source.timestamp);
			if (record.type !== "response_item" || !record.payload || typeof record.payload !== "object") {
				if (record.type === "event_msg" || record.type === "turn_context" || record.type === "world_state") {
					counts.dropped++;
					continue;
				}
				const sanitized = sanitizeImportedValue(record);
				const eventType = sanitizeImportedString(String(record.type ?? "unknown"));
				counts.redacted += sanitized.redacted + eventType.redacted;
				const item: CodexQuarantineRecord = {
					line: lineNumber,
					timestamp,
					eventType: eventType.value,
					reason: "unsupported_envelope",
					payload: sanitized.value,
				};
				const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
				if (quarantineBytes + itemBytes <= MAX_QUARANTINE_BYTES) {
					quarantine.push(item);
					quarantineBytes += itemBytes;
				} else quarantineTruncated = true;
				counts.quarantined++;
				continue;
			}
			const payload = record.payload as Record<string, unknown>;
			let result = mapResponseItem(payload, timestamp);
			if ("kind" in result && result.kind === "tool_call") {
				if (seenToolCallIds.has(result.callId)) result = { quarantine: "duplicate_tool_call_id" };
				else {
					seenToolCallIds.add(result.callId);
					pendingToolCallIds.add(result.callId);
				}
			} else if ("kind" in result && result.kind === "tool_result" && !pendingToolCallIds.delete(result.callId)) {
				result = { quarantine: "orphan_tool_result" };
			}
			if ("drop" in result) {
				counts.dropped++;
				continue;
			}
			if ("quarantine" in result) {
				const sanitized = sanitizeImportedValue(payload);
				const eventType = sanitizeImportedString(String(payload.type ?? "unknown"));
				const reason = sanitizeImportedString(result.quarantine);
				counts.redacted += sanitized.redacted + eventType.redacted + reason.redacted;
				const item: CodexQuarantineRecord = {
					line: lineNumber,
					timestamp,
					eventType: eventType.value,
					reason: reason.value,
					payload: sanitized.value,
				};
				const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
				if (quarantineBytes + itemBytes <= MAX_QUARANTINE_BYTES) {
					quarantine.push(item);
					quarantineBytes += itemBytes;
				} else quarantineTruncated = true;
				counts.quarantined++;
				continue;
			}
			if (result.kind === "user" && !source.title) source.title = inferredSessionTitle(result.text);
			const sanitized = sanitizeImportedValue(result);
			counts.redacted += sanitized.redacted;
			if (mappedEventSink) await mappedEventSink(sanitized.value as CodexMappedEvent);
			else mapped.push(sanitized.value as CodexMappedEvent);
			counts.mapped++;
		}
		if (!metadataValidated)
			throw new CodexImportError("malformed_source", "source_event", "Codex session metadata is missing.");
		if (retainedFile) {
			const terminal = retainedFile.identity();
			if (!terminal.ok || !terminal.identity || !sameSourceIdentity(initialIdentity, terminal.identity))
				throw new CodexImportError(
					"source_changed",
					"source",
					"Codex session changed while it was being imported.",
				);
		} else {
			if (!handle || !nodeInitial) throw new CodexImportError("source_untrusted", "source", "Codex source closed.");
			const terminal = await handle.stat({ bigint: true });
			const namedTerminal = await fs.lstat(source.path, { bigint: true });
			const terminalIdentity = {
				dev: terminal.dev.toString(),
				ino: terminal.ino.toString(),
				nlink: terminal.nlink.toString(),
				size: terminal.size.toString(),
				mtimeNs: terminal.mtimeNs.toString(),
				ctimeNs: terminal.ctimeNs.toString(),
			};
			const namedIdentity = {
				dev: namedTerminal.dev.toString(),
				ino: namedTerminal.ino.toString(),
				nlink: namedTerminal.nlink.toString(),
				size: namedTerminal.size.toString(),
				mtimeNs: namedTerminal.mtimeNs.toString(),
				ctimeNs: namedTerminal.ctimeNs.toString(),
			};
			if (
				namedTerminal.isSymbolicLink() ||
				!sameSourceIdentity(initialIdentity, terminalIdentity) ||
				!sameSourceIdentity(initialIdentity, namedIdentity)
			)
				throw new CodexImportError(
					"source_changed",
					"source",
					"Codex session changed while it was being imported.",
				);
		}
		return {
			source,
			sourceSha256: hash.digest("hex"),
			sourceBytes,
			mapped,
			quarantine,
			quarantineTruncated,
			counts,
		};
	} finally {
		nodeStream?.destroy();
		if (retainedFile) retainedFile.close();
		if (handle) await closeCodexSourceHandle(handle);
	}
}

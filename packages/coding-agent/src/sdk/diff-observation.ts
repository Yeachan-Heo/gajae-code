import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { redactCrashSecrets } from "@gajae-code/utils";
import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";
import type { AgentSession } from "../session/agent-session";
import { collectSdkStoredSecrets } from "./credential-secrets";

export const SDK_DIFF_LIMITS = {
	files: 100,
	fileBytes: 32_000,
	responseBytes: 1_048_576,
	commandBytes: 4_194_304,
	readBytes: 16_777_216,
	timeMs: 10_000,
} as const;

export type SdkDiffObservationErrorCode =
	| "invalid_input"
	| "busy"
	| "disposed"
	| "stale_session"
	| "session_transitioning"
	| "stale_ref"
	| "not_git_repository"
	| "diff_too_large"
	| "git_failure";
const messages: Record<SdkDiffObservationErrorCode, string> = {
	invalid_input: "Invalid diff observation parameters.",
	busy: "A diff query is already in progress for this session.",
	disposed: "The diff observation service or session has been disposed.",
	stale_session: "The diff observation belongs to an earlier session identity or working directory.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	stale_ref: "The diff file reference is no longer available.",
	not_git_repository: "Diff queries require a Git working tree.",
	diff_too_large: "The diff exceeds its read or time budget.",
	git_failure: "The Git diff could not be read.",
};
export class SdkDiffObservationError extends Error {
	constructor(readonly code: SdkDiffObservationErrorCode) {
		super(messages[code]);
		this.name = "SdkDiffObservationError";
	}
}

export interface SdkWorkingTreeDiffRow {
	id: string;
	path: string;
	body: string;
	/** Git porcelain v1 XY status, including ?? for untracked files. */
	status: string;
	truncated: boolean;
	withheld: boolean;
}
export interface SdkWorkingTreeDiff {
	files: SdkWorkingTreeDiffRow[];
	truncated: boolean;
	omittedFiles: number;
	truncationReasons: string[];
}

function redact(value: string, secrets: readonly string[]): string {
	// Literal credentials must be removed before generic redaction can split them.
	for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[REDACTED]");
	return redactCrashSecrets(value);
}
function truncateBytes(value: string, limit: number): string {
	const buffer = Buffer.from(value);
	if (buffer.byteLength <= limit) return value;
	let end = Math.max(0, limit);
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
function sensitive(file: string): boolean {
	return file
		.split(/[\\/]/)
		.some(part =>
			/^(?:\.env(?:\..*)?|\.envrc|\.git|\.gjc|\.pi|\.ssh|\.aws|\.azure|\.gnupg|\.docker|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.(?:db|json)(?:[-.].*)?|credentials(?:\..*)?|secrets\.json|application_default_credentials\.json|.*\.(?:pem|key|p12|pfx|kdbx|db|sqlite|sqlite3)(?:[-.].*)?)$/i.test(
				part,
			),
		);
}
function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface StatusRow {
	path: string;
	previous?: string;
	status: string;
	representable: boolean;
}
function parseStatus(value: Uint8Array): StatusRow[] {
	const records: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== 0) continue;
		records.push(value.subarray(start, index));
		start = index + 1;
	}
	if (start !== value.length) throw new SdkDiffObservationError("git_failure");
	const decode = (bytes: Uint8Array): { path: string; representable: boolean } => {
		try {
			return { path: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), representable: true };
		} catch {
			// Display only: a lossy label is never an executable filesystem/Git path.
			return { path: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), representable: false };
		}
	};
	const result: StatusRow[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (!record.length) continue;
		if (record.length < 4 || record[2] !== 32 || record[0]! > 127 || record[1]! > 127)
			throw new SdkDiffObservationError("git_failure");
		const status = String.fromCharCode(record[0]!, record[1]!);
		const row: StatusRow = { ...decode(record.subarray(3)), status };
		// -z reverses the human-readable rename order: destination NUL source.
		if (/[RC]/.test(status)) {
			const previous = records[++index];
			if (!previous?.length) throw new SdkDiffObservationError("git_failure");
			const source = decode(previous);
			row.previous = source.path;
			row.representable &&= source.representable;
		}
		result.push(row);
	}
	return result;
}

interface SdkDiffReadOptions {
	knownSecrets?: readonly string[];
	signal?: AbortSignal;
	selection?: "working-tree" | "tracked-unstaged";
}

/** Bounded, read-only Git engine shared by both SDK diff surfaces. */
export async function readSdkWorkingTreeDiff(
	cwd: string,
	options: SdkDiffReadOptions = {},
): Promise<SdkWorkingTreeDiff> {
	if (
		options.selection !== undefined &&
		options.selection !== "working-tree" &&
		options.selection !== "tracked-unstaged"
	)
		throw new SdkDiffObservationError("invalid_input");
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(
		() => controller.abort(new SdkDiffObservationError("diff_too_large")),
		SDK_DIFF_LIMITS.timeMs,
	);
	try {
		// Keep ownership until every Git subprocess has exited, including on abort.
		return await readWorkingTreeDiff(cwd, options, signal);
	} catch (error) {
		if (signal.aborted)
			throw signal.reason instanceof SdkDiffObservationError
				? signal.reason
				: new SdkDiffObservationError("git_failure");
		if (error instanceof SdkDiffObservationError) throw error;
		throw new SdkDiffObservationError("git_failure");
	} finally {
		clearTimeout(timer);
	}
}

async function readWorkingTreeDiff(
	cwd: string,
	options: SdkDiffReadOptions,
	signal: AbortSignal,
): Promise<SdkWorkingTreeDiff> {
	const deadline = Date.now() + SDK_DIFF_LIMITS.timeMs;
	let readBytes = 0;
	const secrets = [...new Set(options.knownSecrets ?? [])]
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);
	const checkTime = (): void => {
		if (signal.aborted || Date.now() >= deadline) throw new SdkDiffObservationError("diff_too_large");
	};
	const git = async (directory: string, args: string[], allowed = [0]): Promise<{ data: Buffer; code: number }> => {
		checkTime();
		try {
			const child = Bun.spawn(
				["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
				{
					cwd: directory,
					env: {
						...projectSafeSpawnEnv(),
						GIT_OPTIONAL_LOCKS: "0",
						GIT_TERMINAL_PROMPT: "0",
						GIT_LITERAL_PATHSPECS: "1",
					},
					signal,
					killSignal: "SIGKILL",
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
				},
			);
			const kill = (): void => {
				child.kill("SIGKILL");
			};
			const reader = child.stdout.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					readBytes += chunk.value.byteLength;
					if (size > SDK_DIFF_LIMITS.commandBytes || readBytes > SDK_DIFF_LIMITS.readBytes) {
						kill();
						throw new SdkDiffObservationError("diff_too_large");
					}
					chunks.push(chunk.value);
				}
				const code = await child.exited;
				checkTime();
				if (!allowed.includes(code)) throw new SdkDiffObservationError("git_failure");
				return { data: Buffer.concat(chunks), code };
			} finally {
				reader.releaseLock();
				kill();
				await child.exited;
			}
		} catch (error) {
			if (error instanceof SdkDiffObservationError) throw error;
			throw new SdkDiffObservationError("git_failure");
		}
	};
	try {
		const probe = await git(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]);
		if (probe.code !== 0 || probe.data.toString("utf8").trim() !== "true")
			throw new SdkDiffObservationError("not_git_repository");
		const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
		const root = await fs.realpath(top.data.toString("utf8").replace(/\r?\n$/, ""));
		checkTime();
		const trackedUnstaged = options.selection === "tracked-unstaged";
		const status = await git(root, [
			"status",
			"--porcelain=v1",
			"-z",
			trackedUnstaged ? "--untracked-files=no" : "--untracked-files=all",
			"--ignore-submodules=dirty",
			"--",
		]);
		const parsed = parseStatus(status.data);
		const rows = trackedUnstaged
			? parsed.filter(row => row.status !== "??" && row.status[1] !== " ")
			: parsed;
		const result: SdkWorkingTreeDiff = { files: [], truncated: false, omittedFiles: 0, truncationReasons: [] };
		const reason = (value: string): void => {
			result.truncated = true;
			if (!result.truncationReasons.includes(value)) result.truncationReasons.push(value);
		};
		let bytes = 1024;
		const safePath = async (file: string): Promise<boolean> => {
			if (sensitive(file) || path.isAbsolute(file) || !inside(root, path.resolve(root, file))) return false;
			let current = root;
			const components = file.split("/");
			for (const [index, component] of components.entries()) {
				if (!component || component === "." || component === "..") return false;
				current = path.join(current, component);
				try {
					const stat = await fs.lstat(current);
					checkTime();
					if (stat.isSymbolicLink() || (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()))
						return false;
					if (!inside(root, await fs.realpath(current))) return false;
					checkTime();
				} catch (error) {
					if (error instanceof SdkDiffObservationError) throw error;
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
					return false;
				}
			}
			return true;
		};
		for (const row of rows.slice(0, SDK_DIFF_LIMITS.files)) {
			checkTime();
			const paths = row.previous ? [row.path, row.previous] : [row.path];
			let withheld = !row.representable || paths.some(file => secrets.some(secret => file.includes(secret)));
			if (row.representable) for (const file of paths) if (!(await safePath(file))) withheld = true;
			let body = "";
			if (!withheld) {
				const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty"];
				if (row.status === "??") {
					body = (
						await git(root, ["diff", ...flags, "--no-index", "--", "/dev/null", row.path], [0, 1])
					).data.toString("utf8");
				} else {
					if (!trackedUnstaged && row.status[0] !== " ")
						body += (await git(root, ["diff", "--cached", ...flags, "--", ...paths])).data.toString("utf8");
					if (row.status[1] !== " ")
						body += (await git(root, ["diff", ...flags, "--", ...paths])).data.toString("utf8");
				}
				// Deleted/staged symlinks are visible only in Git's mode metadata.
				if (/^(?:old mode|new mode|new file mode|deleted file mode) 120000$|^index .* 120000$/m.test(body))
					withheld = true;
				for (const file of paths) if (!(await safePath(file))) withheld = true;
			}
			body = withheld ? "" : redact(body, secrets);
			const truncated = Buffer.byteLength(body) > SDK_DIFF_LIMITS.fileBytes;
			if (truncated) reason("file_bytes");
			const displayPath = redact(row.path, secrets);
			const item: SdkWorkingTreeDiffRow = {
				id: displayPath,
				path: displayPath,
				body: truncateBytes(body, SDK_DIFF_LIMITS.fileBytes),
				status: row.status,
				truncated,
				withheld,
			};
			const size = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (bytes + size > SDK_DIFF_LIMITS.responseBytes) {
				reason("total_bytes");
				break;
			}
			bytes += size;
			result.files.push(item);
		}
		result.omittedFiles = rows.length - result.files.length;
		if (rows.length > SDK_DIFF_LIMITS.files) reason("file_count");
		checkTime();
		return result;
	} catch (error) {
		if (error instanceof SdkDiffObservationError) throw error;
		throw new SdkDiffObservationError("git_failure");
	}
}

import type { SdkDiffObservationOperation } from "./protocol/client-control-contracts";

export { isSdkDiffObservationOperation, type SdkDiffObservationOperation } from "./protocol/client-control-contracts";
export interface SdkDiffFileSummary {
	ref: string;
	path: string;
	status: string;
	truncated: boolean;
	withheld: boolean;
}
export interface SdkDiffScopes {
	scopes: Array<{ id: "working-tree"; label: string }>;
}
export interface SdkDiffSummary {
	scope: "working-tree";
	snapshotId: string;
	files: SdkDiffFileSummary[];
	truncated: boolean;
	omittedFiles: number;
	truncationReasons: string[];
}
export interface SdkDiffFile extends SdkWorkingTreeDiffRow {
	ref: string;
}
export type SdkDiffObservationResult = SdkDiffScopes | SdkDiffSummary | SdkDiffFile;

function inputObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new SdkDiffObservationError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new SdkDiffObservationError("invalid_input");
	const names = Reflect.ownKeys(input);
	if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)))
		throw new SdkDiffObservationError("invalid_input");
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new SdkDiffObservationError("invalid_input");
		result[key] = descriptor.value;
	}
	return result;
}

// Retain admission across observation disposal/recreation until backend cleanup settles.
const sessionDiffReads = new WeakMap<AgentSession, AbortController>();

/** File refs address only the latest frozen summary, never caller-supplied paths. */
export class SdkDiffObservation {
	readonly #session: AgentSession;
	readonly #manager: AgentSession["sessionManager"];
	readonly #registry: AgentSession["modelRegistry"];
	readonly #sessionId: string;
	readonly #managerId: string;
	readonly #identityGeneration: number;
	readonly #generation: number;
	readonly #cwd: string;
	readonly #cleanups: Array<() => void> = [];
	readonly #files = new Map<string, Readonly<SdkWorkingTreeDiffRow>>();
	#retired: "disposed" | "stale_session" | undefined;
	#readController: AbortController | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#manager = session.sessionManager;
		this.#registry = session.modelRegistry;
		this.#sessionId = session.sessionId;
		this.#managerId = this.#manager.getSessionId();
		this.#identityGeneration = this.#manager.getSessionIdentityGeneration();
		this.#generation = session.sessionLifecycle.generation;
		this.#cwd = this.#manager.getCwd();
		this.#guard();
		this.#cleanups.push(session.registerToolSessionCleanup(() => this.dispose()));
		this.#cleanups.push(
			session.registerToolSessionTransitionCleanup(() =>
				this.#retire(session.sessionLifecycle.disposed ? "disposed" : "stale_session"),
			),
		);
		this.#cleanups.push(
			session.subscribeSessionIdentityChanges(() => {
				try {
					this.#guard();
				} catch {
					// Guard retires identity changes; an in-progress transition is retriable.
				}
			}),
		);
	}
	get disposed(): boolean {
		return this.#retired !== undefined;
	}
	#guard(): void {
		const lifecycle = this.#session.sessionLifecycle;
		if (lifecycle.disposed) {
			this.#retire("disposed");
			throw new SdkDiffObservationError("disposed");
		}
		if (this.#retired) throw new SdkDiffObservationError(this.#retired);
		if (
			lifecycle.generation !== this.#generation ||
			this.#session.sessionId !== this.#sessionId ||
			this.#session.sessionManager !== this.#manager ||
			this.#session.modelRegistry !== this.#registry ||
			this.#manager.getSessionId() !== this.#managerId ||
			this.#manager.getSessionIdentityGeneration() !== this.#identityGeneration ||
			this.#manager.getCwd() !== this.#cwd
		) {
			this.#retire("stale_session");
			throw new SdkDiffObservationError("stale_session");
		}
		if (lifecycle.transitioning) {
			this.#readController?.abort(new SdkDiffObservationError("session_transitioning"));
			throw new SdkDiffObservationError("session_transitioning");
		}
	}
	scopes(input: unknown): SdkDiffScopes {
		this.#guard();
		inputObject(input, []);
		this.#guard();
		return { scopes: [{ id: "working-tree", label: "Working tree (staged, unstaged, and untracked)" }] };
	}
	async summary(input: unknown): Promise<SdkDiffSummary> {
		this.#guard();
		if (inputObject(input, ["scope"]).scope !== "working-tree") throw new SdkDiffObservationError("invalid_input");
		this.#guard();
		if (sessionDiffReads.has(this.#session)) throw new SdkDiffObservationError("busy");
		const controller = new AbortController();
		sessionDiffReads.set(this.#session, controller);
		this.#readController = controller;
		this.#files.clear();
		try {
			const knownSecrets = collectSdkStoredSecrets(this.#registry.authStorage);
			this.#guard();
			const result = await readSdkWorkingTreeDiff(this.#cwd, { knownSecrets, signal: controller.signal });
			this.#guard();
			const snapshotId = randomUUID();
			const files = result.files.map(row => {
				const ref = randomUUID();
				this.#files.set(ref, Object.freeze({ ...row }));
				return { ref, path: row.path, status: row.status, truncated: row.truncated, withheld: row.withheld };
			});
			return {
				scope: "working-tree",
				snapshotId,
				files,
				truncated: result.truncated,
				omittedFiles: result.omittedFiles,
				truncationReasons: [...result.truncationReasons],
			};
		} catch (error) {
			this.#guard();
			if (error instanceof SdkDiffObservationError) throw error;
			throw new SdkDiffObservationError("git_failure");
		} finally {
			if (sessionDiffReads.get(this.#session) === controller) sessionDiffReads.delete(this.#session);
			if (this.#readController === controller) this.#readController = undefined;
		}
	}
	file(input: unknown): SdkDiffFile {
		this.#guard();
		const { ref } = inputObject(input, ["ref"]);
		if (typeof ref !== "string" || ref.length > 128) throw new SdkDiffObservationError("invalid_input");
		this.#guard();
		const row = this.#files.get(ref);
		if (!row) throw new SdkDiffObservationError("stale_ref");
		return { ref, ...row };
	}
	async dispatch(operation: SdkDiffObservationOperation, input: unknown): Promise<SdkDiffObservationResult> {
		switch (operation) {
			case "diff.scopes":
				return this.scopes(input);
			case "diff.summary":
				return this.summary(input);
			case "diff.file":
				return this.file(input);
			default:
				throw new SdkDiffObservationError("invalid_input");
		}
	}
	#retire(reason: "disposed" | "stale_session"): void {
		if (this.#retired) return;
		this.#retired = reason;
		this.#readController?.abort(new SdkDiffObservationError(reason));
		this.#files.clear();
		for (const cleanup of this.#cleanups.splice(0)) cleanup();
	}
	dispose(): void {
		this.#retire("disposed");
	}
}
export function createSdkDiffObservation(session: AgentSession): SdkDiffObservation {
	return new SdkDiffObservation(session);
}

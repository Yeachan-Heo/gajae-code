import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import * as path from "node:path";

export const MAX_ENTRIES = 1024;
export type WorktreeRootErrorCode = "root-unreadable" | "root-invalid";
export class WorktreeRootError extends Error {
	constructor(readonly code: WorktreeRootErrorCode) {
		super(code === "root-invalid" ? "managed worktree root is invalid" : "managed worktree root cannot be read");
	}
}
export const MAX_DEPTH = 2;
export const MAX_NAME_UTF8_BYTES = 255;
export const MAX_METADATA_BYTES = 65536;
export const METADATA_RESERVATION_BYTES = 65537;
export const MAX_TOTAL_METADATA_BYTES = 1048576;
const CHUNK_BYTES = 8192;
const DISPLAY_BYTES = 512;
const TRUNCATED_SUFFIX = "…[truncated]";

export type WorktreeScannerPlatform = "posix" | "win32";
type ComponentResult = "ok" | "outside" | "link" | "race" | "io" | "not-directory";
type MetadataFamily = "git" | "head" | "commondir" | "gitdir";
type MetadataFailure = "link" | "race" | "unreadable" | "oversize" | "invalid-utf8" | "nul";
export interface ScanWorktreesOptions {
	root: string;
	platform: WorktreeScannerPlatform;
}
export type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray" | "overflow" | "unsupported";
export interface WorktreeDiagnostic {
	path: string;
	kind: WorktreeKind;
	reasonCode: string;
	message: string;
}
interface Identity {
	dev: bigint;
	ino: bigint;
}
interface ScanState {
	visited: number;
	reserved: number;
	halted: boolean;
	platform: WorktreeScannerPlatform;
	diagnostics: WorktreeDiagnostic[];
	root: string;
	rootIdentity: Identity;
}
type RawDirectoryEntry = string | Uint8Array | { name: string | Uint8Array };

function nameBytes(name: string | Buffer): Buffer {
	return Buffer.isBuffer(name) ? name : Buffer.from(name);
}
function rawEscapeUnits(raw: string | Buffer, oversize: boolean): string[] {
	const bytes = nameBytes(raw);
	const bounded = oversize ? bytes.subarray(0, MAX_NAME_UTF8_BYTES) : bytes;
	const units: string[] = [];
	for (const b of bounded) {
		if (b >= 0x20 && b <= 0x7e && b !== 0x5c) units.push(String.fromCharCode(b));
		else if (b === 0x5c) units.push("\\\\");
		else if (b === 0x0a) units.push("\\n");
		else if (b === 0x0d) units.push("\\r");
		else if (b === 0x09) units.push("\\t");
		else units.push(`%${b.toString(16).toUpperCase().padStart(2, "0")}`);
	}
	return units;
}
function stringEscapeUnits(value: string): string[] {
	const units: string[] = [];
	for (const ch of value) {
		const code = ch.codePointAt(0) as number;
		if (code >= 0x20 && code <= 0x7e && code !== 0x5c) units.push(ch);
		else if (code === 0x5c) units.push("\\\\");
		else if (code === 0x0a) units.push("\\n");
		else if (code === 0x0d) units.push("\\r");
		else if (code === 0x09) units.push("\\t");
		else {
			for (let index = 0; index < ch.length; index++) {
				const unit = ch.charCodeAt(index);
				units.push(`\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`);
			}
		}
	}
	return units;
}
function stringPathUnits(value: string): string[] {
	if (value === "/") return ["/"];
	const units: string[] = [];
	const components = value.split("/");
	for (const [index, component] of components.entries()) {
		if (index > 0) units.push("/");
		units.push(...stringEscapeUnits(component));
	}
	return units;
}
function truncateEscaped(units: readonly string[], forceSuffix = false): string {
	const encoded = units.join("");
	if (!forceSuffix && Buffer.byteLength(encoded) <= DISPLAY_BYTES) return encoded;
	const kept: string[] = [];
	let bytes = Buffer.byteLength(TRUNCATED_SUFFIX);
	for (const unit of units) {
		const unitBytes = Buffer.byteLength(unit);
		if (bytes + unitBytes > DISPLAY_BYTES) break;
		kept.push(unit);
		bytes += unitBytes;
	}
	return kept.join("") + TRUNCATED_SUFFIX;
}
function displayPath(value: string): string {
	return truncateEscaped(stringPathUnits(value));
}
function displayRawPath(dir: string, raw: string | Buffer, oversize: boolean): string {
	const units = stringPathUnits(dir);
	if (dir !== "/") units.push("/");
	units.push(...rawEscapeUnits(raw, oversize));
	return truncateEscaped(units, oversize);
}
function invalidName(name: string | Buffer): "oversize" | "invalid" | null {
	const bytes = nameBytes(name);
	if (bytes.length === 0 || bytes.length > MAX_NAME_UTF8_BYTES) return "oversize";
	if (bytes.includes(0) || bytes.includes(0x2f) || bytes.includes(0x5c)) return "invalid";
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if ([...decoded].some(ch => ch === "\0" || ch === "/" || ch === "\\")) return "invalid";
	} catch {
		return "invalid";
	}
	return null;
}
function addDiagnostic(state: ScanState, p: string, kind: WorktreeKind, reasonCode: string, message: string): void {
	state.diagnostics.push({ path: displayPath(p), kind, reasonCode, message });
}
function addRawNameDiagnostic(
	state: ScanState,
	dir: string,
	raw: string | Buffer,
	oversize: boolean,
	kind: WorktreeKind,
	reasonCode: string,
	message: string,
): void {
	state.diagnostics.push({ path: displayRawPath(dir, raw, oversize), kind, reasonCode, message });
}
function chargeEntry(state: ScanState): boolean {
	if (state.visited >= MAX_ENTRIES) {
		if (!state.halted)
			addDiagnostic(state, state.root, "overflow", "overflow", "scan limit exceeded: 1024 entries; preserved");
		state.halted = true;
		return false;
	}
	state.visited++;
	return true;
}
function isRegular(stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
	return stat.isFile() && !stat.isSymbolicLink();
}
function sameIdentity(a: Identity, b: { dev: bigint; ino: bigint }): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function metadataIoFailure(phase: "open" | "stat" | "read", code: string | undefined): MetadataFailure {
	if (phase === "open") {
		if (code === "ELOOP") return "link";
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return "race";
		return "unreadable";
	}
	return code === "ENOENT" || code === "EBADF" || code === "EISDIR" ? "race" : "unreadable";
}
function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}
function addDirectoryFailure(state: ScanState, dir: string, error: unknown): void {
	const code = codeOf(error);
	if (code === "ENOENT" || code === "ENOTDIR" || code === "ERACE") {
		addDiagnostic(state, dir, "unsupported", "metadata-raced", "filesystem metadata changed during scan; preserved");
		return;
	}
	addDiagnostic(state, dir, "unsupported", "scan-error", "cannot inspect directory; preserved");
}

function metadataFailure(family: MetadataFamily, failure: MetadataFailure): [WorktreeKind, string, string] {
	if (failure === "link") return ["unsupported", "unsupported-link", "link or reparse point encountered; preserved"];
	if (failure === "race")
		return ["unsupported", "metadata-raced", "filesystem metadata changed during scan; preserved"];
	if (family === "git") {
		if (failure === "unreadable") return ["pr-checkout", "unreadable-gitfile", "cannot read .git file; preserved"];
		if (failure === "oversize")
			return ["pr-checkout", "oversize-gitfile", ".git file exceeds 65536 bytes; preserved"];
		if (failure === "invalid-utf8")
			return ["pr-checkout", "invalid-utf8-gitfile", ".git file is not valid UTF-8; preserved"];
		return ["pr-checkout", "nul-gitfile", ".git file contains NUL; preserved"];
	}
	if (family === "head") {
		if (failure === "unreadable") return ["pr-checkout", "unreadable-head", "cannot read HEAD; preserved"];
		if (failure === "oversize") return ["pr-checkout", "oversize-head", "HEAD exceeds 65536 bytes; preserved"];
		if (failure === "invalid-utf8") return ["pr-checkout", "invalid-utf8-head", "HEAD is not valid UTF-8; preserved"];
		return ["pr-checkout", "nul-head", "HEAD contains NUL; preserved"];
	}
	const label = family === "commondir" ? "common-dir" : "reciprocal gitdir";
	const reason = family === "commondir" ? "commondir" : "gitdir";
	if (failure === "unreadable")
		return ["pr-checkout", `unreadable-${reason}`, `cannot read ${label} metadata; preserved`];
	if (failure === "oversize")
		return ["pr-checkout", `oversize-${reason}`, `${label} metadata exceeds 65536 bytes; preserved`];
	if (failure === "invalid-utf8")
		return ["pr-checkout", `invalid-utf8-${reason}`, `${label} metadata is not valid UTF-8; preserved`];
	return ["pr-checkout", `nul-${reason}`, `${label} metadata contains NUL; preserved`];
}

function addMetadataFailure(state: ScanState, display: string, family: MetadataFamily, failure: MetadataFailure): void {
	const [kind, reasonCode, message] = metadataFailure(family, failure);
	addDiagnostic(state, display, kind, reasonCode, message);
}
async function readBoundedMetadata(
	filePath: string,
	family: MetadataFamily,
	display: string,
	state: ScanState,
	preflight?: BigIntStats,
): Promise<string | null> {
	let stat = preflight;
	if (!stat) {
		try {
			stat = await lstat(filePath, { bigint: true });
		} catch (error) {
			const code = codeOf(error);
			addMetadataFailure(state, display, family, code === "ENOENT" || code === "ENOTDIR" ? "race" : "unreadable");
			return null;
		}
	}
	if (stat.isSymbolicLink()) {
		addMetadataFailure(state, display, family, "link");
		return null;
	}
	if (!isRegular(stat)) {
		addMetadataFailure(state, display, family, "race");
		return null;
	}
	const before: Identity = { dev: stat.dev, ino: stat.ino };
	if (state.reserved + METADATA_RESERVATION_BYTES > MAX_TOTAL_METADATA_BYTES) {
		addDiagnostic(state, display, "overflow", "overflow", "metadata budget exceeded; preserved");
		state.halted = true;
		return null;
	}
	state.reserved += METADATA_RESERVATION_BYTES;
	if (typeof constants.O_NOFOLLOW !== "number") {
		addDiagnostic(
			state,
			display,
			"unsupported",
			"unsupported-platform-proof",
			"no-follow metadata proof unavailable; preserved",
		);
		return null;
	}
	if (typeof constants.O_NONBLOCK !== "number") {
		addDiagnostic(
			state,
			display,
			"unsupported",
			"unsupported-platform-proof",
			"non-blocking metadata proof unavailable; preserved",
		);
		return null;
	}
	let handle: FileHandle;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		addMetadataFailure(state, display, family, metadataIoFailure("open", codeOf(error)));
		return null;
	}
	let result: string | null = null;
	let successful = false;
	try {
		let stat: BigIntStats;
		try {
			stat = await handle.stat({ bigint: true });
		} catch (error) {
			addMetadataFailure(state, display, family, metadataIoFailure("stat", codeOf(error)));
			return null;
		}
		if (!isRegular(stat) || !sameIdentity(before, stat)) {
			addMetadataFailure(state, display, family, "race");
			return null;
		}
		const buffer = Buffer.allocUnsafe(MAX_METADATA_BYTES + 1);
		let offset = 0;
		try {
			while (offset < buffer.length) {
				const read = await handle.read(buffer, offset, Math.min(CHUNK_BYTES, buffer.length - offset), offset);
				if (read.bytesRead === 0) break;
				offset += read.bytesRead;
			}
		} catch (error) {
			addMetadataFailure(state, display, family, metadataIoFailure("read", codeOf(error)));
			return null;
		}
		if (offset > MAX_METADATA_BYTES) {
			addMetadataFailure(state, display, family, "oversize");
			return null;
		}
		try {
			result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
			if (result.includes("\0")) {
				addMetadataFailure(state, display, family, "nul");
				return null;
			}
		} catch {
			addMetadataFailure(state, display, family, "invalid-utf8");
			return null;
		}
		successful = true;
	} finally {
		try {
			await handle.close();
		} catch {
			if (successful) addMetadataFailure(state, display, family, "unreadable");
			successful = false;
		}
	}
	return successful ? result : null;
}
function pointerValue(text: string): string | null {
	const end = text.replace(/[\r\n]*$/, "");
	if (!end.startsWith("gitdir: ")) return null;
	const value = end.slice(8);
	return value.length > 0 && !/[\r\n]/.test(value) ? value : null;
}
function metadataLine(text: string): string | null {
	const value = text.replace(/[\r\n]+$/, "");
	return value.length > 0 && !/[\r\n\0]/.test(value) ? value : null;
}

function validHead(text: string): boolean {
	const value = metadataLine(text);
	return (
		value !== null && (/^ref: refs\/heads\/[^\r\n\0]+$/.test(value) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
	);
}
function contained(base: string, target: string): boolean {
	const relative = path.relative(base, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
async function safeComponents(state: ScanState, target: string): Promise<ComponentResult> {
	if (!contained(state.root, target)) return "outside";
	try {
		const rootStat = await lstat(state.root, { bigint: true });
		if (rootStat.isSymbolicLink()) return "link";
		if (!rootStat.isDirectory() || !sameIdentity(state.rootIdentity, rootStat)) return "race";
	} catch (error) {
		const code = codeOf(error);
		return code === "ENOENT" || code === "ENOTDIR" ? "race" : "io";
	}
	const relative = path.relative(state.root, target);
	let current = state.root;
	for (const part of relative ? relative.split(path.sep) : []) {
		current = path.join(current, part);
		try {
			const stat = await lstat(current, { bigint: true });
			if (stat.isSymbolicLink()) return "link";
			if (!stat.isDirectory()) return "not-directory";
		} catch (error) {
			const code = codeOf(error);
			return code === "ENOENT" || code === "ENOTDIR" ? "race" : "io";
		}
	}
	return "ok";
}
function addComponentDiagnostic(state: ScanState, candidate: string, result: Exclude<ComponentResult, "ok">): void {
	if (result === "outside") {
		addDiagnostic(
			state,
			candidate,
			"pr-checkout",
			"pointer-outside-root",
			"gitdir pointer outside managed root; preserved",
		);
		return;
	}
	if (result === "link") {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			"unsupported-link",
			"link or reparse point encountered; preserved",
		);
		return;
	}
	if (result === "race") {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			"metadata-raced",
			"filesystem metadata changed during scan; preserved",
		);
		return;
	}
	if (result === "not-directory") {
		addDiagnostic(state, candidate, "pr-checkout", "separate-git-dir", "gitdir target is not a directory; preserved");
		return;
	}
	addDiagnostic(state, candidate, "pr-checkout", "unreadable-gitfile", "cannot read .git file; preserved");
}
async function readContainedMetadata(
	container: string,
	filePath: string,
	family: MetadataFamily,
	candidate: string,
	state: ScanState,
	preflight?: BigIntStats,
): Promise<string | null> {
	const before = await safeComponents(state, container);
	if (before !== "ok") {
		addComponentDiagnostic(state, candidate, before);
		return null;
	}
	const text = await readBoundedMetadata(filePath, family, candidate, state, preflight);
	if (state.halted) return null;
	const after = await safeComponents(state, container);
	if (after !== "ok") {
		addComponentDiagnostic(state, candidate, after);
		return null;
	}
	return text;
}
async function inspectPointer(candidate: string, gitFile: string, text: string, state: ScanState): Promise<boolean> {
	const pointer = pointerValue(text);
	if (!pointer) {
		addDiagnostic(state, candidate, "pr-checkout", "malformed-gitfile", "malformed .git file; preserved");
		return false;
	}
	const target = path.normalize(path.isAbsolute(pointer) ? pointer : path.join(path.dirname(gitFile), pointer));
	if (/^(?:\\\\|\/\/|[A-Za-z]:[\\/]{2})/.test(pointer)) {
		addDiagnostic(state, candidate, "pr-checkout", "unc-network", "network gitdir pointer unsupported; preserved");
		return false;
	}
	const commondir = await readContainedMetadata(target, path.join(target, "commondir"), "commondir", candidate, state);
	if (state.halted || commondir === null) return false;
	const commonValue = metadataLine(commondir);
	if (commonValue === null) {
		addDiagnostic(state, candidate, "pr-checkout", "common-dir", "common-dir metadata observed; preserved");
		return false;
	}
	const common = path.normalize(path.isAbsolute(commonValue) ? commonValue : path.join(target, commonValue));
	const commonResult = await safeComponents(state, common);
	if (commonResult !== "ok") {
		addComponentDiagnostic(state, candidate, commonResult);
		return false;
	}
	const head = await readContainedMetadata(target, path.join(target, "HEAD"), "head", candidate, state);
	if (state.halted || head === null) return false;
	if (!validHead(head)) {
		addDiagnostic(state, candidate, "pr-checkout", "malformed-head", "malformed HEAD; preserved");
		return false;
	}
	const reciprocal = await readContainedMetadata(target, path.join(target, "gitdir"), "gitdir", candidate, state);
	if (state.halted || reciprocal === null) return false;
	const reciprocalValue = metadataLine(reciprocal);
	if (reciprocalValue === null) {
		addDiagnostic(
			state,
			candidate,
			"pr-checkout",
			"invalid-pointer",
			"worktree metadata pointer is not reciprocal; preserved",
		);
		return false;
	}
	const reciprocalPath = path.normalize(
		path.isAbsolute(reciprocalValue) ? reciprocalValue : path.join(target, reciprocalValue),
	);
	if (
		reciprocalPath !== path.normalize(gitFile) ||
		!contained(state.root, reciprocalPath) ||
		(await safeComponents(state, path.dirname(reciprocalPath))) !== "ok"
	) {
		addDiagnostic(
			state,
			candidate,
			"pr-checkout",
			"invalid-pointer",
			"worktree metadata pointer is not reciprocal; preserved",
		);
		return false;
	}
	return true;
}
async function inspectCandidate(candidate: string, state: ScanState, depth: number): Promise<boolean> {
	let stat: BigIntStats;
	try {
		stat = await lstat(candidate, { bigint: true });
	} catch (error) {
		addDirectoryFailure(state, candidate, error);
		return false;
	}
	if (stat.isSymbolicLink()) {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			"unsupported-link",
			"link or reparse point encountered; preserved",
		);
		return false;
	}
	if (!stat.isDirectory()) return false;
	if (state.platform === "win32") {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			"unsupported-platform-proof",
			"no-follow metadata proof unavailable on Windows; preserved",
		);
		return true;
	}
	const git = path.join(candidate, ".git");
	let gitStat: BigIntStats | undefined;
	try {
		gitStat = await lstat(git, { bigint: true });
	} catch (error) {
		const code = codeOf(error);
		if (code !== "ENOENT") {
			addDiagnostic(
				state,
				candidate,
				code === "ENOTDIR" ? "unsupported" : "pr-checkout",
				code === "ENOTDIR" ? "metadata-raced" : "unreadable-gitfile",
				code === "ENOTDIR"
					? "filesystem metadata changed during scan; preserved"
					: "cannot read .git file; preserved",
			);
			return true;
		}
	}
	if (gitStat) {
		if (gitStat.isSymbolicLink()) {
			addDiagnostic(
				state,
				candidate,
				"unsupported",
				"unsupported-link",
				"link or reparse point encountered; preserved",
			);
			return true;
		}
		if (gitStat.isFile()) {
			const text = await readContainedMetadata(candidate, git, "git", candidate, state, gitStat);
			if (state.halted) return true;
			if (text === null || !(await inspectPointer(candidate, git, text, state))) return true;
			addDiagnostic(state, candidate, "pr-checkout", "normal-pr", "worktree metadata observed; preserved");
			return true;
		}
		if (gitStat.isDirectory()) {
			addDiagnostic(state, candidate, "pr-checkout", "bare-repository", ".git directory observed; preserved");
			return true;
		}
	}
	let merged = false;
	try {
		const mergedStat = await lstat(path.join(candidate, "merged"), { bigint: true });
		merged = mergedStat.isDirectory() && !mergedStat.isSymbolicLink();
	} catch (error) {
		const code = codeOf(error);
		if (code !== "ENOENT") {
			addDiagnostic(
				state,
				candidate,
				code === "ENOTDIR" ? "unsupported" : "stray",
				code === "ENOTDIR" ? "metadata-raced" : "merged-unreadable",
				code === "ENOTDIR"
					? "filesystem metadata changed during scan; preserved"
					: "unrecognized directory contents; preserved",
			);
			return true;
		}
	}
	if (merged) {
		addDiagnostic(state, candidate, "task-isolation", "task-isolation", "task-isolation directory; preserved");
		return true;
	}
	const nestedCount = await scanLevel(candidate, state, depth + 1);
	if (nestedCount === 0 && !state.halted)
		addDiagnostic(state, candidate, "empty", "empty", "empty directory; preserved");
	else if (nestedCount === -2 && !state.halted)
		addDiagnostic(state, candidate, "stray", "stray", "unrecognized directory contents; preserved");
	return true;
}
function rawEntryName(entry: RawDirectoryEntry): string | Buffer {
	if (typeof entry === "string") return entry;
	if (entry instanceof Uint8Array) return Buffer.from(entry);
	return entry.name instanceof Uint8Array ? Buffer.from(entry.name) : entry.name;
}
async function scanLevel(dir: string, state: ScanState, depth: number): Promise<number> {
	if (state.visited >= MAX_ENTRIES) {
		chargeEntry(state);
		return -1;
	}
	let before: Identity | undefined;
	try {
		const stat = await lstat(dir, { bigint: true });
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(dir === state.root && !sameIdentity(state.rootIdentity, stat))
		)
			throw Object.assign(new Error("directory changed"), { code: "ERACE" });
		before = { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if (dir === state.root) {
			const code = codeOf(error);
			throw new WorktreeRootError(code === "ERACE" || code === "ENOTDIR" ? "root-invalid" : "root-unreadable");
		}
		addDirectoryFailure(state, dir, error);
		return -1;
	}
	let entries: ReadonlyArray<RawDirectoryEntry>;
	try {
		entries = (await readdir(dir, {
			withFileTypes: true,
			encoding: "buffer",
		})) as unknown as ReadonlyArray<RawDirectoryEntry>;
	} catch (error) {
		if (dir === state.root) throw new WorktreeRootError("root-unreadable");
		addDirectoryFailure(state, dir, error);
		return -1;
	}
	try {
		const after = await lstat(dir, { bigint: true });
		if (!before || !sameIdentity(before, after)) {
			if (dir === state.root) throw new WorktreeRootError("root-invalid");
			addDiagnostic(
				state,
				dir,
				"unsupported",
				"metadata-raced",
				"filesystem metadata changed during scan; preserved",
			);
			return -1;
		}
	} catch (error) {
		if (error instanceof WorktreeRootError) throw error;
		if (dir === state.root) throw new WorktreeRootError("root-unreadable");
		addDirectoryFailure(state, dir, error);
		return -1;
	}
	let count = 0;
	let entriesSeen = 0;
	for (const entry of entries) {
		if (!chargeEntry(state)) break;
		entriesSeen++;
		if (depth > MAX_DEPTH) continue;
		const raw = rawEntryName(entry);
		const invalid = invalidName(raw);
		if (invalid) {
			addRawNameDiagnostic(
				state,
				dir,
				raw,
				invalid === "oversize",
				"unsupported",
				invalid === "oversize" ? "oversize-name" : "invalid-name",
				invalid === "oversize"
					? "directory name exceeds 255 bytes; preserved"
					: "invalid UTF-8 directory name; preserved",
			);
			continue;
		}
		const child = path.join(dir, Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
		if (await inspectCandidate(child, state, depth)) count++;
		if (state.halted) break;
	}
	if (count === 0 && entriesSeen > 0 && !state.halted) return -2;
	return count;
}
export async function scanWorktrees(options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> {
	let rootStat: BigIntStats;
	try {
		rootStat = await lstat(options.root, { bigint: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw new WorktreeRootError("root-unreadable");
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new WorktreeRootError("root-invalid");
	const state: ScanState = {
		visited: 0,
		reserved: 0,
		halted: false,
		platform: options.platform,
		diagnostics: [],
		root: options.root,
		rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
	};
	await scanLevel(options.root, state, 1);
	return state.diagnostics;
}

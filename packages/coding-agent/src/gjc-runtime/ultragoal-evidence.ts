import * as path from "node:path";
import { inflateSync } from "node:zlib";
import {
	evidenceKindMatches,
	hasExistingNonEmptyArtifact,
	hasTypedVerifiedReceipt,
	isLiveSurfaceFamily,
	isSubstantiveEvidence,
	type JsonObject,
	nonEmptyString,
	nonEmptyStringArray,
	normalizedEvidenceKind,
	PASSED_STATUS,
	qualityGateObject,
	readArtifactBytes,
	requiredStringField,
	requireObjectArray,
	requireQualityGateObject,
	requireResolvedLinks,
	requireStringLinks,
	type SurfaceFamily,
	surfaceFamily,
} from "./ultragoal-runtime";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_END_OF_IMAGE = 0xd9;
const JPEG_START_OF_SCAN = 0xda;
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const PNG_CRC_TABLE = new Uint32Array(256).map((_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

export function pngCrc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export function parsePngDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	if (bytes.length < 45) return null;
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	let offset = 8;
	let width = 0;
	let height = 0;
	let sawIhdr = false;
	let sawIdat = false;
	const idatChunks: Buffer[] = [];
	while (offset + 12 <= bytes.length) {
		const chunkStart = offset;
		const length = bytes.readUInt32BE(offset);
		offset += 4;
		const type = bytes.toString("ascii", offset, offset + 4);
		offset += 4;
		if (offset + length + 4 > bytes.length) return null;
		const data = bytes.subarray(offset, offset + length);
		offset += length;
		const expectedCrc = bytes.readUInt32BE(offset);
		offset += 4;
		if (pngCrc32(bytes.subarray(chunkStart + 4, offset - 4)) !== expectedCrc) return null;
		if (!sawIhdr) {
			if (type !== "IHDR" || length !== 13) return null;
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (
				width === 0 ||
				height === 0 ||
				data[8] !== 8 ||
				![2, 6].includes(data[9]!) ||
				data[10] !== 0 ||
				data[11] !== 0 ||
				data[12] !== 0
			)
				return null;
			sawIhdr = true;
		} else if (type === "IHDR") return null;
		if (type === "IDAT") {
			if (!sawIhdr || length === 0) return null;
			sawIdat = true;
			idatChunks.push(data);
		}
		if (type === "IEND") {
			if (length !== 0 || !sawIhdr || !sawIdat || offset !== bytes.length) return null;
			try {
				return { width, height, headerBytes: 8, sampleBytes: inflateSync(Buffer.concat(idatChunks)) };
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function parseJpegDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== JPEG_START_OF_IMAGE) return null;
	let offset = 2;
	let dimensions: { width: number; height: number; headerBytes: number } | null = null;
	let sawStartOfScan = false;
	let scanStart = -1;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		while (offset < bytes.length && bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) return null;
		const marker = bytes[offset++];
		if (marker === 0x00) return null;
		if (marker === JPEG_END_OF_IMAGE) return null;
		if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
		if (offset + 2 > bytes.length) return null;
		const segmentLength = bytes.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
		const segmentDataEnd = offset + segmentLength;
		if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
			if (segmentLength < 8) return null;
			dimensions = {
				width: bytes.readUInt16BE(offset + 5),
				height: bytes.readUInt16BE(offset + 3),
				headerBytes: offset + segmentLength,
			};
		}
		if (marker === JPEG_START_OF_SCAN) {
			if (!dimensions || segmentDataEnd >= bytes.length) return null;
			sawStartOfScan = true;
			scanStart = segmentDataEnd;
			break;
		}
		offset += segmentLength;
	}
	if (!dimensions || !sawStartOfScan || scanStart < 0) return null;
	let scanOffset = scanStart;
	let entropyBytes = 0;
	while (scanOffset < bytes.length) {
		const byte = bytes[scanOffset++]!;
		if (byte !== 0xff) {
			entropyBytes++;
			continue;
		}
		if (scanOffset >= bytes.length) return null;
		const marker = bytes[scanOffset++]!;
		if (marker === 0x00) {
			entropyBytes++;
			continue;
		}
		if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
		if (marker === JPEG_END_OF_IMAGE) {
			if (scanOffset !== bytes.length || entropyBytes < 32) return null;
			return { ...dimensions, sampleBytes: bytes.subarray(scanStart, scanOffset - 2) };
		}
		return null;
	}
	return null;
}

function unsupportedScreenshotFormat(bytes: Buffer): string | null {
	if (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a") return "GIF";
	if (bytes.toString("ascii", 0, 2) === "BM") return "BMP";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
		return "WebP";
	return null;
}

function parseImageDimensions(
	bytes: Buffer,
): { width: number; height: number; headerBytes: number; sampleBytes?: Buffer } | null {
	return parsePngDimensions(bytes) ?? parseJpegDimensions(bytes);
}

function hasNonUniformImageBytes(bytes: Buffer, headerBytes: number, sampleBytes?: Buffer): boolean {
	const source = sampleBytes ?? bytes;
	const sampleStart = sampleBytes ? 0 : Math.min(Math.max(headerBytes, 0), source.length);
	const sampleLength = source.length - sampleStart;
	if (sampleLength < 32) return false;
	const windows: Buffer[] = [];
	for (let index = 0; index < 64; index++) {
		const offset = sampleStart + Math.floor(((sampleLength - 32) * index) / 63);
		windows.push(source.subarray(offset, offset + 32));
	}
	const byteCounts = new Map<number, number>();
	let total = 0;
	for (const window of windows) {
		for (const byte of window) {
			byteCounts.set(byte, (byteCounts.get(byte) ?? 0) + 1);
			total++;
		}
	}
	const first = windows[0]!;
	const differingWindows = windows.slice(1).filter(window => !window.equals(first)).length;
	const maxCount = Math.max(...byteCounts.values());
	return byteCounts.size >= 16 && differingWindows >= 8 && maxCount / total <= 0.95;
}

async function validateScreenshotArtifact(cwd: string, row: JsonObject, fieldName: string): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} screenshot artifact path must resolve to an existing file`);
	if (bytes.length < 4096) throw new Error(`qualityGate ${fieldName} screenshot artifact must be at least 4096 bytes`);
	const unsupportedFormat = unsupportedScreenshotFormat(bytes);
	if (unsupportedFormat) {
		throw new Error(
			`qualityGate ${fieldName} unsupported/undecodable screenshot format ${unsupportedFormat}; use PNG or fully marker-validated JPEG`,
		);
	}
	const dimensions = parseImageDimensions(bytes);
	if (!dimensions)
		throw new Error(`qualityGate ${fieldName} screenshot artifact must be a decodable PNG or JPEG image`);
	if (dimensions.width < 320 || dimensions.height < 180) {
		throw new Error(`qualityGate ${fieldName} screenshot artifact must be at least 320x180 pixels`);
	}
	if (!hasNonUniformImageBytes(bytes, dimensions.headerBytes, dimensions.sampleBytes)) {
		throw new Error(
			`qualityGate ${fieldName} screenshot artifact must be non-uniform, not blank, solid, tiny, or placeholder imagery`,
		);
	}
	return true;
}

function normalizeTranscriptTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function transcriptSurfaceCompatible(value: unknown, family: SurfaceFamily): boolean {
	const surface = nonEmptyString(value);
	return !surface || family === "unknown" || surfaceFamily(surface) === family;
}

function actionSelectorRequired(type: string): boolean {
	return ["click", "fill", "press", "assert", "screenshot", "observe"].includes(type);
}

async function validateAutomationTranscriptArtifact(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily },
): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} automation transcript path must resolve to an existing file`);
	let transcript: JsonObject;
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		transcript = requireQualityGateObject(parsed, `${fieldName}.transcript`);
	} catch (error) {
		throw new Error(`qualityGate ${fieldName} automation transcript must be valid JSON: ${String(error)}`);
	}
	if (transcript.schemaVersion !== 1)
		throw new Error(`qualityGate ${fieldName} automation transcript schemaVersion must be 1`);
	if (!transcriptSurfaceCompatible(transcript.surface, options.surfaceFamily)) {
		throw new Error(
			`qualityGate ${fieldName} automation transcript surface is not compatible with ${options.surfaceFamily}`,
		);
	}
	if (!nonEmptyString(transcript.tool))
		throw new Error(`qualityGate ${fieldName} automation transcript tool must be non-empty`);
	const actions = requireObjectArray(transcript.actions, `${fieldName}.actions`);
	if (actions.length < 1) throw new Error(`qualityGate ${fieldName} automation transcript actions must be non-empty`);
	const assertionsValue = transcript.assertions;
	const assertions =
		assertionsValue === undefined ? [] : requireObjectArray(assertionsValue, `${fieldName}.assertions`);
	const timestamps: number[] = [];
	let hasSelectorBearingEntry = false;
	for (const [index, action] of actions.entries()) {
		const actionField = `${fieldName}.actions[${index}]`;
		const type = requiredStringField(action, "type", actionField).toLowerCase();
		const timestamp = normalizeTranscriptTimestamp(action.timestamp);
		if (timestamp === null) throw new Error(`qualityGate ${actionField}.timestamp must be present and parseable`);
		timestamps.push(timestamp);
		const selector = nonEmptyString(action.selector);
		if (actionSelectorRequired(type) && !selector)
			throw new Error(`qualityGate ${actionField}.selector must be non-empty`);
		if (type === "goto" && !nonEmptyString(action.url))
			throw new Error(`qualityGate ${actionField}.url must be non-empty`);
		if (type === "custom" && !selector && !nonEmptyString(action.target)) {
			throw new Error(`qualityGate ${actionField}.selector or target must be non-empty`);
		}
		if (selector) hasSelectorBearingEntry = true;
	}
	for (const [index, assertion] of assertions.entries()) {
		const assertionField = `${fieldName}.assertions[${index}]`;
		const timestamp = normalizeTranscriptTimestamp(assertion.timestamp);
		if (timestamp === null) throw new Error(`qualityGate ${assertionField}.timestamp must be present and parseable`);
		timestamps.push(timestamp);
		if (nonEmptyString(assertion.status)?.toLowerCase() !== PASSED_STATUS) {
			throw new Error(`qualityGate ${assertionField}.status must be passed`);
		}
		if (nonEmptyString(assertion.selector)) hasSelectorBearingEntry = true;
	}
	for (let index = 1; index < timestamps.length; index++) {
		if (timestamps[index]! < timestamps[index - 1]!) {
			throw new Error(`qualityGate ${fieldName} automation transcript timestamps must be monotonic non-decreasing`);
		}
	}
	if (!hasSelectorBearingEntry) {
		throw new Error(
			`qualityGate ${fieldName} automation transcript must include at least one selector-bearing action or assertion`,
		);
	}
	return true;
}

async function validatePtyCaptureArtifact(cwd: string, row: JsonObject, fieldName: string): Promise<boolean> {
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) throw new Error(`qualityGate ${fieldName} PTY capture path must resolve to an existing file`);
	if (bytes.length < 512) throw new Error(`qualityGate ${fieldName} PTY capture must be at least 512 bytes`);
	const text = bytes.toString("utf8");
	const hasCsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(text);
	const hasOsc = /\x1b\][^\x07]*(?:\x07|\x1b\\)/.test(text);
	const hasAltOrCursor = /\x1b\[\?1049[hl]|\x1b\[H|\x1b\[2J/.test(text);
	const hasRedraw = /[\r\b]/.test(text) && hasCsi;
	if (!hasCsi && !hasOsc && !hasAltOrCursor && !hasRedraw) {
		throw new Error(`qualityGate ${fieldName} PTY capture must contain terminal control sequences`);
	}
	if (!/[\x20-\x7e]{10,}/.test(text)) {
		throw new Error(
			`qualityGate ${fieldName} PTY capture must contain a printable text run of at least 10 characters`,
		);
	}
	return true;
}

function structuralArtifactKind(row: JsonObject): "screenshot" | "automation" | "pty" | null {
	const kind = normalizedEvidenceKind(row);
	if (evidenceKindMatches(kind, ["screenshot", "image", "visual"])) return "screenshot";
	if (evidenceKindMatches(kind, ["browser", "playwright", "pandawright", "automation", "app-automation"]))
		return "automation";
	if (evidenceKindMatches(kind, ["pty", "tui", "terminal-capture"])) return "pty";
	return null;
}

export async function validateStructuralArtifact(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<boolean> {
	void options.live;
	const kind = structuralArtifactKind(row);
	if (!kind) return false;
	if (kind === "screenshot") return validateScreenshotArtifact(cwd, row, fieldName);
	if (kind === "automation") return validateAutomationTranscriptArtifact(cwd, row, fieldName, options);
	if (kind === "pty") return validatePtyCaptureArtifact(cwd, row, fieldName);
	return false;
}

const CLI_REPLAY_MAX_OUTPUT_BYTES = 1024 * 1024;
const CLI_REPLAY_DEFAULT_TIMEOUT_MS = 10_000;
const CLI_REPLAY_MIN_TIMEOUT_MS = 1_000;
const CLI_REPLAY_MAX_TIMEOUT_MS = 30_000;
const CLI_REPLAY_EXEMPT_REASON_CODES = [
	"unsafe_side_effect",
	"requires_credentials",
	"requires_network",
	"non_deterministic_external",
	"destructive",
	"interactive_only",
	"platform_unavailable",
] as const;
const CLI_REPLAY_EXEMPT_REASON_CODE_SET = new Set<string>(CLI_REPLAY_EXEMPT_REASON_CODES);
const CLI_REPLAY_ENV_BASE: Record<string, string> = { CI: "1", NO_COLOR: "1", GJC_ULTRAGOAL_REPLAY: "1" };
const CLI_REPLAY_EXEMPT_REASON_CODE_LIST = CLI_REPLAY_EXEMPT_REASON_CODES.join(", ");
const CLI_REPLAY_SAFE_ENV_NAMES = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
const CLI_REPLAY_DANGEROUS_ENV_NAME_PATTERN =
	/^(?:NODE_OPTIONS|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_PAGER|PATH|LD_PRELOAD|LD_LIBRARY_PATH)$|^(?:GIT_CONFIG|DYLD_|BUN_|NPM_CONFIG_)|(?:^|_)OPTIONS$|PRELOAD$/;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function clampCliReplayTimeout(value: unknown): number {
	if (value === undefined) return CLI_REPLAY_DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("qualityGate CLI replay timeoutMs must be a finite number");
	}
	return Math.min(CLI_REPLAY_MAX_TIMEOUT_MS, Math.max(CLI_REPLAY_MIN_TIMEOUT_MS, Math.trunc(value)));
}

function basenameCommand(value: string): string {
	return path.basename(value).toLowerCase();
}

function isDeterministicConsoleLogReplay(code: string): boolean {
	let remaining = code.trim();
	if (remaining.length === 0) return false;
	let matched = false;
	while (remaining.length > 0) {
		const match =
			/^console\.log\(\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\$])*`)\s*\)\s*;?\s*/.exec(
				remaining,
			);
		if (!match) return false;
		const statement = match[0]!;
		const literal = match[1]!;
		if (literal.startsWith("`") && literal.includes("${")) return false;
		matched = true;
		remaining = remaining.slice(statement.length);
	}
	return matched;
}

function hasShellRedirectionToken(value: string): boolean {
	return /^(?:[<>]|\d?[<>]|\d?>&\d|\|\|?|&&|;)$/.test(value) || /(?:^|[^\w])-?>/.test(value);
}

function isSafeRefOrPathspec(value: string): boolean {
	return value.length > 0 && !value.startsWith("-") && !/[\0\n\r]/.test(value) && !hasShellRedirectionToken(value);
}

export function isAllowedGitReplayCommand(args: readonly string[]): boolean {
	const subcommand = args[0];
	const rest = args.slice(1);
	if (subcommand === "status") return rest.every(arg => ["--short", "--porcelain", "--branch"].includes(arg));
	if (subcommand === "rev-parse" || subcommand === "merge-base")
		return rest.length > 0 && rest.every(isSafeRefOrPathspec);
	if (subcommand !== "diff" && subcommand !== "show" && subcommand !== "log") return false;
	let pathspecMode = false;
	for (const arg of rest) {
		if (arg === "--") {
			pathspecMode = true;
			continue;
		}
		if (pathspecMode) {
			if (!isSafeRefOrPathspec(arg)) return false;
			continue;
		}
		if (["--stat", "--name-only", "--oneline", "--no-ext-diff"].includes(arg)) continue;
		if (!isSafeRefOrPathspec(arg)) return false;
	}
	return true;
}

function isBareExecutableName(value: string): boolean {
	// The allowlist is keyed on the basename, but the raw command[0] is what gets spawned.
	// Reject path-qualified or case-spoofed executables (e.g. ./git, /tmp/npm, scripts/node, GIT)
	// so an attacker-controlled binary cannot impersonate a trusted tool.
	return (
		value.length > 0 &&
		!value.includes("/") &&
		!value.includes("\\") &&
		value === path.basename(value) &&
		value === value.toLowerCase()
	);
}

function isAllowedCliReplayCommand(command: readonly string[]): boolean {
	if (
		command.length === 0 ||
		command.some(arg => arg.trim() !== arg || arg.length === 0 || hasShellRedirectionToken(arg))
	)
		return false;
	if (!isBareExecutableName(command[0]!)) return false;
	const executable = basenameCommand(command[0]!);
	const args = command.slice(1);
	if (executable === "bun" || executable === "node") {
		if (args.length === 1 && args[0] === "--version") return true;
		return args.length === 2 && args[0] === "-e" && isDeterministicConsoleLogReplay(args[1]!);
	}
	if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
		return (args.length === 1 && args[0] === "--version") || (args.length === 1 && args[0] === "list");
	}
	if (executable === "git") return isAllowedGitReplayCommand(args);
	if (executable === "gjc") return args.length === 1 && ["read", "status"].includes(args[0] ?? "");
	return false;
}
function summarizeBlockedCliReplayCommand(command: readonly string[]): string {
	const executable = command[0] ? basenameCommand(command[0]) : "<missing>";
	const argCount = Math.max(0, command.length - 1);
	return `${JSON.stringify(executable)} with ${argCount} arg${argCount === 1 ? "" : "s"}`;
}

function cliReplayAllowlistDescription(): string {
	return [
		'`bun --version`, `node --version`, or deterministic `bun/node -e "console.log(...)"`',
		"`npm|pnpm|yarn --version` or `npm|pnpm|yarn list`",
		"read-only `git status|rev-parse|merge-base|diff|show|log` with safe args",
		"`gjc read` or `gjc status`",
	].join("; ");
}

function resolveCliReplayCommand(command: string[]): string[] {
	if (basenameCommand(command[0]!) === "bun") return [process.execPath, ...command.slice(1)];
	return command;
}

function resolveUnderCwd(cwd: string, replayCwd: unknown, fieldName: string): string {
	const relative = replayCwd === undefined ? "." : nonEmptyString(replayCwd);
	if (!relative) throw new Error(`qualityGate ${fieldName}.cwd must be a non-empty string when provided`);
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, relative);
	const relativeToRoot = path.relative(root, resolved);
	if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
		throw new Error(`qualityGate ${fieldName}.cwd must resolve under the repository cwd`);
	}
	return resolved;
}

function buildCliReplayEnv(value: unknown, fieldName: string): Record<string, string> {
	const env: Record<string, string> = { ...CLI_REPLAY_ENV_BASE };
	if (value === undefined) return env;
	const object = requireQualityGateObject(value, `${fieldName}.env`);
	for (const [key, envValue] of Object.entries(object)) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
			throw new Error(`qualityGate ${fieldName}.env.${key} must be an uppercase environment key`);
		if (CLI_REPLAY_DANGEROUS_ENV_NAME_PATTERN.test(key) || !CLI_REPLAY_SAFE_ENV_NAMES.has(key)) {
			throw new Error(`qualityGate ${fieldName}.env.${key} is not in the CLI replay safe environment allowlist`);
		}
		if (typeof envValue !== "string") throw new Error(`qualityGate ${fieldName}.env.${key} must be a string`);
		env[key] = envValue;
	}
	return env;
}

function normalizeCliReplayOutput(value: string, cwd: string): string {
	let normalized = value.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r\n?/g, "\n");
	const home = process.env.HOME;
	const replacements: Array<[RegExp, string]> = [
		[/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<TIMESTAMP>"],
		[/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>"],
		[/\b[0-9a-f]{7,}\b/gi, "<HASH>"],
		[/(?:\/private)?\/var\/folders\/[^\s"']+|\/tmp\/[^\s"']+|\/var\/tmp\/[^\s"']+/g, "<TMP>"],
	];
	for (const candidate of [path.resolve(cwd), home]) {
		if (!candidate) continue;
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		normalized = normalized.replace(new RegExp(escaped, "g"), candidate === home ? "<HOME>" : "<CWD>");
	}
	for (const [pattern, replacement] of replacements) normalized = normalized.replace(pattern, replacement);
	const lines = normalized.split("\n").map(line => line.replace(/[ \t]+$/g, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

export async function readCliReplayRecord(cwd: string, row: JsonObject, fieldName: string): Promise<JsonObject | null> {
	const inline = qualityGateObject(row.replay) ?? (row.kind === "cli-replay" ? row : null);
	if (inline) return inline;
	if (!evidenceKindMatches(normalizedEvidenceKind(row), ["cli-replay", "command-replay"])) return null;
	const bytes = await readArtifactBytes(cwd, row, fieldName);
	if (!bytes) return null;
	try {
		return requireQualityGateObject(JSON.parse(bytes.toString("utf8")), `${fieldName}.replay`);
	} catch (error) {
		throw new Error(`qualityGate ${fieldName} CLI replay artifact must be valid JSON: ${String(error)}`);
	}
}

function parseCliReplayRecord(
	record: JsonObject,
	fieldName: string,
): {
	command: string[];
	replayCwd: unknown;
	env: Record<string, string>;
	timeoutMs: number;
	expectedExitCode: number;
	recordedStdout: string;
	invariants: JsonObject[];
} {
	if (record.schemaVersion !== 1) throw new Error(`qualityGate ${fieldName}.schemaVersion must be 1`);
	if (record.kind !== "cli-replay") throw new Error(`qualityGate ${fieldName}.kind must be cli-replay`);
	if (record.command !== undefined && typeof record.command === "string") {
		throw new Error(`qualityGate ${fieldName}.command must be an argv string array, not a shell string`);
	}
	const command = nonEmptyStringArray(record.command);
	if (!command) throw new Error(`qualityGate ${fieldName}.command must be a non-empty string array`);
	if (record.replaySafe !== true)
		throw new Error(`qualityGate ${fieldName}.replaySafe must be true before CLI replay executes`);
	if (!isAllowedCliReplayCommand(command)) {
		throw new Error(
			`qualityGate ${fieldName}.command is not in the conservative CLI replay allowlist; command ${summarizeBlockedCliReplayCommand(command)} is blocked. Allowed replay commands: ${cliReplayAllowlistDescription()}. For other commands, provide audited replayExempt metadata with reasonCode, reason, approvedBy, and fallbackArtifactRefs that point to a structurally valid fallback artifact.`,
		);
	}
	if (record.normalization !== undefined && record.normalization !== "default") {
		throw new Error(`qualityGate ${fieldName}.normalization must be default when provided`);
	}
	if (typeof record.recordedStdout !== "string")
		throw new Error(`qualityGate ${fieldName}.recordedStdout must be a string`);
	if (record.recordedStderr !== undefined && typeof record.recordedStderr !== "string") {
		throw new Error(`qualityGate ${fieldName}.recordedStderr must be a string when provided`);
	}
	const expectedExitCode = record.expectedExitCode === undefined ? 0 : record.expectedExitCode;
	if (typeof expectedExitCode !== "number" || !Number.isInteger(expectedExitCode)) {
		throw new Error(`qualityGate ${fieldName}.expectedExitCode must be an integer`);
	}
	const invariants =
		record.invariants === undefined ? [] : requireObjectArray(record.invariants, `${fieldName}.invariants`);
	return {
		command: command.map(item => item.trim()),
		replayCwd: record.cwd,
		env: buildCliReplayEnv(record.env, fieldName),
		timeoutMs: clampCliReplayTimeout(record.timeoutMs),
		expectedExitCode,
		recordedStdout: record.recordedStdout,
		invariants,
	};
}

function isMeaningfulCliReplayInvariant(invariant: JsonObject, stdout: string, fieldName: string): boolean {
	const type = requiredStringField(invariant, "type", fieldName);
	const value = requiredStringField(invariant, "value", fieldName);
	if (type === "substring") return value.trim().length >= 4 && stdout.includes(value);
	if (type === "regex") {
		const flags = invariant.flags === undefined ? "" : requiredStringField(invariant, "flags", fieldName);
		if (!/^[im]*$/.test(flags)) throw new Error(`qualityGate ${fieldName}.flags may only contain i and m`);
		const expression = new RegExp(value, flags);
		if (expression.test("") || expression.test("gjc-replay-random-nonce-7f3a9c")) return false;
		const match = expression.exec(stdout);
		return match !== null && match[0].length >= 4;
	}
	if (type === "not_substring") return false;
	throw new Error(`qualityGate ${fieldName}.type must be substring, regex, or not_substring`);
}

function validateCliReplayInvariants(invariants: JsonObject[], stdout: string, fieldName: string): boolean {
	let meaningfulPositiveInvariant = false;
	for (const [index, invariant] of invariants.entries()) {
		const invariantField = `${fieldName}.invariants[${index}]`;
		const type = requiredStringField(invariant, "type", invariantField);
		const value = requiredStringField(invariant, "value", invariantField);
		if (type === "not_substring") {
			if (stdout.includes(value))
				throw new Error(`qualityGate ${invariantField} not_substring invariant matched stdout`);
			continue;
		}
		if (!isMeaningfulCliReplayInvariant(invariant, stdout, invariantField)) {
			throw new Error(`qualityGate ${invariantField} must be a meaningful positive invariant that matches stdout`);
		}
		meaningfulPositiveInvariant = true;
	}
	return meaningfulPositiveInvariant;
}

async function collectCliReplayOutput(
	stream: ReadableStream<Uint8Array> | null,
): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false };
	const reader = stream.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size < CLI_REPLAY_MAX_OUTPUT_BYTES) {
				const remaining = CLI_REPLAY_MAX_OUTPUT_BYTES - size;
				const chunk = Buffer.from(value.subarray(0, remaining));
				chunks.push(chunk);
				size += chunk.length;
			}
			if (value.length > 0 && size >= CLI_REPLAY_MAX_OUTPUT_BYTES) {
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export interface ReplayProcessHandle {
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

export async function waitForReplayProcessWithTimeout(
	process: ReplayProcessHandle,
	timeoutMs: number,
	graceMs = 2000,
): Promise<number> {
	let timeoutTimer: NodeJS.Timeout | undefined;
	let graceTimer: NodeJS.Timeout | undefined;
	const timedOut = Symbol("timedOut");
	const timeout = new Promise<typeof timedOut>(resolve => {
		timeoutTimer = setTimeout(() => resolve(timedOut), timeoutMs);
	});
	const first = await Promise.race([process.exited, timeout]);
	if (first !== timedOut) {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		return first;
	}
	process.kill("SIGTERM");
	const killed = Symbol("killed");
	const grace = new Promise<typeof killed>(resolve => {
		graceTimer = setTimeout(() => {
			process.kill("SIGKILL");
			resolve(killed);
		}, graceMs);
	});
	await Promise.race([process.exited, grace]);
	await process.exited.catch(() => undefined);
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (graceTimer) clearTimeout(graceTimer);
	throw new Error("timeout");
}

export async function validateReplayExemptFallback(
	cwd: string,
	record: JsonObject,
	fieldName: string,
	artifactRefs: Map<string, JsonObject>,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<boolean> {
	const exempt = qualityGateObject(record.replayExempt);
	if (!exempt) return false;
	const reasonCode = requiredStringField(exempt, "reasonCode", `${fieldName}.replayExempt`);
	if (!CLI_REPLAY_EXEMPT_REASON_CODE_SET.has(reasonCode))
		throw new Error(
			`qualityGate ${fieldName}.replayExempt.reasonCode must be one of: ${CLI_REPLAY_EXEMPT_REASON_CODE_LIST}`,
		);
	const reason = requiredStringField(exempt, "reason", `${fieldName}.replayExempt`);
	if (!isSubstantiveEvidence(reason) || reason.length < 30)
		throw new Error(`qualityGate ${fieldName}.replayExempt.reason must be audited and substantive`);
	requiredStringField(exempt, "approvedBy", `${fieldName}.replayExempt`);
	const fallbackRefs = requireStringLinks(
		exempt.fallbackArtifactRefs,
		`${fieldName}.replayExempt.fallbackArtifactRefs`,
	);
	requireResolvedLinks(fallbackRefs, artifactRefs, `${fieldName}.replayExempt.fallbackArtifactRefs`);
	let validFallback = false;
	for (const fallbackRef of fallbackRefs) {
		if (fallbackRef === requiredStringField(record, "id", fieldName)) {
			throw new Error(`qualityGate ${fieldName}.replayExempt fallback must not reference the replay record itself`);
		}
		const fallback = artifactRefs.get(fallbackRef)!;
		if (await validateStructuralArtifact(cwd, fallback, `executorQa.artifactRefs.${fallbackRef}`, options))
			validFallback = true;
	}
	if (!validFallback)
		throw new Error(
			`qualityGate ${fieldName}.replayExempt requires at least one structurally-valid fallback artifact`,
		);
	return true;
}
export async function validateCliReplay(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { live: boolean },
): Promise<boolean> {
	const record = await readCliReplayRecord(cwd, row, fieldName);
	if (!record) return false;
	if (record.replayExempt !== undefined) {
		throw new Error(
			`qualityGate ${fieldName}.replayExempt can only be validated from surfaceEvidence with fallback context`,
		);
	}
	void options.live;
	const replay = parseCliReplayRecord(record, fieldName);
	const replayCwd = resolveUnderCwd(cwd, replay.replayCwd, fieldName);
	const process = Bun.spawn(resolveCliReplayCommand(replay.command), {
		cwd: replayCwd,
		env: replay.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			collectCliReplayOutput(process.stdout),
			collectCliReplayOutput(process.stderr),
			waitForReplayProcessWithTimeout(process, replay.timeoutMs),
		]);
		if (stdout.truncated || stderr.truncated)
			throw new Error(`qualityGate ${fieldName} CLI replay output exceeded 1 MiB buffer cap`);
		if (exitCode !== replay.expectedExitCode) {
			throw new Error(
				`qualityGate ${fieldName} CLI replay exit code ${exitCode} did not match expected ${replay.expectedExitCode}`,
			);
		}
		const actualStdout = normalizeCliReplayOutput(stdout.text, cwd);
		const recordedStdout = normalizeCliReplayOutput(replay.recordedStdout, cwd);
		if (!replay.invariants.length || !validateCliReplayInvariants(replay.invariants, actualStdout, fieldName)) {
			if (actualStdout !== recordedStdout) {
				throw new Error(
					`qualityGate ${fieldName} CLI replay stdout did not match recordedStdout after normalization`,
				);
			}
		}
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === "timeout") {
			throw new Error(`qualityGate ${fieldName} CLI replay timed out after ${replay.timeoutMs}ms`);
		}
		throw error;
	}
}

async function hasLiveProofPresence(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	family: SurfaceFamily,
): Promise<boolean> {
	if (await hasExistingNonEmptyArtifact(cwd, row.path)) return true;
	if (family === "cli") {
		const record = await readCliReplayRecord(cwd, row, fieldName);
		if (record) return true;
	}
	return false;
}

export async function validateLiveSurfaceProofPresence(
	cwd: string,
	family: SurfaceFamily,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
): Promise<void> {
	if (!isLiveSurfaceFamily(family)) return;
	for (const artifactId of artifactIds) {
		if (
			await hasLiveProofPresence(cwd, artifactRefs.get(artifactId)!, `executorQa.artifactRefs.${artifactId}`, family)
		)
			return;
	}
	throw new Error(
		`qualityGate ${artifactIds.map(id => `executorQa.artifactRefs.${id}`).join(", ")} must reference a live proof artifact, structural capture, or CLI replay; inlineEvidence and typed verifiedReceipt do not prove live surfaces`,
	);
}
export async function validateSurfaceStructuralRequirement(
	cwd: string,
	family: SurfaceFamily,
	artifactIds: string[],
	artifactRefs: Map<string, JsonObject>,
	fieldName: string,
): Promise<void> {
	if (family !== "web" && family !== "native") return;
	let hasScreenshot = false;
	let hasAutomation = false;
	let hasPty = false;
	for (const artifactId of artifactIds) {
		const artifact = artifactRefs.get(artifactId)!;
		const kind = structuralArtifactKind(artifact);
		if (!kind) continue;
		const valid = await validateStructuralArtifact(cwd, artifact, `executorQa.artifactRefs.${artifactId}`, {
			surfaceFamily: family,
			live: true,
		});
		if (kind === "screenshot" && valid) hasScreenshot = true;
		if (kind === "automation" && valid) hasAutomation = true;
		if (kind === "pty" && valid) hasPty = true;
	}
	if (family === "web" && (!hasScreenshot || !hasAutomation)) {
		throw new Error(
			`qualityGate ${fieldName} for GUI/web surfaces must include a valid automation transcript and non-uniform screenshot`,
		);
	}
	if (family === "native" && !hasScreenshot && !hasAutomation && !hasPty) {
		throw new Error(
			`qualityGate ${fieldName} for native surfaces must include a valid screenshot, PTY capture, or app-automation transcript`,
		);
	}
}

export async function validateArtifactProof(
	cwd: string,
	row: JsonObject,
	fieldName: string,
	options: { surfaceFamily: SurfaceFamily; live: boolean },
): Promise<void> {
	if (await hasExistingNonEmptyArtifact(cwd, row.path)) return;
	if (await validateStructuralArtifact(cwd, row, fieldName, options)) return;
	if (options.surfaceFamily === "cli" && (await validateCliReplay(cwd, row, fieldName, { live: options.live })))
		return;
	if (!options.live && (hasTypedVerifiedReceipt(row.verifiedReceipt) || hasTypedVerifiedReceipt(row.receipt))) return;
	const proofLabel = options.live
		? "a live proof artifact, structural capture, or CLI replay; inlineEvidence and typed verifiedReceipt do not prove live surfaces"
		: "an existing non-empty artifact path or a typed verifiedReceipt; inlineEvidence alone is not sufficient";
	throw new Error(`qualityGate ${fieldName} must reference ${proofLabel}`);
}

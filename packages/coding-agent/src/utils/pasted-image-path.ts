import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;
const CLIPBOARD_TEMP_BASENAME_PATTERN = /^clipboard-\d{4}-\d{2}-\d{2}-\d{6}-[A-Za-z0-9-]+\.(?:png|jpe?g|gif|webp)$/i;

export const MAX_PASTED_IMAGE_COUNT = 16;
export const MAX_PASTED_IMAGE_PASTE_CHARACTERS = 1024 * 1024;
export const MAX_PASTED_IMAGE_PATH_CHARACTERS = 32 * 1024;

export interface DecodePastedPathOptions {
	/** Platform whose path and shell semantics apply. Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
	homedir?: string;
}

export interface ResolvePastedImagePathOptions extends DecodePastedPathOptions {
	/** Base directory for relative paths. Defaults to `process.cwd()`. */
	cwd?: string;
}

export type PastedImagePathParseResult =
	| {
			kind: "paths";
			paths: string[];
			requiresConfirmation: boolean;
	  }
	| {
			kind: "too-many";
			maxCandidates: number;
	  };

type PastedPathListState = "normal" | "escape" | "single-quote" | "double-quote";
type EscapeReturnState = "normal" | "double-quote";

type TokenizePastedPathsResult =
	| { kind: "candidates"; candidates: string[] }
	| { kind: "too-many"; maxCandidates: number; candidates: string[] }
	| { kind: "invalid" };

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
	return platform === "win32" ? path.win32 : path.posix;
}

function decodeFileUrl(candidate: string, platform: NodeJS.Platform, allowRemoteHost: boolean): string | undefined {
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (url.protocol !== "file:") return undefined;
	if (!allowRemoteHost && url.hostname && url.hostname !== "localhost") return undefined;

	if (platform === process.platform) {
		try {
			return fileURLToPath(url);
		} catch {
			return undefined;
		}
	}

	if (/%2f/i.test(url.pathname) || (platform === "win32" && /%5c/i.test(url.pathname))) return undefined;
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return undefined;
	}
	if (platform === "win32") {
		if (url.hostname && url.hostname !== "localhost") {
			return allowRemoteHost ? `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}` : undefined;
		}
		if (!/^\/[A-Za-z]:/.test(pathname)) return undefined;
		return pathname.slice(1).replaceAll("/", "\\");
	}
	if (url.hostname && url.hostname !== "localhost") return undefined;
	return pathname;
}

function isRemoteWindowsPath(candidate: string): boolean {
	return candidate.startsWith("\\\\") || candidate.startsWith("//");
}

function expandHome(candidate: string, options: DecodePastedPathOptions, platform: NodeJS.Platform): string {
	if (!candidate.startsWith("~/")) return candidate;
	return pathApi(platform).join(options.homedir ?? os.homedir(), candidate.slice(2));
}

/** Decode one pasted path candidate without filesystem access. */
export function decodePastedPathCandidate(text: string, options: DecodePastedPathOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	let candidate = text.trim();
	if (!candidate || /[\r\n]/.test(candidate)) return undefined;

	if (
		candidate.length >= 2 &&
		(candidate.startsWith('"') || candidate.startsWith("'")) &&
		candidate.endsWith(candidate[0] ?? "")
	) {
		candidate = candidate.slice(1, -1);
	}

	if (candidate.startsWith("file://")) {
		const decoded = decodeFileUrl(candidate, platform, true);
		if (decoded === undefined) return undefined;
		candidate = decoded;
	} else if (platform !== "win32") {
		candidate = candidate.replace(/\\(.)/g, "$1");
	}
	return expandHome(candidate, options, platform);
}

function isAsciiWhitespace(character: string): boolean {
	return (
		character === " " ||
		character === "\t" ||
		character === "\n" ||
		character === "\r" ||
		character === "\v" ||
		character === "\f"
	);
}

function decodeListToken(
	candidate: string,
	options: DecodePastedPathOptions,
	platform: NodeJS.Platform,
): string | undefined {
	if (candidate.startsWith("file://")) {
		const decoded = decodeFileUrl(candidate, platform, false);
		if (decoded === undefined) return undefined;
		candidate = decoded;
	}
	candidate = expandHome(candidate, options, platform);
	if (platform === "win32" && isRemoteWindowsPath(candidate)) return undefined;
	return candidate;
}

function tokenizePastedPathCandidates(
	text: string,
	options: DecodePastedPathOptions,
	maxCandidates: number,
	requireCompletePayload = false,
): TokenizePastedPathsResult {
	if (text.length > MAX_PASTED_IMAGE_PASTE_CHARACTERS) return { kind: "invalid" };
	const platform = options.platform ?? process.platform;
	const candidates: string[] = [];
	let state: PastedPathListState = "normal";
	let escapeReturnState: EscapeReturnState = "normal";
	let candidate = "";
	let candidateStarted = false;

	const startCandidate = (): TokenizePastedPathsResult | undefined => {
		if (candidateStarted) return undefined;
		if (!requireCompletePayload && candidates.length >= maxCandidates) {
			return { kind: "too-many", maxCandidates, candidates: [...candidates] };
		}
		candidateStarted = true;
		return undefined;
	};

	const appendCandidate = (character: string): boolean => {
		candidate += character;
		return candidate.length <= MAX_PASTED_IMAGE_PATH_CHARACTERS;
	};

	const finishCandidate = (): TokenizePastedPathsResult | undefined => {
		if (!candidateStarted) return undefined;
		if (!candidate) return { kind: "invalid" };
		if (!requireCompletePayload && candidates.length >= maxCandidates) {
			return { kind: "too-many", maxCandidates, candidates: [...candidates] };
		}
		const decoded = decodeListToken(candidate, options, platform);
		if (decoded === undefined) return { kind: "invalid" };
		candidates.push(decoded);
		candidate = "";
		candidateStarted = false;
		return undefined;
	};

	for (const character of text) {
		if (state === "escape") {
			if (!appendCandidate(character)) return { kind: "invalid" };
			state = escapeReturnState;
			continue;
		}
		if (state === "single-quote") {
			if (character === "'") state = "normal";
			else if (!appendCandidate(character)) return { kind: "invalid" };
			continue;
		}
		if (state === "double-quote") {
			if (character === '"') {
				state = "normal";
			} else if (character === "\\" && platform !== "win32") {
				escapeReturnState = "double-quote";
				state = "escape";
			} else if (!appendCandidate(character)) {
				return { kind: "invalid" };
			}
			continue;
		}

		if (isAsciiWhitespace(character)) {
			const result = finishCandidate();
			if (result) return result;
		} else if (character === "'") {
			const result = startCandidate();
			if (result) return result;
			state = "single-quote";
		} else if (character === '"') {
			const result = startCandidate();
			if (result) return result;
			state = "double-quote";
		} else if (character === "\\" && platform !== "win32") {
			const result = startCandidate();
			if (result) return result;
			escapeReturnState = "normal";
			state = "escape";
		} else {
			const result = startCandidate();
			if (result) return result;
			if (!appendCandidate(character)) return { kind: "invalid" };
		}
	}

	if (state !== "normal") return { kind: "invalid" };
	const finalResult = finishCandidate();
	if (finalResult) return finalResult;
	if (candidates.length > maxCandidates) return { kind: "too-many", maxCandidates, candidates };
	return candidates.length === 0 ? { kind: "invalid" } : { kind: "candidates", candidates };
}

/** Tokenize a bounded complete path list without filesystem access. */
export function decodePastedPathCandidates(
	text: string,
	options: DecodePastedPathOptions = {},
	maxCandidates = MAX_PASTED_IMAGE_COUNT,
): string[] | undefined {
	const result = tokenizePastedPathCandidates(text, options, maxCandidates);
	return result.kind === "candidates" ? result.candidates : undefined;
}

function resolveCandidate(
	candidate: string,
	options: ResolvePastedImagePathOptions,
	platform: NodeJS.Platform,
): string {
	return pathApi(platform).resolve(options.cwd ?? process.cwd(), candidate);
}

function isRecognizedClipboardTempPath(filePath: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const resolved = api.resolve(filePath);
	const tempRoot = api.resolve(os.tmpdir());
	if (resolved !== tempRoot && !resolved.startsWith(`${tempRoot}${api.sep}`)) return false;
	return CLIPBOARD_TEMP_BASENAME_PATTERN.test(api.basename(resolved));
}

/** Resolve one recognized clipboard-temp image path lexically, before any filesystem access. */
export function resolvePastedImagePath(text: string, options: ResolvePastedImagePathOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	const terminalNewlinesTrimmed = text.replace(/(?:\r\n|\r|\n)+$/, "");
	if (/\r|\n/.test(terminalNewlinesTrimmed)) return undefined;
	const candidates = decodePastedPathCandidates(terminalNewlinesTrimmed, options, 1);
	if (candidates?.length !== 1) return undefined;
	const candidate = candidates[0];
	if (!IMAGE_FILE_EXTENSION_PATTERN.test(candidate)) return undefined;
	if (platform === "win32" && isRemoteWindowsPath(candidate)) return undefined;
	const resolved = resolveCandidate(candidate, options, platform);
	return isRecognizedClipboardTempPath(resolved, platform) ? resolved : undefined;
}

/**
 * Parse a complete image path paste without filesystem access. A single path
 * keeps the clipboard-temp-only policy; multi-path saved-image pastes require
 * explicit confirmation before any path is opened.
 */
export function parsePastedImagePaths(
	text: string,
	options: ResolvePastedImagePathOptions = {},
): PastedImagePathParseResult | undefined {
	const platform = options.platform ?? process.platform;
	const tokenized = tokenizePastedPathCandidates(text, options, MAX_PASTED_IMAGE_COUNT, true);
	if (tokenized.kind === "too-many") {
		if (
			tokenized.candidates.some(
				candidate =>
					!IMAGE_FILE_EXTENSION_PATTERN.test(candidate) ||
					(platform === "win32" && isRemoteWindowsPath(candidate)),
			)
		) {
			return undefined;
		}
		return { kind: "too-many", maxCandidates: tokenized.maxCandidates };
	}
	if (tokenized.kind !== "candidates") return undefined;

	if (tokenized.candidates.length === 1) {
		const resolved = resolvePastedImagePath(text, options);
		return resolved ? { kind: "paths", paths: [resolved], requiresConfirmation: false } : undefined;
	}

	const paths: string[] = [];
	for (const candidate of tokenized.candidates) {
		if (!IMAGE_FILE_EXTENSION_PATTERN.test(candidate)) return undefined;
		if (platform === "win32" && isRemoteWindowsPath(candidate)) return undefined;
		paths.push(resolveCandidate(candidate, options, platform));
	}
	return { kind: "paths", paths, requiresConfirmation: true };
}

export function formatPastedImageReference(placeholder: string, imagePath: string): string {
	return `${placeholder} source=${JSON.stringify(imagePath)}`;
}

import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const TOP_LEVEL_INTERNAL_URL_PREFIXES = ["agent://", "artifact://", "rule://", "local://"] as const;

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);
	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		path.win32.isAbsolute(withoutAt) ||
		withoutAt.startsWith("agent://") ||
		withoutAt.startsWith("artifact://") ||
		withoutAt.startsWith("rule://") ||
		withoutAt.startsWith("local:")
	) {
		return withoutAt;
	}

	return filePath;
}

function expandPath(filePath: string): string {
	const normalized = normalizeAtPrefix(filePath).replace(UNICODE_SPACES, " ");
	if (normalized.toLowerCase().startsWith("file://")) {
		try {
			return expandTilde(url.fileURLToPath(normalized));
		} catch {
			return normalized;
		}
	}
	return expandTilde(normalized);
}

function expandTilde(filePath: string): string {
	const home = os.homedir();
	if (filePath === "~") return home;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return home + filePath.slice(1);
	if (filePath.startsWith("~")) return path.join(home, filePath.slice(1));
	return filePath;
}

function normalizeLocalScheme(filePath: string): string {
	return filePath.replace(/^(local:)\/(?!\/)/, "$1//");
}

/** Resolve filesystem-only worker inputs without evaluating the broad path utility module. */
export function resolveTabWorkerPath(filePath: string, cwd: string): string {
	const normalized = normalizeLocalScheme(filePath);
	const expanded = expandPath(normalized);
	const expandedAndNormalized = normalizeLocalScheme(expanded);
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expandedAndNormalized.startsWith(prefix)) {
			throw new Error(
				`Path "${normalized}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}

	if (/^\/+$/u.test(expanded)) return cwd;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

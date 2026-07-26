/**
 * Per-repo review config, fetched from the PR **base** branch (e.g.
 * `.gjc-review.yml`). Never load this from the PR head: config keys flow
 * into the review prompt, so head-loading would let any fork PR inject
 * instructions into its own review.
 *
 * Supported keys: enabled(bool), max_comments(int), tone(str),
 * ignore_paths(list[str]), pr_summary(bool), diagrams(bool), poem(bool),
 * path_instructions(list[{path, instructions}]).
 *
 * The parser is a deliberate YAML subset (flat scalars, simple lists, lists
 * of small maps) so the bot stays dependency-free; unknown shapes degrade to
 * "no config" rather than failing a review.
 */
import type { GithubApi } from "./github";

export interface RepoReviewConfig {
	enabled?: boolean;
	max_comments?: number;
	tone?: string;
	ignore_paths?: string[];
	pr_summary?: boolean;
	diagrams?: boolean;
	poem?: boolean;
	path_instructions?: Array<{ path?: string; instructions?: string }>;
	[key: string]: unknown;
}

function scalar(raw: string): string | number | boolean {
	const v = raw.trim().replace(/^["']|["']$/g, "");
	if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
	if (/^-?\d+$/.test(v)) return Number(v);
	return v;
}

/** Tiny YAML subset parser — see module doc for the supported shapes. */
export function parseMinimalYaml(text: string): Record<string, unknown> {
	const doc: Record<string, unknown> = {};
	let currentList: string | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		const s = line.trim();
		if (!s || s.startsWith("#")) continue;
		const list = currentList !== null ? doc[currentList] : undefined;
		if (s.startsWith("- ") && Array.isArray(list)) {
			const item = s.slice(2).trim();
			const colon = item.indexOf(":");
			if (colon > 0) {
				// list-of-maps item: `- path: "x"`
				list.push({ [item.slice(0, colon).trim()]: scalar(item.slice(colon + 1)) });
			} else {
				list.push(item.replace(/^["']|["']$/g, ""));
			}
			continue;
		}
		if (/^[ \t]/.test(line) && s.includes(":") && Array.isArray(list) && list.length > 0) {
			const last = list[list.length - 1];
			if (typeof last === "object" && last !== null && !Array.isArray(last)) {
				// continuation key of the current map item: `  instructions: ...`
				const colon = s.indexOf(":");
				(last as Record<string, unknown>)[s.slice(0, colon).trim()] = scalar(s.slice(colon + 1));
				continue;
			}
		}
		if (line.includes(":") && !/^[ \t]/.test(line)) {
			const colon = line.indexOf(":");
			const key = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			if (value === "") {
				doc[key] = [];
				currentList = key;
				continue;
			}
			currentList = null;
			if (value.startsWith("[") && value.endsWith("]")) {
				doc[key] = value
					.slice(1, -1)
					.split(",")
					.map(x => x.trim().replace(/^["']|["']$/g, ""))
					.filter(x => x.length > 0);
			} else {
				doc[key] = scalar(value);
			}
		}
	}
	return doc;
}

/**
 * Load the repo config file at `ref`. Returns {} on absence or any failure —
 * a broken config file must never block reviews.
 */
export async function loadRepoConfig(
	api: GithubApi,
	token: string,
	repo: string,
	ref: string,
	fileName: string,
): Promise<RepoReviewConfig> {
	if (!token) return {};
	const res = await api.tryRequest<{ content?: string }>(
		`/repos/${repo}/contents/${encodeURIComponent(fileName)}?ref=${encodeURIComponent(ref)}`,
		{ token, timeoutMs: 5000 },
	);
	if (!res?.content) return {};
	try {
		return parseMinimalYaml(Buffer.from(res.content, "base64").toString("utf8")) as RepoReviewConfig;
	} catch {
		return {};
	}
}

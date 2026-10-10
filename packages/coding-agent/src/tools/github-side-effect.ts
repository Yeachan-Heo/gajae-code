/**
 * Classify `github` tool operations for the approval gate and the planning
 * mutation guard. Read-only ops stay available. Every other op, including a
 * missing or unrecognized one, is a side effect and fails closed.
 */
import type { AgentTool } from "@gajae-code/agent-core";

/** Name-only tool the planning guard uses when `GithubTool.execute` checks itself. */
export const githubMutationTool = {
	name: "github",
	label: "GitHub",
	description: "github",
	parameters: {},
	execute: async () => ({ content: [] }),
} as AgentTool;

const GITHUB_READ_ONLY_OPS = new Set([
	"repo_view",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

const GITHUB_SIDE_EFFECT_OPS = new Set(["pr_create", "pr_checkout", "pr_push"]);

const TITLE_MAX = 160;

function recordOf(args: unknown): Record<string, unknown> | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	return args as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function clip(value: string): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= TITLE_MAX) return cleaned;
	return `${cleaned.slice(0, TITLE_MAX - 1)}…`;
}

function formatPr(value: unknown): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (!Array.isArray(value)) return "the current pull request";
	const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return parts.length > 0 ? parts.join(", ") : "the current pull request";
}

export function githubOp(args: unknown): string | undefined {
	const op = recordOf(args)?.op;
	return typeof op === "string" ? op : undefined;
}

/** True only for a known read-only github op. Missing and unknown ops are not read-only. */
export function isGithubReadOnlyArgs(args: unknown): boolean {
	const op = githubOp(args);
	return op !== undefined && GITHUB_READ_ONLY_OPS.has(op);
}

export function isGithubReadOnlyOp(op: string): boolean {
	return GITHUB_READ_ONLY_OPS.has(op);
}

/**
 * Approval summary for a side-effect github call. The PR body is omitted so a
 * token pasted into `body` is not copied into the permission title.
 */
export function describeGithubSideEffect(args: unknown): string {
	const record = recordOf(args);
	const op = githubOp(args) ?? "";
	if (op === "pr_push") {
		const branch = stringField(record, "branch") ?? "the current branch";
		const lease = record?.forceWithLease === true ? " with --force-with-lease" : "";
		return clip(`Push ${branch} to its pull request branch${lease} using stored git credentials`);
	}
	if (op === "pr_checkout") {
		const force = record?.force === true ? " and reset the local branch" : "";
		return clip(
			`Check out ${formatPr(record?.pr)} into ~/.gjc/wt, write branch git config, and may add a remote${force}`,
		);
	}
	if (op === "pr_create") {
		const repo = stringField(record, "repo") ?? "the current repository";
		const head = stringField(record, "head") ?? "the current branch";
		const base = stringField(record, "base") ?? "the default base";
		return clip(`Create a pull request on ${repo} from ${head} into ${base} with gh`);
	}
	return "Run a github operation that is not read-only";
}

export function githubPermissionIntent(
	args: unknown,
): { toolName: string; title: string; cacheKey: string } | undefined {
	if (isGithubReadOnlyArgs(args)) return undefined;
	const op = githubOp(args);
	const cacheOp = op && GITHUB_SIDE_EFFECT_OPS.has(op) ? op : "unspecified";
	return {
		toolName: "github",
		title: describeGithubSideEffect(args),
		cacheKey: `github:${cacheOp}`,
	};
}

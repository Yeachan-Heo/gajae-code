import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";

import { getWorktreeDir, hashPath, isEnoent, prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { Settings } from "../config/settings";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { formatShortSha } from "./gh-format";
import { type CacheStatus, getOrFetchView, resolveGithubCacheAuthKey } from "./github-cache";
import type { OutputMeta } from "./output-meta";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];
const GH_ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"body",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];
const GH_PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
];

const PR_CHECKOUT_BRANCH_CONFIG = {
	headRef: "gjcPrHeadRef",
	url: "gjcPrUrl",
	isCrossRepository: "gjcPrIsCrossRepository",
	maintainerCanModify: "gjcPrMaintainerCanModify",
} as const;

const LEGACY_PR_CHECKOUT_BRANCH_CONFIG = {
	headRef: "ompPrHeadRef",
	url: "ompPrUrl",
	isCrossRepository: "ompPrIsCrossRepository",
	maintainerCanModify: "ompPrMaintainerCanModify",
} as const;

type PrCheckoutBranchConfigKey = keyof typeof PR_CHECKOUT_BRANCH_CONFIG;

async function getPrCheckoutBranchConfig(
	repoRoot: string,
	localBranch: string,
	key: PrCheckoutBranchConfigKey,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return (
		(await git.config.getBranch(repoRoot, localBranch, PR_CHECKOUT_BRANCH_CONFIG[key], signal)) ??
		(await git.config.getBranch(repoRoot, localBranch, LEGACY_PR_CHECKOUT_BRANCH_CONFIG[key], signal))
	);
}
// /search/<endpoint> API response shapes (subset). Used when projecting raw
// REST results into the normalized `GhSearch*Result` shapes the formatters
// consume. We talk to the API directly because `gh search prs`/`issues`
// quotes multi-token positional queries (`is:"merged is:pr"`) and returns 0
// hits — see https://github.com/cli/cli for the upstream regression.
interface GhApiSearchResponse<T> {
	total_count?: number;
	incomplete_results?: boolean;
	items?: T[];
}
interface GhApiUser {
	login?: string;
	name?: string | null;
}
interface GhApiLabel {
	name?: string;
}
interface GhApiPullRequestRef {
	merged_at?: string | null;
}
interface GhApiSearchIssueItem {
	number?: number;
	title?: string;
	state?: string;
	state_reason?: string | null;
	user?: GhApiUser | null;
	labels?: GhApiLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
	repository_url?: string;
	pull_request?: GhApiPullRequestRef | null;
}
interface GhApiSearchCodeItem {
	name?: string;
	path?: string;
	sha?: string;
	html_url?: string;
	repository?: { full_name?: string } | null;
	text_matches?: Array<{ fragment?: string; property?: string }>;
}
interface GhApiSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}
interface GhApiSearchCommitItem {
	sha?: string;
	node_id?: string;
	html_url?: string;
	author?: GhApiUser | null;
	committer?: GhApiUser | null;
	commit?: {
		author?: GhApiSearchCommitGitActor | null;
		committer?: GhApiSearchCommitGitActor | null;
		message?: string;
	} | null;
	repository?: { full_name?: string } | null;
}
interface GhApiSearchRepoItem {
	full_name?: string;
	description?: string | null;
	language?: string | null;
	stargazers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	archived?: boolean;
	fork?: boolean;
	private?: boolean;
	visibility?: string | null;
	updated_at?: string;
	created_at?: string;
	html_url?: string;
	owner?: GhApiUser | null;
}
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const FILE_PREVIEW_LIMIT = 50;
const RUN_WATCH_INTERVAL_DEFAULT = 3;
const RUN_WATCH_GRACE_DEFAULT = 5;
const RUN_WATCH_TAIL_DEFAULT = 15;
const RUN_WATCH_TAIL_MAX = 200;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const RUN_JOBS_PAGE_SIZE = 100;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/.*)?$/;
const RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RUN_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

const githubSchema = z
	.object({
		op: z
			.enum([
				"repo_view",
				"pr_create",
				"pr_checkout",
				"pr_push",
				"search_issues",
				"search_prs",
				"search_code",
				"search_commits",
				"search_repos",
				"run_watch",
			] as const)
			.describe("github operation"),
		repo: z.string().describe("owner/repo").optional(),
		branch: z.string().describe("branch").optional(),
		pr: z
			.union([z.string(), z.array(z.string())])
			.describe("pr number, url, or branch")
			.optional(),
		force: z.boolean().describe("reset existing local branch").optional(),
		forceWithLease: z.boolean().describe("force-with-lease push").optional(),
		title: z.string().describe("pr title").optional(),
		body: z.string().describe("pr body markdown").optional(),
		base: z.string().describe("pr base branch").optional(),
		head: z.string().describe("pr head branch").optional(),
		draft: z.boolean().describe("open pr as draft").optional(),
		fill: z.boolean().describe("auto-fill pr title/body from commits").optional(),
		reviewer: z.array(z.string()).describe("reviewers").optional(),
		assignee: z.array(z.string()).describe("assignees").optional(),
		label: z.array(z.string()).describe("labels").optional(),
		query: z.string().describe("search query").optional(),
		since: z.string().describe("lower-bound date filter").optional(),
		until: z.string().describe("upper-bound date filter").optional(),
		dateField: z
			.enum(["created", "updated"] as const)
			.describe("date field")
			.default("created")
			.optional(),
		limit: z.number().default(10).describe("max results").optional(),
		run: z.string().describe("actions run id or url").optional(),
		tail: z.number().default(15).describe("log lines per failed job").optional(),
	})
	.strict();

type GithubInput = z.infer<typeof githubSchema>;

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

interface GhUser {
	login?: string;
	name?: string | null;
}

interface GhLabel {
	name?: string;
}

interface GhComment {
	author?: GhUser | null;
	body?: string;
	createdAt?: string;
	url?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
}

interface GhRepoTopic {
	name?: string;
	topic?: { name?: string };
}

interface GhRepoLanguage {
	name?: string;
}

interface GhRepoBranch {
	name?: string;
}

interface GhRepoViewData {
	nameWithOwner?: string;
	description?: string | null;
	url?: string;
	sshUrl?: string;
	defaultBranchRef?: GhRepoBranch | null;
	homepageUrl?: string | null;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: GhRepoLanguage | null;
	repositoryTopics?: GhRepoTopic[];
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string | null;
	visibility?: string | null;
}

interface GhIssueViewData {
	author?: GhUser | null;
	body?: string | null;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string | null;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhPrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

interface GhPrViewData extends GhIssueViewData {
	baseRefName?: string;
	files?: GhPrFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: GhRepoViewData | null;
	headRepositoryOwner?: GhUser | null;
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewComments?: GhPrReviewComment[];
	reviews?: GhPrReview[];
	reviewDecision?: string;
}

interface GhPrReviewCommit {
	oid?: string | null;
}

interface GhPrReview {
	author?: GhUser | null;
	body?: string | null;
	commit?: GhPrReviewCommit | null;
	state?: string | null;
	submittedAt?: string | null;
}

interface GhPrReviewCommentApi {
	body?: string | null;
	created_at?: string | null;
	html_url?: string | null;
	id?: number;
	in_reply_to_id?: number | null;
	line?: number | null;
	original_line?: number | null;
	path?: string | null;
	side?: string | null;
	user?: GhUser | null;
}

interface GhPrReviewComment {
	author?: GhUser | null;
	body?: string | null;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	line?: number;
	originalLine?: number;
	path?: string;
	side?: string;
	url?: string;
}

interface GhBranchApiResponse {
	commit?: {
		sha?: string | null;
	} | null;
}

interface GhSearchRepository {
	nameWithOwner?: string;
}

interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhSearchCodeTextMatch {
	fragment?: string;
	property?: string;
}

interface GhSearchCodeResult {
	path?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	textMatches?: GhSearchCodeTextMatch[];
	url?: string;
}

interface GhSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

interface GhSearchCommitDetail {
	author?: GhSearchCommitGitActor | null;
	committer?: GhSearchCommitGitActor | null;
	message?: string;
}

interface GhSearchCommitResult {
	author?: GhUser | null;
	commit?: GhSearchCommitDetail | null;
	committer?: GhUser | null;
	id?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	url?: string;
}

interface GhSearchRepoResult {
	createdAt?: string;
	description?: string | null;
	forksCount?: number;
	fullName?: string;
	isArchived?: boolean;
	isFork?: boolean;
	isPrivate?: boolean;
	language?: string | null;
	openIssuesCount?: number;
	owner?: GhUser | null;
	stargazersCount?: number;
	updatedAt?: string;
	url?: string;
	visibility?: string | null;
}

interface GhRunReference {
	repo?: string;
	runId?: number;
}

interface GhActionsRunListResponse {
	workflow_runs?: GhActionsRunApi[];
}

interface GhActionsRunApi {
	id?: number;
	name?: string | null;
	display_title?: string | null;
	status?: string | null;
	conclusion?: string | null;
	head_branch?: string | null;
	head_sha?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	html_url?: string | null;
}

interface GhActionsJobsResponse {
	total_count?: number;
	jobs?: GhActionsJobApi[];
}

interface GhActionsJobApi {
	id?: number;
	name?: string | null;
	status?: string | null;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	html_url?: string | null;
}

interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

function looksLikeGitHubUrl(value: string | undefined): boolean {
	return value?.startsWith("https://github.com/") ?? false;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePrIdentifierList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? [value] : value;
	const cleaned: string[] = [];
	for (const entry of raw) {
		const trimmed = entry?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	return cleaned;
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit must be a positive number");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

function resolveTailLimit(value: number | undefined): number {
	if (value === undefined) {
		return RUN_WATCH_TAIL_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("tail must be a positive number");
	}

	return Math.min(Math.floor(value), RUN_WATCH_TAIL_MAX);
}

function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	if (!repo || looksLikeGitHubUrl(identifier)) {
		return;
	}

	args.push("--repo", repo);
}

const REPO_API_URL_PREFIX = "https://api.github.com/repos/";

const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

/**
 * Resolve a search date bound to a GitHub-search-compatible literal. Returns
 * either a `YYYY-MM-DD` date (relative durations and date-only inputs) or a
 * full ISO 8601 datetime string (datetime inputs), so the caller can drop it
 * straight into a qualifier like `created:>=<value>`.
 */
export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new ToolError("date bound must not be empty");
	}

	const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
	if (relMatch) {
		const count = Number(relMatch[1]);
		const unit = relMatch[2].toLowerCase();
		const fixedMs = FIXED_UNIT_MS[unit];
		let bound: Date;
		if (fixedMs !== undefined) {
			bound = new Date(now.getTime() - count * fixedMs);
		} else {
			bound = new Date(now);
			if (unit === "mo") {
				bound.setUTCMonth(bound.getUTCMonth() - count);
			} else {
				bound.setUTCFullYear(bound.getUTCFullYear() - count);
			}
		}
		return bound.toISOString().slice(0, 10);
	}

	if (ISO_DATE_PATTERN.test(trimmed)) {
		return trimmed;
	}

	const parsedMs = Date.parse(trimmed);
	if (!Number.isNaN(parsedMs)) {
		return new Date(parsedMs).toISOString();
	}

	throw new ToolError(
		`invalid date bound: ${raw}. Expected a relative duration like "3d", "12h", "2w", an ISO date "YYYY-MM-DD", or an ISO datetime.`,
	);
}

/**
 * Build the GitHub-search qualifier (e.g. `created:>=2026-05-09`) for the
 * provided bounds, or `undefined` if neither bound is set.
 */
export function buildSearchDateQualifier(
	field: string,
	since: string | undefined,
	until: string | undefined,
	now?: Date,
): string | undefined {
	const sinceVal = since ? parseSearchDateBound(since, now) : undefined;
	const untilVal = until ? parseSearchDateBound(until, now) : undefined;
	if (sinceVal && untilVal) {
		return `${field}:${sinceVal}..${untilVal}`;
	}
	if (sinceVal) {
		return `${field}:>=${sinceVal}`;
	}
	if (untilVal) {
		return `${field}:<=${untilVal}`;
	}
	return undefined;
}

function resolveSearchDateField(
	command: "issues" | "prs" | "commits" | "repos",
	requested: "created" | "updated" | undefined,
): string {
	if (command === "commits") {
		return "committer-date";
	}
	const dateField = requested ?? "created";
	if (command === "repos" && dateField === "updated") {
		return "pushed";
	}
	return dateField;
}

function composeSearchQuery(parts: ReadonlyArray<string | undefined>): string {
	const cleaned: string[] = [];
	for (const part of parts) {
		const trimmed = part?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	if (cleaned.length === 0) {
		throw new ToolError("query is required (or pass since/until to filter by date)");
	}
	return cleaned.join(" ");
}

function buildGhApiSearchArgs(
	endpoint: "issues" | "code" | "commits" | "repositories",
	query: string,
	limit: number,
	extraHeaders?: ReadonlyArray<string>,
): string[] {
	const args = ["api", "-X", "GET", `/search/${endpoint}`, "-f", `q=${query}`, "-F", `per_page=${limit}`];
	for (const header of extraHeaders ?? []) {
		args.push("-H", header);
	}
	return args;
}

function repoFromRepositoryUrl(value: string | undefined): string | undefined {
	if (!value?.startsWith(REPO_API_URL_PREFIX)) return undefined;
	return value.slice(REPO_API_URL_PREFIX.length);
}

function apiUserToGhUser(user: GhApiUser | null | undefined): GhUser | undefined {
	if (!user) return undefined;
	const login = user.login ?? undefined;
	const name = user.name ?? undefined;
	if (login === undefined && name === undefined) return undefined;
	return { login, name };
}

function apiLabelsToGhLabels(labels: GhApiLabel[] | undefined): GhLabel[] {
	return labels?.map(label => ({ name: label.name })) ?? [];
}

function apiIssueToSearchResult(item: GhApiSearchIssueItem): GhSearchResult {
	const merged = Boolean(item.pull_request?.merged_at);
	return {
		author: apiUserToGhUser(item.user) ?? null,
		createdAt: item.created_at,
		labels: apiLabelsToGhLabels(item.labels),
		number: item.number,
		repository: { nameWithOwner: repoFromRepositoryUrl(item.repository_url) },
		state: merged ? "merged" : item.state,
		title: item.title,
		updatedAt: item.updated_at,
		url: item.html_url,
	};
}

function apiCodeToSearchResult(item: GhApiSearchCodeItem): GhSearchCodeResult {
	return {
		path: item.path,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		textMatches: item.text_matches?.map(match => ({ fragment: match.fragment, property: match.property })),
		url: item.html_url,
	};
}

function apiCommitToSearchResult(item: GhApiSearchCommitItem): GhSearchCommitResult {
	return {
		author: apiUserToGhUser(item.author) ?? null,
		commit: item.commit
			? {
					author: item.commit.author ?? null,
					committer: item.commit.committer ?? null,
					message: item.commit.message,
				}
			: null,
		committer: apiUserToGhUser(item.committer) ?? null,
		id: item.node_id,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		url: item.html_url,
	};
}

function apiRepoToSearchResult(item: GhApiSearchRepoItem): GhSearchRepoResult {
	return {
		createdAt: item.created_at,
		description: item.description,
		forksCount: item.forks_count,
		fullName: item.full_name,
		isArchived: item.archived,
		isFork: item.fork,
		isPrivate: item.private,
		language: item.language,
		openIssuesCount: item.open_issues_count,
		owner: apiUserToGhUser(item.owner) ?? null,
		stargazersCount: item.stargazers_count,
		updatedAt: item.updated_at,
		url: item.html_url,
		visibility: item.visibility ?? null,
	};
}

function sanitizeRemoteName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized.length > 0 ? `fork-${sanitized}` : "fork";
}

/** Maximum disambiguation suffixes we try before giving up on a worktree path. */
const WORKTREE_PATH_MAX_SUFFIX = 100;

function toLocalBranchRef(value: string): string {
	return `refs/heads/${value}`;
}

async function requireGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(cwd, signal);
	if (!repoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return repoRoot;
}

async function requirePrimaryGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const primaryRepoRoot = await git.repo.primaryRoot(cwd, signal);
	if (!primaryRepoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return primaryRepoRoot;
}

async function requireCurrentGitBranch(cwd: string, signal?: AbortSignal): Promise<string> {
	const branch = await git.branch.current(cwd, signal);
	if (!branch) {
		throw new ToolError("Current git branch is unavailable. Pass `branch` or `run` explicitly.");
	}

	return branch;
}

async function requireCurrentGitHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const headSha = await git.head.sha(cwd, signal);
	if (!headSha) {
		throw new ToolError("Current git HEAD is unavailable. Pass `run` explicitly.");
	}

	return headSha;
}

/**
 * Resolve a worktree path that is free of conflicts.
 *
 * Given a `basePath`, return either `basePath` itself or `${basePath}-2`,
 * `${basePath}-3`, … up to {@link WORKTREE_PATH_MAX_SUFFIX} — whichever is the
 * first variant that is **not** registered with git as another worktree and
 * **not** present on disk. The numeric tail salvages two rare cases that
 * would otherwise abort a checkout: stale leftover dirs from an interrupted
 * `git worktree add`, and the (vanishingly unlikely) `hashPath` collision
 * between two repos that happen to produce the same 7-hex digest.
 */
async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) {
				return candidate;
			}
			throw error;
		}
	}
	throw new ToolError(
		`could not find an unused worktree path under ${basePath} (tried ${WORKTREE_PATH_MAX_SUFFIX} suffixes)`,
	);
}

function selectPrCloneUrl(originUrl: string | undefined, repo: Pick<GhRepoViewData, "url" | "sshUrl">): string {
	if (originUrl?.startsWith("http://") || originUrl?.startsWith("https://")) {
		return normalizeOptionalString(repo.url) ?? normalizeOptionalString(repo.sshUrl) ?? "";
	}

	return normalizeOptionalString(repo.sshUrl) ?? normalizeOptionalString(repo.url) ?? "";
}

async function getRemoteUrls(repoRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const remotes = await git.remote.list(repoRoot, signal);
	const urls = new Map<string, string>();
	for (const remoteName of remotes) {
		const remoteUrl = await git.remote.url(repoRoot, remoteName, signal);
		if (remoteUrl) {
			urls.set(remoteName, remoteUrl);
		}
	}
	return urls;
}

async function ensurePrRemote(
	repoRoot: string,
	data: GhPrViewData,
	signal?: AbortSignal,
): Promise<{ name: string; url: string }> {
	if (!data.isCrossRepository) {
		const originUrl = await git.remote.url(repoRoot, "origin", signal);
		if (!originUrl) {
			throw new ToolError("origin remote is unavailable for this repository.");
		}

		return {
			name: "origin",
			url: originUrl,
		};
	}

	const headRepository = requireNonEmpty(data.headRepository?.nameWithOwner, "head repository");
	const repoSummary = await git.github.json<GhRepoViewData>(
		repoRoot,
		["repo", "view", headRepository, "--json", GH_REPO_CLONE_FIELDS.join(",")],
		signal,
		{ repoProvided: true },
	);
	const originUrl = await git.remote.url(repoRoot, "origin", signal);
	const remoteUrl = selectPrCloneUrl(originUrl, repoSummary);
	if (!remoteUrl) {
		throw new ToolError(`Could not determine a clone URL for ${headRepository}.`);
	}

	const remotes = await getRemoteUrls(repoRoot, signal);
	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) {
			return { name: remoteName, url };
		}
	}

	const preferredRemoteName = sanitizeRemoteName(
		data.headRepositoryOwner?.login ?? headRepository.split("/")[0] ?? "fork",
	);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}

	await git.remote.add(repoRoot, remoteName, remoteUrl, signal);

	return {
		name: remoteName,
		url: remoteUrl,
	};
}

async function resolvePrBranchPushTarget(
	repoRoot: string,
	localBranch: string,
	signal?: AbortSignal,
): Promise<{
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	maintainerCanModify?: boolean;
	isCrossRepository: boolean;
}> {
	const headRef = await getPrCheckoutBranchConfig(repoRoot, localBranch, "headRef", signal);
	if (!headRef) {
		throw new ToolError(`branch ${localBranch} has no PR push metadata; check it out via op: pr_checkout first`);
	}

	const pushRemote = await git.config.getBranch(repoRoot, localBranch, "pushRemote", signal);
	const remote = await git.config.getBranch(repoRoot, localBranch, "remote", signal);
	const prUrl = await getPrCheckoutBranchConfig(repoRoot, localBranch, "url", signal);
	const maintainerCanModifyValue = await getPrCheckoutBranchConfig(
		repoRoot,
		localBranch,
		"maintainerCanModify",
		signal,
	);
	const isCrossRepositoryValue = await getPrCheckoutBranchConfig(repoRoot, localBranch, "isCrossRepository", signal);

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`branch ${localBranch} has no configured push remote`);
	}

	return {
		remoteName,
		remoteBranch: headRef,
		remoteUrl: await git.remote.url(repoRoot, remoteName, signal),
		prUrl,
		maintainerCanModify:
			maintainerCanModifyValue === undefined
				? undefined
				: ["1", "true", "yes", "on"].includes(maintainerCanModifyValue.toLowerCase()),
		isCrossRepository: ["1", "true", "yes", "on"].includes((isCrossRepositoryValue ?? "").toLowerCase()),
	};
}

function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

function parseRunReference(value: string | undefined): GhRunReference {
	const run = normalizeOptionalString(value);
	if (!run) {
		return {};
	}

	if (/^\d+$/.test(run)) {
		return { runId: Number(run) };
	}

	const match = run.match(RUN_URL_PATTERN);
	if (!match) {
		throw new ToolError("run must be a numeric workflow run ID or a full GitHub Actions run URL");
	}

	return {
		repo: match[1],
		runId: Number(match[2]),
	};
}

function parsePullRequestUrl(value: string | undefined): { repo?: string; prNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		return {};
	}

	const match = normalized.match(PR_URL_PATTERN);
	if (!match) {
		return {};
	}

	return {
		repo: match[1],
		prNumber: Number(match[2]),
	};
}

/**
 * Parse a digit-only decimal positive integer or return undefined. Rejects
 * `1e2`, `0x10`, `12.0`, leading +/-, or any other shape `Number()` would
 * accept — those would otherwise key the cache against the wrong row.
 */
export function parsePositiveDecimalInt(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num <= 0) return undefined;
	return num;
}

function parseIssueUrl(value: string | undefined): { repo?: string; issueNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return {};
	const match = normalized.match(ISSUE_URL_PATTERN);
	if (!match) return {};
	return {
		repo: match[1],
		issueNumber: Number(match[2]),
	};
}

function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

function normalizeRunJob(job: GhActionsJobApi): GhRunJobSnapshot | null {
	if (typeof job.id !== "number") {
		return null;
	}

	return {
		id: job.id,
		name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
		status: normalizeOptionalString(job.status),
		conclusion: normalizeOptionalString(job.conclusion),
		startedAt: normalizeOptionalString(job.started_at),
		completedAt: normalizeOptionalString(job.completed_at),
		url: normalizeOptionalString(job.html_url),
	};
}

function normalizeRunSnapshot(run: GhActionsRunApi, jobs: GhRunJobSnapshot[]): GhRunSnapshot {
	if (typeof run.id !== "number") {
		throw new ToolError("GitHub Actions run response did not include a run ID.");
	}

	return {
		id: run.id,
		workflowName: normalizeOptionalString(run.name),
		displayTitle: normalizeOptionalString(run.display_title),
		status: normalizeOptionalString(run.status),
		conclusion: normalizeOptionalString(run.conclusion),
		branch: normalizeOptionalString(run.head_branch),
		headSha: normalizeOptionalString(run.head_sha),
		createdAt: normalizeOptionalString(run.created_at),
		updatedAt: normalizeOptionalString(run.updated_at),
		url: normalizeOptionalString(run.html_url),
		jobs,
	};
}

function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
	if (!value) {
		return "pending";
	}

	if (RUN_SUCCESS_CONCLUSIONS.has(value)) {
		return "success";
	}

	if (RUN_FAILURE_CONCLUSIONS.has(value)) {
		return "failure";
	}

	return "pending";
}

function getRunSnapshotOutcome(run: GhRunSnapshot): "success" | "failure" | "pending" {
	if (run.status !== "completed") {
		return "pending";
	}

	return getRunOutcome(run.conclusion);
}

function getRunCollectionOutcome(runs: GhRunSnapshot[]): "success" | "failure" | "pending" {
	if (runs.length === 0) {
		return "pending";
	}

	let pending = false;
	for (const run of runs) {
		if (run.jobs.some(isFailedJob)) {
			return "failure";
		}

		const outcome = getRunSnapshotOutcome(run);
		if (outcome === "failure") {
			return "failure";
		}
		if (outcome === "pending") {
			pending = true;
		}
	}

	return pending ? "pending" : "success";
}

function getRunCollectionSignature(runs: GhRunSnapshot[]): string {
	return runs
		.map(run => run.id)
		.sort((left, right) => left - right)
		.join(",");
}

function isFailedJob(job: GhRunJobSnapshot): boolean {
	return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getJobDurationSeconds(job: GhRunJobSnapshot, observedAtMs: number): number | undefined {
	const startedAtMs = parseTimestampMs(job.startedAt);
	if (startedAtMs === undefined) {
		return undefined;
	}

	const completedAtMs = parseTimestampMs(job.completedAt) ?? observedAtMs;
	return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}

function buildRunWatchJobDetails(job: GhRunJobSnapshot, observedAtMs: number): GhRunWatchJobDetails {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion,
		durationSeconds: getJobDurationSeconds(job, observedAtMs),
		url: job.url,
	};
}

function buildRunWatchRunDetails(run: GhRunSnapshot, observedAtMs: number): GhRunWatchRunDetails {
	return {
		id: run.id,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.branch,
		headSha: run.headSha,
		url: run.url,
		jobs: run.jobs.map(job => buildRunWatchJobDetails(job, observedAtMs)),
	};
}

function buildFailedLogDetails(failedJobLogs: GhFailedJobLog[]): GhRunWatchFailedLogDetails[] {
	return failedJobLogs.map(entry => ({
		runId: entry.run.id,
		workflowName: entry.run.workflowName,
		jobName: entry.job.name,
		conclusion: entry.job.conclusion,
		tail: entry.tail,
		available: entry.available,
	}));
}

function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

function formatRunWatchSnapshot(
	repo: string,
	run: GhRunSnapshot,
	pollCount: number,
	note?: string,
	includeOutcome: boolean = false,
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# Watching GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (includeOutcome) {
		lines.push("");
		lines.push(failedJobs.length > 0 ? "Failures detected." : "All jobs passed.");
	}

	return lines.join("\n").trim();
}

function formatRunWatchResult(
	repo: string,
	run: GhRunSnapshot,
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (failedJobs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Run failed.");
	} else if (getRunOutcome(run.conclusion) === "success") {
		lines.push("");
		lines.push("All jobs passed.");
	} else {
		lines.push("");
		lines.push("Run completed without successful jobs, but no failed job logs were available.");
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchSnapshot(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	pollCount: number,
	note?: string,
): string {
	const failedJobs = runs.flatMap(run => run.jobs.filter(isFailedJob));
	const completedRuns = runs.filter(run => run.status === "completed").length;
	const lines: string[] = [`# Watching GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Runs", runs.length);
	pushLine(lines, "Completed runs", `${completedRuns}/${runs.length}`);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	if (runs.length === 0) {
		lines.push("");
		lines.push("Waiting for workflow runs for this commit.");
		return lines.join("\n").trim();
	}

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchResult(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const outcome = getRunCollectionOutcome(runs);
	const lines: string[] = [`# GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Runs", runs.length);

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	if (failedJobLogs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Workflow runs for this commit failed.");
	} else if (outcome === "success") {
		lines.push("");
		lines.push("All workflow runs for this commit passed.");
	} else {
		lines.push("");
		lines.push("Workflow runs for this commit did not complete successfully.");
	}

	return lines.join("\n").trim();
}

function buildGhDetails(repo: string, run: GhRunSnapshot): GhToolDetails {
	return {
		repo,
		branch: run.branch,
		headSha: run.headSha,
		runId: run.id,
		runIds: [run.id],
		status: run.status,
		conclusion: run.conclusion,
		failedJobs: run.jobs.filter(isFailedJob).map(job => job.name),
	};
}

function buildRunWatchDetails(
	repo: string,
	run: GhRunSnapshot,
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhDetails(repo, run),
		watch: {
			mode: "run",
			state: options?.state ?? "completed",
			repo,
			branch: run.branch,
			headSha: run.headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			run: buildRunWatchRunDetails(run, observedAtMs),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

function buildGhRunCollectionDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
): GhToolDetails {
	const outcome = getRunCollectionOutcome(runs);
	return {
		repo,
		branch,
		headSha,
		runIds: runs.map(run => run.id),
		status: runs.length > 0 && runs.every(run => run.status === "completed") ? "completed" : "in_progress",
		conclusion: outcome,
		failedJobs: runs.flatMap(run =>
			run.jobs.filter(isFailedJob).map(job => `${run.workflowName ?? `run ${run.id}`}: ${job.name}`),
		),
	};
}

function buildCommitRunWatchDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhRunCollectionDetails(repo, headSha, branch, runs),
		watch: {
			mode: "commit",
			state: options?.state ?? "completed",
			repo,
			branch,
			headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			runs: runs.map(run => buildRunWatchRunDetails(run, observedAtMs)),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

async function resolveGitHubRepo(
	cwd: string,
	repo: string | undefined,
	runRepo: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (repo && runRepo && repo !== runRepo) {
		throw new ToolError("run URL repository does not match the provided repo");
	}

	if (repo) {
		return repo;
	}

	if (runRepo) {
		return runRepo;
	}

	const resolved = await git.github.text(
		cwd,
		["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
		signal,
	);
	return requireNonEmpty(resolved, "repo");
}

/**
 * Process-lifetime cache of `gh repo view --json nameWithOwner` lookups keyed
 * by absolute cwd. Avoids repeated `gh` chatter when the same protocol handler
 * or tool call resolves the default repo many times in a row.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * `gh repo view` for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller.
 */
const DEFAULT_REPO_RESOLVED = new Map<string, string>();
const DEFAULT_REPO_INFLIGHT = new Map<string, Promise<string>>();

export async function resolveDefaultRepoMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	const key = path.resolve(cwd);
	const ready = DEFAULT_REPO_RESOLVED.get(key);
	if (ready) return ready;
	let pending = DEFAULT_REPO_INFLIGHT.get(key);
	if (!pending) {
		pending = (async () => {
			// No caller signal: this lookup is shared across every concurrent
			// waiter on the same cwd.
			const resolved = await git.github.text(cwd, [
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"-q",
				".nameWithOwner",
			]);
			const value = requireNonEmpty(resolved, "repo");
			DEFAULT_REPO_RESOLVED.set(key, value);
			return value;
		})();
		// Drop the in-flight slot on settle so failures don't poison the cache
		// and so a successful resolution survives only in `DEFAULT_REPO_RESOLVED`.
		void pending.then(
			() => DEFAULT_REPO_INFLIGHT.delete(key),
			() => DEFAULT_REPO_INFLIGHT.delete(key),
		);
		DEFAULT_REPO_INFLIGHT.set(key, pending);
	}
	return untilAborted(signal, pending);
}

/**
 * Matches search-query qualifiers that already scope to a repository, org, or
 * user. When present, callers should avoid layering a default `repo:<current>`
 * on top — the user has already expressed an explicit scope.
 *
 * Only the leading `repo:`/`org:`/`user:`/`owner:` token is treated as a
 * scope marker; arbitrary substrings (e.g. inside quoted text) are ignored.
 */
const REPO_SCOPE_QUALIFIER_PATTERN = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;

/**
 * Resolve the effective `repo:` scope for a search op. Returns the explicit
 * `repo` when set, `undefined` when the query already carries a scoping
 * qualifier, and otherwise the current checkout's `owner/repo` via
 * `resolveDefaultRepoMemoized`. Resolution failures (no git/gh context, no
 * configured remote) silently fall back to `undefined` so the search proceeds
 * across all of GitHub instead of throwing.
 */
async function resolveSearchRepoScope(
	cwd: string,
	repo: string | undefined,
	query: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (repo) return repo;
	if (query && REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined;
	try {
		return await resolveDefaultRepoMemoized(cwd, signal);
	} catch {
		return undefined;
	}
}

async function resolveGitHubBranchHead(
	cwd: string,
	repo: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const response = await git.github.json<GhBranchApiResponse>(
		cwd,
		["api", "--method", "GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`],
		signal,
		{ repoProvided: true },
	);
	return requireNonEmpty(response.commit?.sha, `head SHA for branch ${branch}`);
}

async function fetchRunsForCommit(
	cwd: string,
	repo: string,
	headSha: string,
	branch: string | undefined,
	signal?: AbortSignal,
): Promise<GhRunSnapshot[]> {
	const response = await git.github.json<GhActionsRunListResponse>(
		cwd,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo}/actions/runs`,
			"-F",
			`head_sha=${headSha}`,
			"-F",
			`per_page=${RUN_JOBS_PAGE_SIZE}`,
			...(branch ? ["-F", `branch=${branch}`] : []),
		],
		signal,
		{ repoProvided: true },
	);

	return Promise.all(
		(response.workflow_runs ?? [])
			.filter((run): run is GhActionsRunApi & { id: number } => typeof run.id === "number")
			.map(async run => {
				const jobs = await fetchRunJobs(cwd, repo, run.id, signal);
				return normalizeRunSnapshot(run, jobs);
			}),
	);
}

async function fetchRunJobs(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunJobSnapshot[]> {
	const jobs: GhRunJobSnapshot[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhActionsJobsResponse>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/actions/runs/${runId}/jobs`,
				"-F",
				`per_page=${RUN_JOBS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		const pageJobs = (response.jobs ?? [])
			.map(job => normalizeRunJob(job))
			.filter((job): job is GhRunJobSnapshot => job !== null);
		jobs.push(...pageJobs);

		if (pageJobs.length < RUN_JOBS_PAGE_SIZE) {
			break;
		}

		if ((response.total_count ?? 0) <= jobs.length) {
			break;
		}

		page += 1;
	}

	return jobs;
}

async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		if (pageComments.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

async function fetchRunSnapshot(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunSnapshot> {
	const [run, jobs] = await Promise.all([
		git.github.json<GhActionsRunApi>(
			cwd,
			["api", "--method", "GET", `/repos/${repo}/actions/runs/${runId}`],
			signal,
			{
				repoProvided: true,
			},
		),
		fetchRunJobs(cwd, repo, runId, signal),
	]);

	return normalizeRunSnapshot(run, jobs);
}

function tailLogLines(log: string, tail: number): string | undefined {
	const normalized = normalizeBlock(log);
	if (!normalized) {
		return undefined;
	}

	const lines = normalized.split("\n");
	return lines.slice(-tail).join("\n").trimEnd();
}

async function fetchFailedJobLogs(
	cwd: string,
	repo: string,
	failedJobs: Array<{ run: GhRunSnapshot; job: GhRunJobSnapshot }>,
	tail: number,
	signal?: AbortSignal,
): Promise<GhFailedJobLog[]> {
	return Promise.all(
		failedJobs.map(async entry => {
			const result = await git.github.run(cwd, ["api", `/repos/${repo}/actions/jobs/${entry.job.id}/logs`], signal);
			const fullLog = result.exitCode === 0 ? normalizeBlock(result.stdout) : undefined;
			const logTail = fullLog ? tailLogLines(fullLog, tail) : undefined;
			return {
				run: entry.run,
				job: entry.job,
				full: fullLog,
				tail: logTail,
				available: Boolean(fullLog),
			};
		}),
	);
}

function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## Comments", ""];

	if (visible.length === 0) {
		lines.push(`No visible comments. Minimized comments omitted: ${hiddenCount}.`);
		return lines;
	}

	lines[0] = `## Comments (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No comment body.");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`Minimized comments omitted: ${hiddenCount}.`);
	}

	return lines;
}

function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## Reviews (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "unknown";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`Commit: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "No review body.");
		lines.push("");
	}

	return lines;
}

function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## Review Comments (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "unknown";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "Location", formatReviewCommentLocation(comment));
		pushLine(lines, "Side", comment.side);
		pushLine(lines, "Reply to", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "No review comment body.");
		lines.push("");
	}

	return lines;
}

function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub Repository";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "No description provided.");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Default branch", data.defaultBranchRef?.name);
	pushLine(lines, "Branch", normalizeOptionalString(input.branch));
	pushLine(lines, "Visibility", data.visibility ?? undefined);
	pushLine(lines, "Viewer permission", data.viewerPermission ?? undefined);
	pushLine(lines, "Primary language", data.primaryLanguage?.name);
	pushLine(lines, "Stars", data.stargazerCount);
	pushLine(lines, "Forks", data.forkCount);
	pushLine(lines, "Archived", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Homepage", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "Topics", topics || undefined);
	return lines.join("\n").trim();
}

function formatIssueView(data: GhIssueViewData, input: { issue: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "State reason", data.stateReason ?? undefined);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## Files (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(unknown file)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`- ... ${files.length - FILE_PREVIEW_LIMIT} more files`);
	}

	return lines;
}

function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "current";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "Untitled"}`);
	lines.push("");
	pushLine(lines, "State", data.state);
	pushLine(lines, "Draft", data.isDraft);
	pushLine(lines, "Author", formatAuthor(data.author));
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Review decision", data.reviewDecision ?? undefined);
	pushLine(lines, "Merge state", data.mergeStateStatus);
	pushLine(lines, "Created", data.createdAt);
	pushLine(lines, "Updated", data.updatedAt);
	pushLine(lines, "Labels", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(normalizeText(data.body) || "No description provided.");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrCheckoutResult(options: {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	reused: boolean;
}): string {
	const { data, localBranch, worktreePath, remoteName, remoteUrl, reused } = options;
	const lines: string[] = [
		reused ? `# Pull Request #${data.number ?? "?"} Worktree` : `# Checked Out Pull Request #${data.number ?? "?"}`,
		"",
	];
	pushLine(lines, "Title", data.title ?? undefined);
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Local branch", localBranch);
	pushLine(lines, "Worktree", worktreePath);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote URL", remoteUrl);
	pushLine(lines, "Cross repository", data.isCrossRepository);
	pushLine(lines, "Maintainer can modify", data.maintainerCanModify);
	lines.push("");
	lines.push(
		reused
			? "Reused the existing PR worktree."
			: "Created a dedicated worktree for this PR and configured the local branch to push back to the PR head branch.",
	);
	return lines.join("\n").trim();
}

function formatPrPushResult(options: {
	localBranch: string;
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	forceWithLease: boolean;
}): string {
	const lines: string[] = ["# Pushed Pull Request Branch", ""];
	pushLine(lines, "Local branch", options.localBranch);
	pushLine(lines, "Remote", options.remoteName);
	pushLine(lines, "Remote branch", options.remoteBranch);
	pushLine(lines, "Remote URL", options.remoteUrl);
	pushLine(lines, "PR", options.prUrl);
	pushLine(lines, "Force with lease", options.forceWithLease);
	lines.push("");
	lines.push(`Pushed ${options.localBranch} to ${options.remoteName}:${options.remoteBranch}.`);
	return lines.join("\n").trim();
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`No ${kind} found.`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  State", item.state);
		pushLine(lines, "  Author", formatAuthor(item.author));
		pushLine(lines, "  Labels", formatLabels(item.labels));
		pushLine(lines, "  Created", item.createdAt);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhSearchCodeResult[]): string {
	const lines: string[] = [`# GitHub code search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No code matches found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.path ?? "(unknown path)"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Commit", formatShortSha(item.sha));
		pushLine(lines, "  URL", item.url);
		const fragment = item.textMatches?.find(match => match.fragment)?.fragment;
		if (fragment) {
			pushLine(lines, "  Match", normalizeText(fragment).split("\n", 1)[0]);
		}
	}

	return lines.join("\n").trim();
}

function formatSearchCommitMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const firstLine = normalizeText(message).split("\n", 1)[0];
	return firstLine || undefined;
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhSearchCommitResult[]): string {
	const lines: string[] = [`# GitHub commits search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No commits found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		const sha = formatShortSha(item.sha) ?? "(unknown sha)";
		const subject = formatSearchCommitMessage(item.commit?.message) ?? "(no commit message)";
		lines.push(`- ${sha} ${subject}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Author", formatAuthor(item.author) ?? item.commit?.author?.name);
		pushLine(lines, "  Date", item.commit?.author?.date ?? item.commit?.committer?.date);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhSearchRepoResult[]): string {
	const lines: string[] = [`# GitHub repositories search`, "", `Query: ${query}`];
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No repositories found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.fullName ?? "(unknown repository)"}`);
		const description = normalizeText(item.description).split("\n", 1)[0];
		if (description) {
			pushLine(lines, "  Description", description);
		}
		pushLine(lines, "  Language", item.language ?? undefined);
		pushLine(lines, "  Stars", item.stargazersCount);
		pushLine(lines, "  Forks", item.forksCount);
		pushLine(lines, "  Open issues", item.openIssuesCount);
		pushLine(lines, "  Visibility", item.visibility ?? undefined);
		pushLine(lines, "  Archived", item.isArchived);
		pushLine(lines, "  Fork", item.isFork);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

async function saveArtifactText(session: ToolSession, toolType: string, text: string): Promise<string | undefined> {
	const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.(toolType)) ?? {};
	if (!artifactPath || !artifactId) {
		return undefined;
	}

	await Bun.write(artifactPath, text);
	return artifactId;
}

function appendArtifactReference(text: string, artifactId: string | undefined, label: string): string {
	if (!artifactId) {
		return text;
	}

	return `${text}\n\n${label}: artifact://${artifactId}`;
}

function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GhToolDetails,
	options?: { artifactId?: string; artifactLabel?: string },
): AgentToolResult<GhToolDetails> {
	const builder = toolResult<GhToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "Saved artifact"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	return builder.done();
}

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly summary = "Interact with GitHub issues, pull requests, and repositories";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}

async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhIssueViewData>(cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const rendered = formatIssueView(data, { issue: identifier, repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// PR diff fetcher
//
// Used by the `pr://<n>/diff[/…]` internal-URL family. Stores the verbatim
// `gh pr diff` text plus a parsed file index so the listing, full-diff, and
// per-file slice variants all share one cache row.
// ────────────────────────────────────────────────────────────────────────────

export interface PrDiffFile {
	/** Display path. Prefers the post-image (`b/<path>`) when present. */
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Pre-image path for renames/deletes; same as `path` otherwise. */
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text as returned by `gh pr diff --color never`. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}
/**
 * Split `gh pr diff` output on `^diff --git ` boundaries and parse per-file
 * metadata. The unified diff is preserved verbatim so callers can slice it by
 * byte offsets without re-running gh.
 */
export function parsePrUnifiedDiff(text: string): PrDiffPayload {
	const files: PrDiffFile[] = [];
	if (text.length === 0) {
		return { unified: text, files };
	}

	// Walk match positions manually so we capture each section's byte range.
	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		// Avoid zero-length match infinite loop (regex has fixed prefix, but
		// be explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parsePrDiffSection(section, startOffset, endOffset));
	}
	return { unified: text, files };
}

interface ParsedDiffHeaderToken {
	value: string;
	nextIndex: number;
}

function skipDiffHeaderSpaces(text: string, index: number): number {
	let i = index;
	while (text.charAt(i) === " ") i += 1;
	return i;
}

function parseDiffQuotedEscape(text: string, slashIndex: number): ParsedDiffHeaderToken {
	const next = text.charAt(slashIndex + 1);
	if (next === "") return { value: "\\", nextIndex: slashIndex + 1 };

	if (next >= "0" && next <= "7") {
		let end = slashIndex + 1;
		while (end < text.length && end < slashIndex + 4) {
			const digit = text.charAt(end);
			if (digit < "0" || digit > "7") break;
			end += 1;
		}
		return {
			value: String.fromCharCode(Number.parseInt(text.slice(slashIndex + 1, end), 8)),
			nextIndex: end,
		};
	}

	switch (next) {
		case "a":
			return { value: "\x07", nextIndex: slashIndex + 2 };
		case "b":
			return { value: "\b", nextIndex: slashIndex + 2 };
		case "f":
			return { value: "\f", nextIndex: slashIndex + 2 };
		case "n":
			return { value: "\n", nextIndex: slashIndex + 2 };
		case "r":
			return { value: "\r", nextIndex: slashIndex + 2 };
		case "t":
			return { value: "\t", nextIndex: slashIndex + 2 };
		case "v":
			return { value: "\v", nextIndex: slashIndex + 2 };
		case "\\":
		case '"':
			return { value: next, nextIndex: slashIndex + 2 };
		default:
			return { value: next, nextIndex: slashIndex + 2 };
	}
}

function parseDiffQuotedToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	if (text.charAt(startIndex) !== '"') return undefined;
	let value = "";
	for (let i = startIndex + 1; i < text.length; i += 1) {
		const ch = text.charAt(i);
		if (ch === '"') return { value, nextIndex: i + 1 };
		if (ch !== "\\") {
			value += ch;
			continue;
		}
		const escaped = parseDiffQuotedEscape(text, i);
		value += escaped.value;
		i = escaped.nextIndex - 1;
	}
	return undefined;
}

function parseDiffHeaderToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	const start = skipDiffHeaderSpaces(text, startIndex);
	if (start >= text.length) return undefined;
	const quoted = parseDiffQuotedToken(text, start);
	if (quoted) return quoted;
	const end = text.indexOf(" ", start);
	if (end === -1) return { value: text.slice(start), nextIndex: text.length };
	return { value: text.slice(start, end), nextIndex: end };
}

function stripPrDiffPathPrefix(value: string, prefix: "a/" | "b/"): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function parsePrDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	if (trail.startsWith('"')) {
		const oldToken = parseDiffQuotedToken(trail, 0);
		if (!oldToken) return {};
		const newToken = parseDiffHeaderToken(trail, oldToken.nextIndex);
		if (!newToken) return {};
		return {
			oldPath: stripPrDiffPathPrefix(oldToken.value, "a/"),
			newPath: stripPrDiffPathPrefix(newToken.value, "b/"),
		};
	}

	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) {
		return {
			oldPath: trail.slice(2, bIdx),
			newPath: trail.slice(bIdx + 3),
		};
	}
	return {};
}

function isPrDiffFileHeaderLine(line: string): boolean {
	return (
		line === "--- /dev/null" ||
		line === "+++ /dev/null" ||
		line.startsWith("--- a/") ||
		line.startsWith("+++ b/") ||
		line.startsWith('--- "a/') ||
		line.startsWith('+++ "b/')
	);
}

function parsePrDiffSection(section: string, startOffset: number, endOffset: number): PrDiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";
	const headerPaths = parsePrDiffHeaderPaths(header);
	let oldPath = headerPaths.oldPath;
	let newPath = headerPaths.newPath;

	let changeType: PrDiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	let inHunk = false;
	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk && isPrDiffFileHeaderLine(line)) continue;
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: PrDiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}

async function fetchPrDiffFresh(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const args = ["pr", "diff", String(number), "--color", "never"];
	appendRepoFlag(args, repo, String(number));
	const text = await git.github.text(cwd, args, signal, { repoProvided: true, trimOutput: false });
	const payload = parsePrUnifiedDiff(text);
	return { rendered: text, sourceUrl: undefined, payload };
}

/**
 * Cache-aware PR diff fetcher. Stores the full unified diff plus a parsed
 * file index in a single `pr-diff` cache row so the listing, full-diff, and
 * per-file slice variants of `pr://<n>/diff` share one `gh pr diff`
 * invocation.
 */
export async function getOrFetchPrDiff(options: PrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrDiffFresh(options.cwd, options.repo, options.number, options.signal);
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.repo,
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const outcomes = await Promise.all(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Pull Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI did not return a pull request number.");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head branch");
	const headRefOid = requireNonEmpty(data.headRefOid, "head commit");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = getWorktreeDir(`${prNumber}-${hashPath(primaryRepoRoot)}`);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				signal,
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, PR_CHECKOUT_BRANCH_CONFIG.headRef, headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, PR_CHECKOUT_BRANCH_CONFIG.url, data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				PR_CHECKOUT_BRANCH_CONFIG.isCrossRepository,
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				PR_CHECKOUT_BRANCH_CONFIG.maintainerCanModify,
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

async function executePrCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body;
	const base = normalizeOptionalString(params.base);
	const head = normalizeOptionalString(params.head);
	const draft = params.draft ?? false;
	const fill = params.fill ?? false;
	const reviewers = normalizePrIdentifierList(params.reviewer);
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (!fill && !title) {
		throw new ToolError("title is required unless fill is true");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}

	const args = ["pr", "create"];
	appendRepoFlag(args, repo);
	if (title) args.push("--title", title);
	if (base) args.push("--base", base);
	if (head) args.push("--head", head);
	if (draft) args.push("--draft");
	if (fill) args.push("--fill");
	for (const reviewer of reviewers) args.push("--reviewer", reviewer);
	for (const assignee of assignees) args.push("--assignee", assignee);
	for (const label of labels) args.push("--label", label);

	let bodyDir: string | undefined;
	try {
		if (!fill) {
			if (body !== undefined && body.length > 0) {
				// Route through a temp file so multi-KB bodies stay clear of any
				// argv-length limits and shell-quoting hazards on uncommon platforms.
				bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-body-"));
				const bodyFile = path.join(bodyDir, "body.md");
				await Bun.write(bodyFile, body);
				args.push("--body-file", bodyFile);
			} else {
				// Avoid gh dropping into an interactive editor when no body is given.
				args.push("--body", "");
			}
		}

		const output = await git.github.text(session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const url =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("https://github.com/")) ?? output.trim();
		const parsed = parsePullRequestUrl(url);
		const resolvedRepo = repo ?? parsed.repo;

		let prView: GhPrViewData | undefined;
		if (resolvedRepo && parsed.prNumber !== undefined) {
			try {
				prView = await git.github.json<GhPrViewData>(
					session.cwd,
					[
						"pr",
						"view",
						String(parsed.prNumber),
						"--repo",
						resolvedRepo,
						"--json",
						GH_PR_FIELDS_NO_COMMENTS.join(","),
					],
					signal,
					{ repoProvided: true },
				);
			} catch {
				// Best-effort summary; PR creation already succeeded.
			}
		}

		const text = formatPrCreateResult({
			url,
			prNumber: parsed.prNumber,
			data: prView,
			title,
			base,
			head,
			draft,
		});
		return buildTextResult(text, url || prView?.url);
	} finally {
		if (bodyDir) {
			await fs.rm(bodyDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function formatPrCreateResult(options: {
	url: string;
	prNumber?: number;
	data?: GhPrViewData;
	title?: string;
	base?: string;
	head?: string;
	draft?: boolean;
}): string {
	const number = options.prNumber ?? options.data?.number;
	const headerTitle = options.data?.title ?? options.title ?? "Untitled";
	const header =
		number !== undefined
			? `# Created Pull Request #${number}: ${headerTitle}`
			: `# Created Pull Request: ${headerTitle}`;
	const lines: string[] = [header, ""];
	pushLine(lines, "URL", options.url || options.data?.url);
	pushLine(lines, "State", options.data?.state);
	pushLine(lines, "Draft", options.data?.isDraft ?? options.draft);
	pushLine(lines, "Base", options.data?.baseRefName ?? options.base);
	pushLine(lines, "Head", options.data?.headRefName ?? options.head);
	pushLine(lines, "Author", formatAuthor(options.data?.author));
	pushLine(lines, "Created", options.data?.createdAt);
	pushLine(lines, "Labels", formatLabels(options.data?.labels));

	const bodyText = normalizeText(options.data?.body);
	if (bodyText) {
		lines.push("");
		lines.push("## Body");
		lines.push("");
		lines.push(bodyText);
	}

	return lines.join("\n").trim();
}

async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("issues", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:issue"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("issues", displayQuery, repo, items));
}

async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("prs", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:pr"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("pull requests", displayQuery, repo, items));
}

async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	if (params.since !== undefined || params.until !== undefined) {
		throw new ToolError("search_code does not support since/until; GitHub code search has no date qualifier.");
	}
	const limit = resolveSearchLimit(params.limit);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), query, signal);
	const apiQuery = composeSearchQuery([query, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("code", apiQuery, limit, ["Accept: application/vnd.github.text-match+json"]);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCodeItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCodeToSearchResult);
	return buildTextResult(formatSearchCodeResults(query, repo, items));
}

async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("commits", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("commits", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCommitItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCommitToSearchResult);
	return buildTextResult(formatSearchCommitsResults(displayQuery, repo, items));
}

async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("repos", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const query = composeSearchQuery([params.query, dateQualifier]);
	const args = buildGhApiSearchArgs("repositories", query, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchRepoItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiRepoToSearchResult);
	return buildTextResult(formatSearchReposResults(query, items));
}

async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, undefined, runReference.repo, signal);
	const intervalSeconds = RUN_WATCH_INTERVAL_DEFAULT;
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			const failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await scheduler.wait(graceSeconds * 1000, { signal });
					run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					run.jobs.filter(isFailedJob).map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "Full failed-job logs" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await scheduler.wait(intervalSeconds * 1000, { signal });
		}
	}

	const branch = branchInput ?? (await requireCurrentGitBranch(session.cwd, signal));
	const headSha = branchInput
		? await resolveGitHubBranchHead(session.cwd, repo, branch, signal)
		: await requireCurrentGitHead(session.cwd, signal);
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs = await fetchRunsForCommit(session.cwd, repo, headSha, branch, signal);
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			if (graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				runs = await fetchRunsForCommit(session.cwd, repo, headSha, branch, signal);
			}

			const failedJobLogs = await fetchFailedJobLogs(
				session.cwd,
				repo,
				runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job }))),
				tail,
				signal,
			);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "Full failed-job logs" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const note = `All known workflow runs completed successfully. Waiting ${intervalSeconds}s to ensure no additional runs appear for this commit.`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await scheduler.wait(intervalSeconds * 1000, { signal });
			continue;
		}

		settledSuccessSignature = undefined;
		await scheduler.wait(intervalSeconds * 1000, { signal });
	}
}

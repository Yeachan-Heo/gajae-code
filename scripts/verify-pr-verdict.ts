#!/usr/bin/env bun

import * as path from "node:path";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERDICT_PREFIX = "gajae.pr-review-verdict.v1";
const VERDICT_PATTERN = /^gajae\.pr-review-verdict\.v1 (merge-approved|merge-blocked|needs-human) sha256:([0-9a-f]{64}) reviewer:(architect|critic|human) reviewer-id:([^\s]+) evidence:(.+)$/u;

export type PrVerdict = "merge-approved" | "merge-blocked" | "needs-human";
export type ReviewerRole = "architect" | "critic" | "human";

export interface ParsedPrVerdict {
	verdict: PrVerdict;
	diffSha256: string;
	reviewerRole: ReviewerRole;
	reviewerId: string;
	evidence: string;
}

export interface PrValidationInput {
	body: string;
	baseRef: string;
	baseSha: string;
	headSha: string;
	authorLogin: string;
	computedDiffSha256: string;
	baseIsAncestor: boolean;
	fastGatePassed: boolean;
	authenticatedReviewerLogin?: string;
	authenticatedReviewHeadSha?: string;
	requireMergeApproved?: boolean;
}

export interface PrValidationResult {
	ok: boolean;
	verdict?: ParsedPrVerdict;
	diagnostics: string[];
}

export function parsePrVerdict(body: string): { verdict?: ParsedPrVerdict; diagnostics: string[] } {
	const candidates = body
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(line => line.startsWith(VERDICT_PREFIX));
	if (candidates.length === 0) {
		return {
			diagnostics: [
				`PR body must contain exactly one ${VERDICT_PREFIX} line. Copy the current .github/PULL_REQUEST_TEMPLATE.md block and fill every field.`,
			],
		};
	}
	if (candidates.length !== 1) {
		return { diagnostics: [`PR body contains ${candidates.length} ${VERDICT_PREFIX} lines; keep exactly one current verdict.`] };
	}
	const match = VERDICT_PATTERN.exec(candidates[0]!);
	if (!match) {
		return {
			diagnostics: [
				`Malformed ${VERDICT_PREFIX} line. Expected: ${VERDICT_PREFIX} <merge-approved|merge-blocked|needs-human> sha256:<64 lowercase hex> reviewer:<architect|critic|human> reviewer-id:<identity> evidence:<non-empty evidence>.`,
			],
		};
	}
	return {
		verdict: {
			verdict: match[1] as PrVerdict,
			diffSha256: match[2]!,
			reviewerRole: match[3] as ReviewerRole,
			reviewerId: match[4]!,
			evidence: match[5]!.trim(),
		},
		diagnostics: [],
	};
}

export function validatePrContract(input: PrValidationInput): PrValidationResult {
	const parsed = parsePrVerdict(input.body);
	const diagnostics = [...parsed.diagnostics];
	if (input.baseRef !== "dev") diagnostics.push(`PR base must be dev, not ${JSON.stringify(input.baseRef)}. Retarget the PR to dev.`);
	if (!SHA40.test(input.baseSha)) diagnostics.push("Immutable PR event base SHA must be a lowercase 40-hex commit.");
	if (!SHA40.test(input.headSha)) diagnostics.push("Exact PR head SHA must be a lowercase 40-hex commit.");
	if (!SHA256.test(input.computedDiffSha256)) diagnostics.push("Computed PR diff digest must be a lowercase SHA-256.");
	if (!input.baseIsAncestor) {
		diagnostics.push(`Exact PR head ${input.headSha} does not contain immutable event base ${input.baseSha}. Rebase onto current dev and regenerate the verdict.`);
	}
	if (!input.fastGatePassed) {
		diagnostics.push("Repository fast gate failed. Run: bun scripts/verify-gjc-state-writers.ts --fail");
	}
	if (parsed.verdict) {
		if (parsed.verdict.diffSha256 !== input.computedDiffSha256) {
			diagnostics.push(
				`Verdict digest ${parsed.verdict.diffSha256} is stale; exact ${input.baseSha}...${input.headSha} diff digest is ${input.computedDiffSha256}. Regenerate the verdict after the final commit.`,
			);
		}
		if (parsed.verdict.verdict === "merge-approved" && parsed.verdict.reviewerId.toLowerCase() === input.authorLogin.toLowerCase()) {
			diagnostics.push(`merge-approved cannot be self-approved: reviewer-id ${parsed.verdict.reviewerId} matches PR author ${input.authorLogin}. Use needs-human or obtain independent review.`);
		}
		if (input.requireMergeApproved && parsed.verdict.verdict !== "merge-approved") {
			diagnostics.push(`Verdict ${parsed.verdict.verdict} intentionally blocks merge. Obtain independent review, update the exact-head verdict to merge-approved, and rerun this check.`);
		}
		if (input.requireMergeApproved && parsed.verdict.verdict === "merge-approved") {
			if (!input.authenticatedReviewerLogin || input.authenticatedReviewerLogin.toLowerCase() !== parsed.verdict.reviewerId.toLowerCase()) {
				diagnostics.push(`merge-approved reviewer-id ${parsed.verdict.reviewerId} is not backed by an authenticated approving GitHub review.`);
			}
			if (input.authenticatedReviewHeadSha !== input.headSha) {
				diagnostics.push(`Authenticated approval must target exact PR head ${input.headSha}, not ${input.authenticatedReviewHeadSha ?? "a missing commit"}.`);
			}
		}
	}
	return { ok: diagnostics.length === 0, verdict: parsed.verdict, diagnostics };
}

export function canonicalDiffSha256(diff: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(diff).digest("hex");
}

interface PullRequestEvent {
	repository?: { full_name?: string };
	pull_request?: {
		number?: number;
		body?: string | null;
		user?: { login?: string };
		base?: { ref?: string; sha?: string };
		head?: { sha?: string };
	};
}

interface PullRequestReview {
	state?: string;
	commit_id?: string;
	user?: { login?: string };
}

interface CollaboratorPermission {
	permission?: string;
}

async function authenticatedApproval(event: PullRequestEvent, reviewerId: string, headSha: string): Promise<{ login?: string; headSha?: string }> {
	const repository = event.repository?.full_name;
	const number = event.pull_request?.number;
	const token = Bun.env.GITHUB_TOKEN;
	if (!repository || !number || !token) return {};
	const reviews: PullRequestReview[] = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`, {
			headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) return {};
		const pageReviews = await response.json() as PullRequestReview[];
		reviews.push(...pageReviews);
		if (pageReviews.length < 100) break;
	}
	const reviewerReviews = reviews.filter(review =>
		review.user?.login?.toLowerCase() === reviewerId.toLowerCase()
		&& review.state !== "COMMENTED"
		&& review.commit_id === headSha,
	);
	const approval = reviewerReviews.at(-1);
	if (approval?.state !== "APPROVED") return {};
	const permissionResponse = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(reviewerId)}/permission`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!permissionResponse.ok) return {};
	const collaborator = await permissionResponse.json() as CollaboratorPermission;
	if (!new Set(["admin", "maintain", "write"]).has(collaborator.permission ?? "")) return {};
	return approval ? { login: approval.user!.login, headSha: approval.commit_id } : {};
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: Uint8Array; stderr: string }> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).bytes(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, stdout, stderr: stderr.trim() };
}

async function runFastGate(cwd: string, trustedRoot: string): Promise<boolean> {
	const configPath = path.join(Bun.env.RUNNER_TEMP ?? Bun.env.TMPDIR ?? "/tmp", "gjc-pr-contract-empty-bunfig.toml");
	await Bun.write(configPath, "# trusted empty Bun configuration\n");
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.BUN_OPTIONS;
	const child = Bun.spawn([
		process.execPath,
		"--no-env-file",
		`--config=${configPath}`,
		path.join(trustedRoot, "scripts", "verify-gjc-state-writers.ts"),
		"--fail",
		"--root",
		cwd,
	], { cwd: trustedRoot, env, stdout: "inherit", stderr: "inherit" });
	return (await child.exited) === 0;
}

async function validateEvent(eventPath: string, cwd: string, trustedRoot: string): Promise<PrValidationResult> {
	const event = (await Bun.file(eventPath).json()) as PullRequestEvent;
	const pr = event.pull_request;
	if (!pr) return { ok: false, diagnostics: ["GitHub event payload does not contain pull_request data."] };
	const body = pr.body ?? "";
	const authorLogin = pr.user?.login ?? "";
	const baseRef = pr.base?.ref ?? "";
	const baseSha = pr.base?.sha ?? "";
	const headSha = pr.head?.sha ?? "";
	if (!SHA40.test(baseSha) || !SHA40.test(headSha)) {
		return validatePrContract({ body, authorLogin, baseRef, baseSha, headSha, computedDiffSha256: "", baseIsAncestor: false, fastGatePassed: false });
	}
	const checkedOut = await git(["rev-parse", "HEAD"], cwd);
	if (checkedOut.exitCode !== 0 || new TextDecoder().decode(checkedOut.stdout).trim() !== headSha) {
		return { ok: false, diagnostics: [`Checked-out source must equal exact PR head ${headSha}.` ] };
	}
	const fetchBase = await git(["fetch", "--no-tags", trustedRoot, baseSha], cwd);
	if (fetchBase.exitCode !== 0) return { ok: false, diagnostics: [`Could not fetch immutable PR base ${baseSha}: ${fetchBase.stderr}`] };
	const ancestry = await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
	const diff = await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd);
	if (diff.exitCode !== 0) return { ok: false, diagnostics: [`Could not compute exact PR diff: ${diff.stderr}`] };
	const parsed = parsePrVerdict(body);
	const approval = parsed.verdict?.verdict === "merge-approved"
		? await authenticatedApproval(event, parsed.verdict.reviewerId, headSha)
		: {};
	return validatePrContract({
		body,
		baseRef,
		baseSha,
		headSha,
		authorLogin,
		computedDiffSha256: canonicalDiffSha256(diff.stdout),
		baseIsAncestor: ancestry.exitCode === 0,
		fastGatePassed: await runFastGate(cwd, trustedRoot),
		authenticatedReviewerLogin: approval.login,
		authenticatedReviewHeadSha: approval.headSha,
		requireMergeApproved: true,
	});
}

function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const char of command) {
		if (escaped) { word += char; escaped = false; continue; }
		if (char === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (char === quote) quote = null; else word += char; continue; }
		if (char === "'" || char === '"') { quote = char; continue; }
		if (/\s/u.test(char)) { if (word) { words.push(word); word = ""; } continue; }
		if (";&|`()<>".includes(char)) return null;
		word += char;
	}
	if (escaped || quote) return null;
	if (word) words.push(word);
	return words;
}

export function parseGhPrCreate(command: string): { bodyFile?: string; body?: string; base?: string } | null {
	const words = shellWords(command);
	if (!words) return /(?:^|\s)gh\s+pr\s+create(?:\s|$)/u.test(command) ? {} : null;
	const gh = words.findIndex((word, index) => word === "gh" && words[index + 1] === "pr" && words[index + 2] === "create");
	if (gh < 0) return null;
	const result: { bodyFile?: string; body?: string; base?: string } = {};
	for (let i = gh + 3; i < words.length; i++) {
		const word = words[i]!;
		const next = words[i + 1];
		if ((word === "--body-file" || word === "-F") && next) { result.bodyFile = next; i++; }
		else if (word.startsWith("--body-file=")) result.bodyFile = word.slice("--body-file=".length);
		else if ((word === "--body" || word === "-b") && next) { result.body = next; i++; }
		else if (word.startsWith("--body=")) result.body = word.slice("--body=".length);
		else if ((word === "--base" || word === "-B") && next) { result.base = next; i++; }
		else if (word.startsWith("--base=")) result.base = word.slice("--base=".length);
	}
	return result;
}

async function validatePreflight(command: string, cwd: string, trustedRoot: string, invocationCwd: string): Promise<PrValidationResult> {
	const parsed = parseGhPrCreate(command);
	if (parsed === null) return { ok: true, diagnostics: [] };
	if (!parsed.bodyFile && parsed.body === undefined) return { ok: false, diagnostics: ["gh pr create must provide --body-file or --body so the PR verdict can be validated before submission."] };
	let body = parsed.body!;
	if (parsed.bodyFile) {
		const bodyPath = path.resolve(invocationCwd, parsed.bodyFile);
		try {
			body = await Bun.file(bodyPath).text();
		} catch (error) {
			return { ok: false, diagnostics: [`Could not read PR body file ${bodyPath}: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}
	const baseRef = parsed.base ?? "dev";
	const refreshBase = await git(["fetch", "--no-tags", "origin", "dev"], cwd);
	if (refreshBase.exitCode !== 0) {
		return { ok: false, diagnostics: [`Could not refresh origin/dev before PR preflight: ${refreshBase.stderr}. Run git fetch origin dev and retry.`] };
	}
	const base = await git(["rev-parse", "origin/dev"], cwd);
	const head = await git(["rev-parse", "HEAD"], cwd);
	const baseSha = new TextDecoder().decode(base.stdout).trim();
	const headSha = new TextDecoder().decode(head.stdout).trim();
	const author = Bun.env.GITHUB_ACTOR ?? Bun.env.USER ?? "unknown";
	const ancestry = SHA40.test(baseSha) && SHA40.test(headSha) ? await git(["merge-base", "--is-ancestor", baseSha, headSha], cwd) : { exitCode: 1 };
	const diff = SHA40.test(baseSha) && SHA40.test(headSha) ? await git(["diff", "--binary", "--full-index", "--no-ext-diff", `${baseSha}...${headSha}`], cwd) : { exitCode: 1, stdout: new Uint8Array(), stderr: "invalid git revisions" };
	return validatePrContract({ body, baseRef, baseSha, headSha, authorLogin: author, computedDiffSha256: diff.exitCode === 0 ? canonicalDiffSha256(diff.stdout) : "", baseIsAncestor: ancestry.exitCode === 0, fastGatePassed: await runFastGate(cwd, trustedRoot), requireMergeApproved: false });
}

export async function main(argv: string[]): Promise<number> {
	const repoIndex = argv.indexOf("--repo");
	const trustedRootIndex = argv.indexOf("--trusted-root");
	const invocationCwdIndex = argv.indexOf("--invocation-cwd");
	const cwd = path.resolve(process.cwd(), repoIndex >= 0 && argv[repoIndex + 1] ? argv[repoIndex + 1]! : ".");
	const trustedRoot = path.resolve(process.cwd(), trustedRootIndex >= 0 && argv[trustedRootIndex + 1] ? argv[trustedRootIndex + 1]! : ".");
	const invocationCwd = path.resolve(process.cwd(), invocationCwdIndex >= 0 && argv[invocationCwdIndex + 1] ? argv[invocationCwdIndex + 1]! : cwd);
	const eventIndex = argv.indexOf("--event");
	const preflightIndex = argv.indexOf("--preflight-command");
	const result = eventIndex >= 0 && argv[eventIndex + 1]
		? await validateEvent(path.resolve(process.cwd(), argv[eventIndex + 1]!), cwd, trustedRoot)
		: preflightIndex >= 0 && argv[preflightIndex + 1]
			? await validatePreflight(argv[preflightIndex + 1]!, cwd, trustedRoot, invocationCwd)
			: { ok: false, diagnostics: ["Usage: bun scripts/verify-pr-verdict.ts --event <github-event.json> | --preflight-command <command>"] };
	for (const diagnostic of result.diagnostics) console.error(`::error::${diagnostic}`);
	if (result.ok && result.verdict) console.log(`PR contract valid: ${result.verdict.verdict} ${result.verdict.diffSha256}`);
	return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

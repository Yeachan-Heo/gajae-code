/**
 * Side-effecting GitHub helpers shared by the router, completion, and sweeper:
 * ack reactions, the live status line inside the marked summary comment,
 * check-run lifecycle, head-sha resolution, and per-repo learnings.
 *
 * Everything here is best-effort: a failed ack or status line must never
 * block or fail a review.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GithubReviewConfig } from "./config";
import { AppTokenProvider, GithubApi } from "./github";
import { appendEvent, ReviewStateStore } from "./state";

export interface CheckRunInfo {
	id: number;
	status?: string;
	name?: string;
	started_at?: string;
}

export class ReviewService {
	readonly api: GithubApi;
	readonly tokens: AppTokenProvider;
	readonly store: ReviewStateStore;
	readonly eventsPath: string;
	private readonly summaryMarker: string;
	private readonly statusRe: RegExp;

	constructor(readonly config: GithubReviewConfig) {
		this.api = new GithubApi(config.apiBase);
		this.tokens = new AppTokenProvider(config);
		this.store = new ReviewStateStore(config.dataDir, config.inflightStaleSeconds);
		this.eventsPath = path.join(config.dataDir, "events.jsonl");
		this.summaryMarker = `<!-- ${config.markerPrefix}-summary -->`;
		this.statusRe = new RegExp(
			`<!-- ${config.markerPrefix}-status -->.*?<!-- /${config.markerPrefix}-status -->`,
			"s",
		);
	}

	logEvent(kind: string, fields: Record<string, unknown> = {}): void {
		appendEvent(this.eventsPath, kind, fields);
	}

	/** 👀 on the triggering comment — instant "접수" signal before the minutes-long LLM turn. */
	async ackReaction(repo: string, commentId: number | undefined, reviewComment = false): Promise<boolean> {
		if (!commentId) return false;
		const token = await this.tokens.tokenOrEmpty();
		if (!token) return false;
		const kind = reviewComment ? "pulls" : "issues";
		const res = await this.api.tryRequest(`/repos/${repo}/${kind}/comments/${commentId}/reactions`, {
			method: "POST",
			body: { content: "eyes" },
			token,
			timeoutMs: 5000,
		});
		this.logEvent("ack_reaction", { repo, comment_id: commentId, ok: res !== null });
		return res !== null;
	}

	/** Resolve the PR head sha. "" on failure (fail-open to the $SHA agent flow). */
	async fetchHeadSha(repo: string, pr: number): Promise<string> {
		const token = await this.tokens.tokenOrEmpty();
		if (!token) return "";
		const res = await this.api.tryRequest<{ head?: { sha?: string } }>(`/repos/${repo}/pulls/${pr}`, {
			token,
			timeoutMs: 5000,
		});
		return res?.head?.sha ?? "";
	}

	/**
	 * Create an in_progress check-run so the PR shows "review in progress" the
	 * instant the webhook fires. Returns the check-run id or null.
	 */
	async createCheck(repo: string, headSha: string): Promise<number | null> {
		if (!headSha || headSha === "$SHA") return null;
		const token = await this.tokens.tokenOrEmpty();
		if (!token) return null;
		const res = await this.api.tryRequest<{ id?: number }>(`/repos/${repo}/check-runs`, {
			method: "POST",
			body: {
				name: this.config.checkName,
				head_sha: headSha,
				status: "in_progress",
				output: {
					title: "리뷰 진행 중",
					summary: `${this.config.botDisplayName}가 이 PR을 리뷰하고 있어요… 잠시만.`,
				},
			},
			token,
			timeoutMs: 5000,
		});
		return res?.id ?? null;
	}

	async closeCheck(repo: string, sha: string, checkId: number | null, conclusion: string): Promise<number> {
		const token = await this.tokens.tokenOrEmpty();
		if (!token) return 0;
		const body = {
			status: "completed",
			conclusion,
			output: {
				title: conclusion === "success" ? "리뷰 완료" : "리뷰 종료",
				summary:
					conclusion === "success"
						? "코드리뷰 게시함."
						: `리뷰가 정상 종료되지 않았습니다. \`${this.mention()} review\` 로 재시도하세요.`,
			},
		};
		const ids: number[] = checkId ? [checkId] : [];
		if (ids.length === 0 && sha && sha !== "$SHA") {
			const res = await this.api.tryRequest<{ check_runs?: CheckRunInfo[] }>(
				`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(this.config.checkName)}`,
				{ token },
			);
			for (const cr of res?.check_runs ?? []) {
				if (cr.status === "in_progress") ids.push(cr.id);
			}
		}
		let closed = 0;
		for (const id of ids) {
			const res = await this.api.tryRequest(`/repos/${repo}/check-runs/${id}`, { method: "PATCH", body, token });
			if (res !== null) closed += 1;
		}
		return closed;
	}

	mention(): string {
		return `@${this.config.botAliases[0]}`;
	}

	private statusBlock(line: string): string {
		const p = this.config.markerPrefix;
		return `<!-- ${p}-status -->\n> ${line}\n<!-- /${p}-status -->`;
	}

	/** Find the marked walkthrough comment id (oldest match), or null. */
	async findSummaryCommentId(token: string, repo: string, pr: number): Promise<number | null> {
		const comments = await this.api.tryRequest<Array<{ id: number; body?: string; user?: { login?: string } }>>(
			`/repos/${repo}/issues/${pr}/comments?per_page=100`,
			{ token },
		);
		if (!Array.isArray(comments)) return null;
		for (const c of comments) {
			if (c.user?.login === `${this.config.botLogin}[bot]` && (c.body ?? "").includes(this.summaryMarker)) {
				return c.id;
			}
		}
		return null;
	}

	/**
	 * Create/update the live ⏳/✅/❌ status line inside the summary comment.
	 * Best-effort; returns the comment id or null.
	 */
	async upsertStatusLine(repo: string, pr: number, line: string): Promise<number | null> {
		const token = await this.tokens.tokenOrEmpty();
		if (!token) return null;
		let cid = this.store.getPrState(repo, pr).summary_comment_id ?? null;
		if (!cid) {
			cid = await this.findSummaryCommentId(token, repo, pr);
			if (cid) await this.store.setPrState(repo, pr, { summary_comment_id: cid });
		}
		if (cid) {
			const comment = await this.api.tryRequest<{ body?: string }>(`/repos/${repo}/issues/comments/${cid}`, {
				token,
			});
			if (comment?.body !== undefined && comment.body !== null) {
				let body = comment.body;
				if (this.statusRe.test(body)) {
					body = body.replace(this.statusRe, this.statusBlock(line));
				} else if (body.includes(this.summaryMarker)) {
					body = body.replace(this.summaryMarker, `${this.summaryMarker}\n${this.statusBlock(line)}`);
				} else {
					body = `${this.statusBlock(line)}\n${body}`;
				}
				const res = await this.api.tryRequest(`/repos/${repo}/issues/comments/${cid}`, {
					method: "PATCH",
					body: { body },
					token,
				});
				if (res !== null) return cid;
			}
		}
		const body = `${this.summaryMarker}\n${this.statusBlock(line)}\n\n_리뷰가 끝나면 이 코멘트가 🦞 Walkthrough 요약으로 갱신됩니다._`;
		const created = await this.api.tryRequest<{ id?: number }>(`/repos/${repo}/issues/${pr}/comments`, {
			method: "POST",
			body: { body },
			token,
		});
		if (created?.id) {
			await this.store.setPrState(repo, pr, { summary_comment_id: created.id });
			return created.id;
		}
		return null;
	}

	/** Immediate user-visible ack: check-run first, live status line second. */
	async startReviewAcks(repo: string, pr: number, headSha: string): Promise<number | null> {
		const checkId = await this.createCheck(repo, headSha);
		if (checkId) {
			await this.store.setPrState(repo, pr, { check_id: checkId });
			this.logEvent("check_created", { repo, pr, sha: headSha, check_id: checkId });
		}
		await this.upsertStatusLine(
			repo,
			pr,
			`⏳ ${this.config.botDisplayName}가 리뷰 중… (head \`${headSha.slice(0, 7)}\`)`,
		);
		return checkId;
	}

	// ── per-repo learnings (프로젝트 규칙 기억) ──────────────────────────
	private learnPath(repo: string): string {
		return path.join(this.config.dataDir, "learnings", `${repo.replaceAll("/", "__")}.md`);
	}

	getLearnings(repo: string): string {
		try {
			return fs.readFileSync(this.learnPath(repo), "utf8").trim();
		} catch {
			return "";
		}
	}

	addLearning(repo: string, note: string): void {
		const trimmed = (note ?? "").trim();
		if (!trimmed) return;
		try {
			const p = this.learnPath(repo);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.appendFileSync(p, `- ${trimmed}\n`);
		} catch {
			/* best-effort */
		}
	}
}

/** Return (cmd, args) when body is a `<mention> <cmd> ...` command, else null. */
export function parseCommand(body: string, aliases: string[]): { cmd: string; args: string } | null {
	if (!body) return null;
	const commands = ["review", "summary", "pause", "resume", "resolve", "help", "fix", "learn"];
	const aliasAlt = aliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	// NB: JS `\b` is ASCII-only — a Korean command word like `리뷰` needs a
	// Unicode-aware boundary, hence the explicit lookahead.
	const re = new RegExp(
		`(?:@?(?:${aliasAlt}))\\s+(${commands.join("|")}|리뷰)(?![\\p{L}\\p{N}_])\\s*([\\s\\S]*)`,
		"iu",
	);
	const m = re.exec(body);
	if (!m) return null;
	let cmd = m[1].toLowerCase();
	if (cmd === "리뷰") cmd = "review";
	return { cmd, args: (m[2] ?? "").trim() };
}

/** True when any alias (or @alias) appears in the text. */
export function mentionsBot(body: string, aliases: string[]): boolean {
	if (!body) return false;
	const aliasAlt = aliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new RegExp(`@?(?:${aliasAlt})`, "i").test(body);
}

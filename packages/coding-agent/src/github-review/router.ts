/**
 * Single-route webhook router. A GitHub App has ONE webhook URL, so
 * pull_request / issue_comment / pull_request_review_comment all land here.
 * The router inspects the payload, applies the review gate, fires immediate
 * acks (reaction, check-run, status line), and returns either an instruction
 * to run in an embedded agent session or a silent skip with a reason.
 *
 * Review lifecycle (gate → ack → run → complete):
 *   gate     — ReviewStateStore.tryAcquireReview CAS: dedup same-sha,
 *              supersede on newer sha, queue past the concurrency cap.
 *   ack      — check-run `in_progress` + live ⏳ status line (best-effort).
 *   complete — the review prompt ends with the complete command, the single
 *              idempotent owner of check-run close / state release / drain.
 *              The sweeper covers crashed runs.
 */
import type { GithubReviewConfig } from "./config";
import {
	buildReview,
	chatInstr,
	closeLineFor,
	fixInstr,
	forceReviewInstr,
	helpText,
	type InstructionContext,
	replyInstr,
	resolveInstr,
	reviewThreadReplyInstr,
	summaryInstr,
} from "./instructions";
import { loadRepoConfig, type RepoReviewConfig } from "./repo-config";
import type { ReviewService } from "./service";
import { mentionsBot, parseCommand } from "./service";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

export type RouteAction =
	| { kind: "silent"; reason: string }
	| { kind: "run"; instruction: string; review?: { repo: string; pr: number; sha: string } };

function silent(reason: string): RouteAction {
	return { kind: "silent", reason };
}

function run(instruction: string, review?: { repo: string; pr: number; sha: string }): RouteAction {
	return { kind: "run", instruction, ...(review ? { review } : {}) };
}

interface GithubUser {
	login?: string;
	type?: string;
}

/** Loop guard: skip bot-authored events (incl. our own posts). */
function isBot(user: GithubUser): boolean {
	return user.type === "Bot" || (user.login ?? "").endsWith("[bot]");
}

export function instructionContext(config: GithubReviewConfig): InstructionContext {
	return {
		postCmd: config.postCommand,
		completeCmd: config.completeCommand,
		botLogin: config.botLogin,
		markerPrefix: config.markerPrefix,
		botDisplayName: config.botDisplayName,
		mention: `@${config.botAliases[0]}`,
		ignoreRepos: config.ignoreRepos,
	};
}

export class WebhookRouter {
	private readonly ctx: InstructionContext;

	constructor(
		private readonly config: GithubReviewConfig,
		private readonly service: ReviewService,
	) {
		this.ctx = instructionContext(config);
	}

	async route(payload: Record<string, unknown>): Promise<RouteAction> {
		const repo = ((payload.repository as { full_name?: string } | undefined)?.full_name ?? "").trim();
		if (!repo) return silent("no repository");
		const lower = repo.toLowerCase();
		if (this.config.ignoreRepos.some(ig => lower.includes(ig.toLowerCase()))) {
			return silent("ignored repo");
		}

		const comment = payload.comment as Record<string, unknown> | undefined;
		if (comment && (comment.pull_request_review_id !== undefined || comment.path !== undefined)) {
			return await this.routeReviewComment(payload, repo, comment);
		}
		if (comment) return await this.routeIssueComment(payload, repo, comment);
		if (payload.pull_request) return await this.routePullRequest(payload, repo);
		return silent("unhandled event shape");
	}

	// ── mode: inline diff-line thread reply (pull_request_review_comment) ──
	private async routeReviewComment(
		payload: Record<string, unknown>,
		repo: string,
		comment: Record<string, unknown>,
	): Promise<RouteAction> {
		if (payload.action !== "created") return silent("review-comment action");
		const user = (comment.user ?? {}) as GithubUser;
		if (isBot(user)) return silent("bot author");
		const body = (comment.body as string | undefined) ?? "";
		if (!mentionsBot(body, this.config.botAliases)) return silent("no trigger");
		if (!this.isTrusted(comment.author_association)) {
			// Inline replies drive a terminal-capable session; unknown accounts
			// get NO ack and NO session (prompt-injection surface).
			this.service.logEvent("unauthorized", { repo, kind: "review_comment", login: user.login });
			return silent("author not authorized");
		}
		await this.service.ackReaction(repo, comment.id as number | undefined, true);
		const pr = (payload.pull_request ?? {}) as { number?: number };
		const num = pr.number ?? 0;
		return run(
			reviewThreadReplyInstr(this.ctx, repo, num, {
				id: (comment.id as number) ?? 0,
				login: user.login ?? "",
				path: comment.path as string | undefined,
				line: comment.line as number | null,
				diffHunk: comment.diff_hunk as string | undefined,
				body,
			}),
		);
	}

	// ── mode: PR conversation chat / commands (issue_comment) ──
	private async routeIssueComment(
		payload: Record<string, unknown>,
		repo: string,
		comment: Record<string, unknown>,
	): Promise<RouteAction> {
		const action = payload.action as string | undefined;
		if (action !== "created" && action !== "edited") return silent("issue-comment action");
		const issue = (payload.issue ?? {}) as { number?: number; title?: string; pull_request?: unknown };
		if (issue.pull_request === undefined) return silent("not a PR comment");
		const user = (comment.user ?? {}) as GithubUser;
		if (isBot(user)) return silent("bot author");
		const body = (comment.body as string | undefined) ?? "";
		const num = issue.number ?? 0;
		const command = parseCommand(body, this.config.botAliases);
		if ((command || mentionsBot(body, this.config.botAliases)) && !this.isTrusted(comment.author_association)) {
			// Commands and chat spawn terminal-capable sessions as the daemon's
			// OS user; unknown accounts get NO ack and NO session.
			this.service.logEvent("unauthorized", { repo, pr: num, kind: "issue_comment", login: user.login });
			return silent("author not authorized");
		}
		if (command) {
			await this.service.ackReaction(repo, comment.id as number | undefined);
			const handled = await this.handleCommand(command.cmd, command.args, repo, num, comment.author_association);
			if (handled) return handled;
		}
		if (action === "edited") return silent("edited without new command"); // 중복 채팅 응답 방지
		if (!mentionsBot(body, this.config.botAliases)) return silent("no trigger");
		await this.service.ackReaction(repo, comment.id as number | undefined);
		return run(chatInstr(this.ctx, repo, num, issue.title ?? "", user.login ?? "", body));
	}

	/** Handle `<mention> <cmd>`. Returns null for unrecognized commands (falls through to chat). */
	private async handleCommand(
		cmd: string,
		args: string,
		repo: string,
		num: number,
		authorAssociation: unknown,
	): Promise<RouteAction | null> {
		switch (cmd) {
			case "help":
				return run(replyInstr(this.ctx, repo, num, helpText(this.ctx)));
			case "summary":
				return run(summaryInstr(this.ctx, repo, num));
			case "fix":
				return run(fixInstr(this.ctx, repo, num, args));
			case "resolve":
				return run(resolveInstr(this.ctx, repo, num));
			case "review":
				return await this.handleReviewCommand(repo, num);
			case "pause":
				await this.service.store.setPrState(repo, num, { paused: true });
				return run(
					replyInstr(
						this.ctx,
						repo,
						num,
						`⏸️ 이 PR 자동 리뷰 일시정지했어. \`${this.ctx.mention} resume\` 로 재개.`,
					),
				);
			case "resume":
				await this.service.store.setPrState(repo, num, { paused: false });
				return run(
					replyInstr(
						this.ctx,
						repo,
						num,
						`▶️ 자동 리뷰 재개. \`${this.ctx.mention} review\` 로 지금 바로 돌릴 수도 있어.`,
					),
				);
			case "learn": {
				// `learn` is persistent prompt state injected into every future
				// review — a stricter trust boundary than one-shot commands.
				if (!this.isAllowed(authorAssociation, this.config.learnAssociations)) {
					this.service.logEvent("unauthorized", { repo, pr: num, kind: "learn" });
					return run(replyInstr(this.ctx, repo, num, "🔒 `learn` 은 리포 오너만 쓸 수 있어."));
				}
				this.service.addLearning(repo, args);
				return run(replyInstr(this.ctx, repo, num, `🧠 학습함: ${args}  (이후 리뷰에 반영할게.)`));
			}
			default:
				return null;
		}
	}

	/**
	 * `<mention> review` — same gate as the auto path (in-flight dedup /
	 * supersede / queue), then a forced review. Fail-open to the $SHA agent
	 * flow when the head sha can't be resolved in budget.
	 */
	private async handleReviewCommand(repo: string, num: number): Promise<RouteAction> {
		const sha = await this.service.fetchHeadSha(repo, num);
		if (!sha) {
			this.service.logEvent("cmd_review_no_sha", { repo, pr: num });
			return run(forceReviewInstr(this.ctx, repo, num));
		}
		const { status, state } = await this.service.store.tryAcquireReview(repo, num, sha, this.config.maxInflight);
		this.service.logEvent("trigger", { mode: "cmd_review", repo, pr: num, sha, gate: status });
		switch (status) {
			case "duplicate": {
				if (state.dup_notified_sha === sha) return silent("duplicate already notified"); // 재알림 스팸 금지
				await this.service.store.setPrState(repo, num, { dup_notified_sha: sha });
				return run(
					replyInstr(
						this.ctx,
						repo,
						num,
						`⏳ 이미 이 커밋(\`${sha.slice(0, 7)}\`) 리뷰가 돌고 있어. 끝나면 결과가 올라온다.`,
					),
				);
			}
			case "superseded":
				return run(
					replyInstr(
						this.ctx,
						repo,
						num,
						`⏳ 진행 중인 리뷰가 끝나는 대로 최신 커밋(\`${sha.slice(0, 7)}\`)으로 다시 리뷰할게.`,
					),
				);
			case "queued":
				return run(
					replyInstr(
						this.ctx,
						repo,
						num,
						"⏳ 동시 리뷰 상한에 걸려 대기열에 넣었어. 차례가 오면 자동으로 시작한다.",
					),
				);
			default: {
				await this.service.startReviewAcks(repo, num, sha);
				return run(forceReviewInstr(this.ctx, repo, num, sha), { repo, pr: num, sha });
			}
		}
	}

	// ── mode: full code review (pull_request opened/reopened/ready/sync) ──
	private async routePullRequest(payload: Record<string, unknown>, repo: string): Promise<RouteAction> {
		const action = payload.action as string | undefined;
		if (!action || !REVIEW_ACTIONS.has(action)) return silent("pr action");
		const pr = payload.pull_request as {
			draft?: boolean;
			user?: GithubUser;
			head?: { sha?: string };
			base?: { ref?: string };
			author_association?: unknown;
		};
		if (pr.draft) return silent("draft");
		if (isBot(pr.user ?? {})) return silent("bot author");
		const num = (payload.number as number | undefined) ?? 0;
		const prState = this.service.store.getPrState(repo, num);
		if (prState.paused) return silent("paused"); // `<mention> pause` 된 PR은 자동 리뷰 안 함
		const headSha = pr.head?.sha ?? "";
		const token = await this.service.tokens.tokenOrEmpty();
		// Repo config comes from the PR **base** branch, never the head: a fork
		// PR could otherwise inject path_instructions/tone into its own review
		// prompt. No base ref → no config (fail-closed).
		const baseRef = pr.base?.ref ?? "";
		const cfg: RepoReviewConfig = baseRef
			? await loadRepoConfig(this.service.api, token, repo, baseRef, this.config.repoConfigFile)
			: {};
		if (cfg.enabled === false) return silent("disabled by repo config");
		const lastSha = prState.last_reviewed_sha;
		if (lastSha && lastSha === headSha) return silent("sha already reviewed"); // 재배달/무변경 push 방지

		const { status } = await this.service.store.tryAcquireReview(repo, num, headSha, this.config.maxInflight);
		this.service.logEvent("trigger", { mode: "auto", action, repo, pr: num, sha: headSha, gate: status });
		if (status !== "acquired") return silent(`gate ${status}`); // 완료헬퍼·sweeper가 이어받음

		const incremental = action === "synchronize" && !!lastSha;
		await this.service.startReviewAcks(repo, num, headSha);
		const learnings = this.service.getLearnings(repo);
		const instruction = buildReview(this.ctx, repo, num, headSha, {
			closeLine: closeLineFor(this.ctx, repo, num, headSha),
			incremental,
			// The 4.5 cleanup mutates via the operator's user-scoped `gh`;
			// only trusted PR authors may steer that lane.
			resolveOutdatedThreads: this.isTrusted(pr.author_association),
			baseSha: lastSha,
			config: cfg,
			learnings,
		});
		return run(instruction, { repo, pr: num, sha: headSha });
	}

	private isTrusted(association: unknown): boolean {
		return this.isAllowed(association, this.config.allowedAssociations);
	}

	private isAllowed(association: unknown, allowed: string[]): boolean {
		return typeof association === "string" && allowed.includes(association.toUpperCase());
	}
}

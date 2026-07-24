/**
 * Idempotent completion + drain: the single code-owned exit point of a review
 * run. The LLM turn invokes `gjc github-review complete` as its last step;
 * the runner invokes it on timeout/crash; the sweeper invokes it for stale
 * runs. Safe to re-run.
 *
 *   1. release the in-flight state lock (ReviewStateStore.completeReview)
 *   2. close the check-run (by stored check_id, else by sha lookup)
 *   3. flip the live status line in the marked summary comment (✅ / ❌)
 *   4. drain: requeue pending (superseded) / queued PRs via a synthetic
 *      signed webhook POST, paced under the gateway rate limit
 */
import * as crypto from "node:crypto";
import type { ReviewService } from "./service";

export type Verdict = "success" | "failure" | "neutral";

const DRAIN_MAX = 2;
const DRAIN_PACE_MS = 3000;

/**
 * Re-trigger a review by POSTing a synthetic signed pull_request event to the
 * local gateway. Routes through the normal gate → natural dedup.
 */
export async function requeueReview(service: ReviewService, repo: string, pr: number, sha: string): Promise<boolean> {
	const { webhookSecret, localWebhookUrl } = service.config;
	const payload = {
		action: "synchronize",
		number: pr,
		pull_request: {
			title: "(review requeue)",
			draft: false,
			user: { login: "gjc-review-requeue", type: "User" },
			head: { ref: "", sha },
			base: { ref: "" },
		},
		repository: { full_name: repo },
	};
	const body = Buffer.from(JSON.stringify(payload));
	const signature = `sha256=${crypto.createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
	try {
		const res = await fetch(localWebhookUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Hub-Signature-256": signature,
				"X-GitHub-Event": "pull_request",
				"X-GitHub-Delivery": `gjc-requeue-${crypto.randomUUID()}`,
				"User-Agent": "gjc-review-requeue",
			},
			body,
		});
		service.logEvent("requeue", { repo, pr, sha, ok: res.ok });
		return res.ok;
	} catch (error) {
		service.logEvent("requeue_failed", { repo, pr, sha, error: String(error) });
		return false;
	}
}

/** Kick the next waiting review(s), respecting the concurrency cap. */
export async function drainWaiters(
	service: ReviewService,
	exclude?: { repo: string; pr: number },
	pendingFirst?: { repo: string; pr: number; sha: string },
): Promise<void> {
	const todo: Array<{ repo: string; pr: number; sha: string }> = [];
	if (pendingFirst) todo.push(pendingFirst);
	const free = Math.max(0, service.config.maxInflight - service.store.countInflight() - todo.length);
	for (const cand of service.store.findDrainCandidates(free)) {
		if (exclude && cand.repo === exclude.repo && cand.pr === exclude.pr) continue;
		todo.push(cand);
	}
	for (const [i, item] of todo.slice(0, DRAIN_MAX).entries()) {
		if (i > 0) await new Promise(resolve => setTimeout(resolve, DRAIN_PACE_MS)); // rate-limit pacing
		await requeueReview(service, item.repo, item.pr, item.sha);
	}
}

/** Finish the review of `sha` on repo#pr. Never throws. */
export async function completeReviewRun(
	service: ReviewService,
	repo: string,
	pr: number,
	sha: string,
	verdict: Verdict,
): Promise<void> {
	try {
		const ok = verdict === "success";
		const conclusion: Verdict = verdict === "success" || verdict === "failure" ? verdict : "neutral";
		const result = await service.store.completeReview(repo, pr, sha, ok);
		if (result.stale) {
			// A newer review owns the lock — just close our own check by sha.
			await service.closeCheck(repo, sha, null, conclusion);
			service.logEvent("complete_stale", { repo, pr, sha });
			return;
		}
		const closed = await service.closeCheck(repo, sha, result.checkId, conclusion);
		const short = sha === "$SHA" ? sha : sha.slice(0, 7);
		const line = ok
			? `✅ ${service.config.botDisplayName} 리뷰 완료 (head \`${short}\`)`
			: `❌ 리뷰가 정상 종료되지 않았어 (head \`${short}\`) — \`${service.mention()} review\` 로 재시도`;
		await service.upsertStatusLine(repo, pr, line);
		service.logEvent("complete", {
			repo,
			pr,
			sha,
			ok,
			checks_closed: closed,
			pending: result.pendingSha,
			duration_s: result.durationSeconds,
		});
		await drainWaiters(service, { repo, pr }, result.pendingSha ? { repo, pr, sha: result.pendingSha } : undefined);
	} catch (error) {
		// Never leave the caller hanging on our bugs.
		service.logEvent("complete_error", { repo, pr, sha, error: String(error) });
	}
}

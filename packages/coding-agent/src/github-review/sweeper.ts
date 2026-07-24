/**
 * Failsafe sweeper for review check-runs and state.
 *
 * The router creates an `in_progress` check-run the instant a PR event fires,
 * but a crashed/hung agent turn would leave it open FOREVER — GitHub never
 * auto-expires API-created check-runs. The sweeper:
 *
 *   1. closes any bot check-run stuck `in_progress` past `sweepStaleMinutes`
 *      (skipping fresh in-flight reviews — the state machine is the source of
 *      truth; reviews routinely run 8–15 minutes);
 *   2. force-completes stale in_flight state entries through the idempotent
 *      completion path (threshold `inflightStaleSeconds`, deliberately LONGER
 *      than the check sweep so a slow-but-alive review isn't drained over);
 *   3. drains leftover pending/queued PRs when slots are free;
 *   4. requeues open PRs GitHub never delivered an `opened` webhook for
 *      (observed in production: PRs receiving review_requested+edited but no
 *      opened delivery).
 *
 * Idempotent + best-effort: safe on a schedule, never throws.
 */
import { completeReviewRun, requeueReview } from "./complete";
import type { CheckRunInfo, ReviewService } from "./service";

const MISS_GRACE_MIN = 10;
const MISS_LOOKBACK_MIN = 24 * 60;

export interface SweepResult {
	checksClosed: number;
	forceCompleted: number;
	drained: number;
	missedRequeued: number;
}

interface OpenPr {
	number?: number;
	draft?: boolean;
	created_at?: string;
	user?: { login?: string; type?: string };
	head?: { sha?: string };
}

function ageMinutes(iso: string | undefined, now: number): number {
	if (!iso) return 0;
	const started = Date.parse(iso);
	return Number.isFinite(started) ? (now - started) / 60_000 : 0;
}

/** Open PRs with no state entry: candidates for a missed `opened` webhook. */
export function detectMissedPrs(
	stateKeys: Set<string>,
	repo: string,
	prs: OpenPr[],
	nowMs = Date.now(),
): Array<{ repo: string; pr: number; sha: string; ageMin: number }> {
	const out: Array<{ repo: string; pr: number; sha: string; ageMin: number }> = [];
	for (const pr of prs) {
		const num = pr.number;
		const sha = pr.head?.sha;
		if (!num || !sha) continue;
		if (stateKeys.has(`${repo}#${num}`) || pr.draft) continue;
		const user = pr.user ?? {};
		if (user.type === "Bot" || (user.login ?? "").endsWith("[bot]")) continue;
		const age = ageMinutes(pr.created_at, nowMs);
		// Grace avoids racing a normal delivery; lookback avoids resurrecting
		// ancient pre-bot PRs.
		if (age >= MISS_GRACE_MIN && age <= MISS_LOOKBACK_MIN) {
			out.push({ repo, pr: num, sha, ageMin: Math.floor(age) });
		}
	}
	return out;
}

export async function runSweep(
	service: ReviewService,
	options: { dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<SweepResult> {
	const { dryRun = false, log = () => {} } = options;
	const result: SweepResult = { checksClosed: 0, forceCompleted: 0, drained: 0, missedRequeued: 0 };
	const token = await service.tokens.tokenOrEmpty();
	if (!token) {
		log("sweep: no token; abort");
		return result;
	}
	const entries = service.store.entries();
	const stateKeys = new Set(entries.map(([k]) => k));
	const repos = [...new Set(entries.map(([k]) => k.slice(0, k.lastIndexOf("#"))).filter(Boolean))];
	const nowMs = Date.now();
	const nowSec = Math.floor(nowMs / 1000);
	const staleMs = service.config.sweepStaleMinutes * 60_000;
	const missed: Array<{ repo: string; pr: number; sha: string; ageMin: number }> = [];

	// ── 1. stale check-runs on open PRs ──
	for (const repo of repos) {
		const prs = await service.api.tryRequest<OpenPr[]>(`/repos/${repo}/pulls?state=open&per_page=100`, { token });
		if (!Array.isArray(prs)) continue;
		missed.push(...detectMissedPrs(stateKeys, repo, prs, nowMs));
		for (const pr of prs) {
			const sha = pr.head?.sha;
			if (!pr.number || !sha) continue;
			// 상태머신이 진실의 원천: fresh in_flight(정상 진행 중) 리뷰의 체크런은
			// 건드리지 않는다 — 리뷰는 통상 8~15분 걸린다.
			const entry = entries.find(([k]) => k === `${repo}#${pr.number}`)?.[1];
			if (
				entry?.review_status === "in_flight" &&
				entry.in_flight_sha === sha &&
				nowSec - (entry.in_flight_since ?? 0) < service.config.inflightStaleSeconds
			) {
				continue; // 살아있는 리뷰 — 넘치면 아래 reconcile 이 처리
			}
			const res = await service.api.tryRequest<{ check_runs?: CheckRunInfo[] }>(
				`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(service.config.checkName)}`,
				{ token },
			);
			for (const cr of res?.check_runs ?? []) {
				if (cr.name !== service.config.checkName || cr.status !== "in_progress") continue;
				const mins = ageMinutes(cr.started_at, nowMs);
				if (mins * 60_000 < staleMs) continue;
				if (dryRun) {
					log(`sweep DRY: would close ${repo} check ${cr.id} (in_progress ${Math.floor(mins)}m)`);
					result.checksClosed += 1;
					continue;
				}
				const patched = await service.api.tryRequest(`/repos/${repo}/check-runs/${cr.id}`, {
					method: "PATCH",
					body: {
						status: "completed",
						conclusion: "neutral",
						output: {
							title: "리뷰 시간 초과로 정리됨",
							summary:
								`리뷰 세션이 ${Math.floor(mins)}분 이상 응답이 없어 stuck 체크런을 자동 정리했습니다. ` +
								`필요하면 \`${service.mention()} review\` 로 재요청하세요.`,
						},
					},
					token,
				});
				if (patched !== null) {
					result.checksClosed += 1;
					log(`sweep: closed ${repo} check ${cr.id} (was in_progress ${Math.floor(mins)}m)`);
				}
			}
		}
	}

	// ── 2. force-complete stale in_flight state entries ──
	for (const [key, entry] of entries) {
		if (entry.review_status !== "in_flight") continue;
		const age = nowSec - (entry.in_flight_since ?? 0);
		if (age < service.config.inflightStaleSeconds) continue;
		const hash = key.lastIndexOf("#");
		const repo = key.slice(0, hash);
		const pr = Number(key.slice(hash + 1));
		const sha = entry.in_flight_sha ?? "";
		if (!repo || !Number.isInteger(pr) || !sha) continue;
		if (dryRun) {
			log(`sweep DRY: would force-complete ${key} (in_flight ${Math.floor(age / 60)}m)`);
			result.forceCompleted += 1;
			continue;
		}
		log(`sweep: force-completing stale review ${key} (in_flight ${Math.floor(age / 60)}m)`);
		service.logEvent("sweeper_force_complete", { repo, pr, sha, age_min: Math.floor(age / 60) });
		await completeReviewRun(service, repo, pr, sha, "failure");
		result.forceCompleted += 1;
	}

	// ── 3. drain waiters even when nothing went stale (missed-drain safety net) ──
	if (!dryRun) {
		const free = Math.max(0, service.config.maxInflight - service.store.countInflight());
		for (const [i, cand] of service.store.findDrainCandidates(Math.min(free, 2)).entries()) {
			if (i > 0) await new Promise(resolve => setTimeout(resolve, 3000)); // rate-limit pacing
			log(`sweep: draining queued review ${cand.repo}#${cand.pr} @ ${cand.sha.slice(0, 7)}`);
			await requeueReview(service, cand.repo, cand.pr, cand.sha);
			result.drained += 1;
		}
	}

	// ── 4. missed-webhook recovery, paced ──
	for (const m of missed.slice(0, 2)) {
		if (dryRun) {
			log(`sweep DRY: would requeue missed PR ${m.repo}#${m.pr} @ ${m.sha.slice(0, 7)} (age ${m.ageMin}m)`);
			result.missedRequeued += 1;
			continue;
		}
		log(
			`sweep: requeueing missed PR ${m.repo}#${m.pr} @ ${m.sha.slice(0, 7)} (opened webhook lost, age ${m.ageMin}m)`,
		);
		service.logEvent("missed_pr_requeue", { repo: m.repo, pr: m.pr, sha: m.sha, age_min: m.ageMin });
		await requeueReview(service, m.repo, m.pr, m.sha);
		result.missedRequeued += 1;
	}
	return result;
}

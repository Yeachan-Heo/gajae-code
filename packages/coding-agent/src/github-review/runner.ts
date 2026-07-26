/**
 * Executes router instructions in embedded agent sessions with a concurrency
 * cap and a hard per-turn deadline.
 *
 * Reviews carry `{repo, pr, sha}` metadata: when a review session ends
 * abnormally (timeout, error, abort) the runner force-completes the run as a
 * failure immediately instead of waiting for the sweeper — check-run closed,
 * state released, waiters drained.
 */
import { completeReviewRun } from "./complete";
import type { GithubReviewConfig } from "./config";
import type { RouteAction } from "./router";
import type { ReviewService } from "./service";

/**
 * Review sessions consume attacker-controlled PR content (diff, title, body,
 * comments), so they get a deliberately narrow tool surface: no edit, no task
 * fan-out, no tool discovery, and bash locked to the "workflow" restriction
 * profile — one prefix-allowlisted command per call, with pipes, redirects,
 * command substitution, and `$VAR` expansion rejected by the tool itself.
 */
export const REVIEW_SESSION_TOOLS = ["read", "search", "find", "write", "bash"] as const;

/** Session options for one review run (pure; unit-tested without the SDK). */
export function reviewSessionOptions(config: GithubReviewConfig): {
	cwd: string;
	modelPattern?: string;
	toolNames: string[];
	bashRestrictionProfile: "workflow";
	bashAllowedPrefixes: string[];
	discoverableToolAllowedNames: readonly string[];
} {
	return {
		cwd: config.cwd,
		...(config.modelPattern ? { modelPattern: config.modelPattern } : {}),
		toolNames: [...REVIEW_SESSION_TOOLS],
		bashRestrictionProfile: "workflow",
		bashAllowedPrefixes: [...config.sessionBashPrefixes],
		discoverableToolAllowedNames: [],
	};
}

export interface RunnerStatus {
	running: number;
	queued: number;
}

export class InstructionRunner {
	private running = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(
		private readonly service: ReviewService,
		private readonly log: (line: string) => void = () => {},
	) {}

	status(): RunnerStatus {
		return { running: this.running, queued: this.waiters.length };
	}

	/** Wait until all running sessions finish (graceful drain), up to `timeoutMs`. */
	async drain(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.running > 0 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return this.running === 0;
	}

	private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
		if (this.running >= this.service.config.maxInflight) {
			await new Promise<void>(resolve => this.waiters.push(resolve));
		}
		this.running += 1;
		try {
			return await fn();
		} finally {
			this.running -= 1;
			this.waiters.shift()?.();
		}
	}

	/** Fire-and-forget entry point: GitHub expects a fast 200; reviews run for minutes. */
	dispatch(delivery: string, action: Extract<RouteAction, { kind: "run" }>): void {
		void this.execute(delivery, action).catch(async error => {
			this.log(`[${delivery}] session failed: ${String(error).slice(0, 600)}`);
			if (action.review) {
				await completeReviewRun(this.service, action.review.repo, action.review.pr, action.review.sha, "failure");
			}
		});
	}

	private async execute(delivery: string, action: Extract<RouteAction, { kind: "run" }>): Promise<void> {
		await this.withSlot(async () => {
			const started = Date.now();
			const { config } = this.service;
			this.log(`[${delivery}] session start (running=${this.running})`);
			// Lazy: pulls in the full SDK (incl. native addons) only when a
			// session actually starts, keeping CLI/tests light.
			const { createAgentSession } = await import("../sdk/session");
			const { session } = await createAgentSession(reviewSessionOptions(config));
			const { promise, resolve } = Promise.withResolvers<string | null>();
			const unsubscribe = session.subscribe(event => {
				if (event.type !== "agent_end") return;
				const stopReason = (event as { stopReason?: string }).stopReason;
				if (stopReason === "maintenance") return;
				resolve(stopReason ?? null);
			});
			const deadline = setTimeout(() => {
				resolve("review_timeout");
				void session.abort().catch(() => {});
			}, config.turnTimeoutMinutes * 60_000);
			let stopReason: string | null = null;
			try {
				await session.prompt(action.instruction);
				stopReason = await promise;
				const mins = Math.round((Date.now() - started) / 60_000);
				this.log(`[${delivery}] session end (${stopReason}, ${mins}min)`);
			} finally {
				clearTimeout(deadline);
				unsubscribe();
				await session.dispose().catch(() => {});
			}
			if (action.review && stopReason !== "completed" && stopReason !== null) {
				// Abnormal end (timeout/error/abort): the in-turn complete step never
				// ran — finish the lifecycle as a failure now (idempotent if it did).
				await completeReviewRun(this.service, action.review.repo, action.review.pr, action.review.sha, "failure");
			}
		});
	}
}

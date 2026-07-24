/**
 * `gjc github-review` — built-in GitHub code-review bot.
 *
 *   serve            run the webhook server (HMAC verify → router → embedded sessions)
 *   sweep            one-shot sweep (stale check-runs, crashed runs, missed PRs)
 *   complete R N SHA V   idempotent review completion (invoked by agent turns)
 *   token            print a fresh App installation token
 *   gh <args...>     run `gh` authenticated as the App (posting identity)
 *   status           dump review state entries
 */
import { spawn } from "node:child_process";
import { Args, Command, Flags } from "@gajae-code/utils/cli";

const ACTIONS = new Set(["serve", "sweep", "complete", "token", "gh", "status"]);

export default class GithubReview extends Command {
	static description = "Built-in GitHub code-review bot (webhook server, sweeper, completion helper)";
	static strict = false;

	static args = {
		action: Args.string({ description: "serve|sweep|complete|token|gh|status", required: true }),
	};

	static flags = {
		config: Flags.string({ description: "Path to github-review.json config" }),
		"dry-run": Flags.boolean({ description: "sweep: report only, close nothing", default: false }),
		json: Flags.boolean({ char: "j", description: "status: machine-readable JSON", default: false }),
	};

	static examples = [
		"gjc github-review serve",
		"gjc github-review sweep --dry-run",
		"gjc github-review complete owner/repo 42 <sha> success",
		"gjc github-review gh pr comment 42 --repo owner/repo --body 'hi'",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(GithubReview);
		const argv = this.argv.filter(a => a !== "--dry-run" && a !== "--json" && a !== "-j");
		const configFlagIndex = argv.indexOf("--config");
		if (configFlagIndex >= 0) argv.splice(configFlagIndex, 2);
		const [action, ...rest] = argv;
		if (!action || !ACTIONS.has(action)) {
			console.error(`Unknown github-review action: ${action ?? "(none)"}`);
			console.error(`Valid actions: ${[...ACTIONS].join(", ")}`);
			process.exitCode = 2;
			return;
		}
		const { loadGithubReviewConfig } = await import("../github-review/config");
		const config = loadGithubReviewConfig(flags.config);

		switch (action) {
			case "serve":
				return await this.serve(config);
			case "sweep": {
				const { ReviewService } = await import("../github-review/service");
				const { runSweep } = await import("../github-review/sweeper");
				const result = await runSweep(new ReviewService(config), {
					dryRun: flags["dry-run"],
					log: line => console.error(line),
				});
				console.log(JSON.stringify(result));
				return;
			}
			case "complete": {
				const [repo, num, sha, verdict] = rest;
				const pr = Number(num);
				if (!repo || !Number.isInteger(pr) || !sha || !verdict) {
					console.error("usage: gjc github-review complete <owner/repo> <pr> <sha> <success|failure|neutral>");
					process.exitCode = 2;
					return;
				}
				const { ReviewService } = await import("../github-review/service");
				const { completeReviewRun } = await import("../github-review/complete");
				const v = verdict === "success" || verdict === "failure" || verdict === "neutral" ? verdict : "neutral";
				await completeReviewRun(new ReviewService(config), repo, pr, sha, v);
				return;
			}
			case "token": {
				const { AppTokenProvider } = await import("../github-review/github");
				console.log(await new AppTokenProvider(config).token());
				return;
			}
			case "gh": {
				const { AppTokenProvider } = await import("../github-review/github");
				const token = await new AppTokenProvider(config).token();
				const child = spawn("gh", rest, {
					stdio: "inherit",
					env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
				});
				process.exitCode = await new Promise<number>(resolve => child.on("close", code => resolve(code ?? 1)));
				return;
			}
			case "status": {
				const { ReviewService } = await import("../github-review/service");
				const service = new ReviewService(config);
				const entries = Object.fromEntries(service.store.entries());
				console.log(flags.json ? JSON.stringify(entries) : JSON.stringify(entries, null, 2));
				return;
			}
		}
	}

	private async serve(config: import("../github-review/config").GithubReviewConfig): Promise<void> {
		const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

		// ── exit guard ──────────────────────────────────────────────────
		// A daemon embedding the SDK must never let library code kill running
		// reviews: the session command surface exposes a `shutdown` binding
		// that calls process.exit(0) (observed in production: clean exits mid-
		// review). Block foreign exits loudly; only our signal path may exit.
		const realExit = process.exit.bind(process);
		let exitAllowed = false;
		process.exit = ((code?: number) => {
			if (exitAllowed) return realExit(code);
			log(`BLOCKED process.exit(${code ?? 0})\n${new Error("exit blocked").stack}`);
			return undefined as never;
		}) as typeof process.exit;
		process.on("beforeExit", code => {
			log(`beforeExit(${code}) — event loop drained unexpectedly`);
		});

		const { startGithubReviewServer } = await import("../github-review/server");
		const server = await startGithubReviewServer(config, log);

		let draining = false;
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			process.on(signal, () => {
				if (draining) {
					exitAllowed = true;
					realExit(0);
				}
				draining = true;
				const { running, queued } = server.runner.status();
				log(`${signal} — draining (running=${running}, queued=${queued})`);
				void (async () => {
					await server.close();
					await server.runner.drain(150_000);
					exitAllowed = true;
					log("drained — exiting");
					realExit(0);
				})();
			});
		}
		// Keep serving until a signal arrives.
		await new Promise<never>(() => {});
	}
}

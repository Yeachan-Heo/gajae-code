import { GjcTeamWorkerHeartbeatReporter } from "../../src/gjc-runtime/team-worker-heartbeat";

if (process.env.TEST_HEARTBEAT_MODE === "publish") {
	const reporter = GjcTeamWorkerHeartbeatReporter.forProcess(() => process.env.WORK_CWD ?? process.cwd());
	if (!reporter) throw new Error("no reporter resolved from worker env");
	reporter.start();
}

await Bun.sleep(600_000);

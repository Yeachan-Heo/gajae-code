import { exportTaskDecisionEvents } from "../packages/coding-agent/src/task/decision-collection";

const includeContent = process.argv.includes("--include-content");
const args = process.argv.slice(2);
if (args.includes("--help")) {
	process.stdout.write("Usage: bun scripts/export-task-decisions.ts [--include-content]\n");
	process.exit(0);
}
const unknown = args.filter(arg => arg !== "--include-content");
if (unknown.length > 0) {
	process.stderr.write("unknown option\n");
	process.exitCode = 2;
	process.exit();
}
try {
	const events = await exportTaskDecisionEvents({ includeContent });
	for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
} catch {
	process.stderr.write("task decision export failed\n");
	process.exitCode = 1;
}

import { writeCrashReport } from "../src/debug/crash-diagnostics";

const destination = process.argv[2];
if (!destination) throw new Error("missing destination");
process.chdir(destination);
const result = await writeCrashReport(
	{ kind: "bash", exitCode: 1, stderr: "boom" },
	{ env: process.env, now: new Date("2026-06-04T00:00:10.000Z") },
);
process.stdout.write(`${result.path ?? ""}\n`);

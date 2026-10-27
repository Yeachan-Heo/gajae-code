// A/B adapter: opt-in native crash-diagnostics initialization in fresh processes.
import { resolve } from "node:path";
import { runAbSuite } from "./ab-adapter";

const root = resolve(import.meta.dir, "../../..");
const nativeEntryUrl = new URL("../native/index.js", import.meta.url).href;
const optInVariable = "GJC_NATIVE_CRASH_DIAGNOSTICS";

async function runProbe(enabled: boolean, expected: boolean): Promise<void> {
	const env = { ...Bun.env };
	delete env[optInVariable];
	delete env.GJC_CRASH_DIAGNOSTICS_DIR;
	if (enabled) env[optInVariable] = "1";

	const script = `import { initNativeCrashDiagnostics } from ${JSON.stringify(nativeEntryUrl)};
const result = initNativeCrashDiagnostics();
if (result !== ${expected}) throw new Error(\`expected ${expected}, received \${String(result)}\`);
process.stdout.write(String(result));`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		cwd: root,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Crash diagnostics child exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	}
	if (stdout !== String(expected)) {
		throw new Error(`Crash diagnostics child returned ${JSON.stringify(stdout)}, expected ${String(expected)}`);
	}
	if (stderr !== "") throw new Error(`Crash diagnostics child wrote to stderr: ${stderr.trim()}`);
}

await runAbSuite(
	"crash",
	[
		{ id: "C01", run: () => runProbe(true, true), warmup: 0 },
		{ id: "C02", run: () => runProbe(false, false), warmup: 0 },
	],
	10,
);

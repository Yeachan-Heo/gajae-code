import * as path from "node:path";

const codingAgentDir = path.resolve(import.meta.dir, "../packages/coding-agent");
export const sdkProductionHostIsolatedSuites = [
	{
		file: "test/sdk-chat-daemon-worker.test.ts",
		pattern: "routes Slack safe queries through the production Session SDK host",
	},
	{ file: "test/sdk-prompt-terminal-diagnostics.test.ts", pattern: "SDK host" },
] as const;

type IsolatedSuite = (typeof sdkProductionHostIsolatedSuites)[number];

async function runSuite(suite: IsolatedSuite): Promise<number> {
	const child = Bun.spawn([process.execPath, "test", suite.file, "-t", suite.pattern], {
		cwd: codingAgentDir,
		env: { ...process.env, GJC_CI_SDK_HOST_ISOLATED: "1" },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await child.exited;
}

export async function runSdkProductionHostIsolated(
	executeSuite: (suite: IsolatedSuite) => Promise<number> = runSuite,
): Promise<number> {
	for (const suite of sdkProductionHostIsolatedSuites) {
		const exitCode = await executeSuite(suite);
		if (exitCode !== 0) return exitCode;
	}
	return 0;
}

if (import.meta.main) process.exitCode = await runSdkProductionHostIsolated();

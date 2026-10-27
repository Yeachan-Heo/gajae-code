import { tmpdir } from "node:os";
import { Settings } from "../../coding-agent/src/config/settings";
import { disposeAllShellSessions, executeBash } from "../../coding-agent/src/exec/bash-executor";
import { runAbSuite } from "./ab-adapter";

const settings = Settings.isolated();

await runAbSuite(
	"tools:bash",
	[
		{
			// B01: execute a trivial successful command through the coding-agent executor.
			id: "B01",
			run: async () => {
				const result = await executeBash("true", {
					cwd: tmpdir(),
					settings,
					sessionKey: "native-bench-tools-bash",
					timeout: 5_000,
					ignoreShellPrefix: true,
					disableShellSnapshot: true,
				});
				if (result.exitCode !== 0 || result.cancelled) {
					throw new Error(`trivial command failed (exitCode=${result.exitCode}, cancelled=${result.cancelled})`);
				}
			},
		},
	],
	80,
).finally(disposeAllShellSessions);

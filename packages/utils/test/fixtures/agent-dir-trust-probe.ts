// Prints what the credential resolver returns for a probe variable, plus the
// agent directory in effect. Spawned with a controlled cwd so the caller can
// plant a project `.env`: `projectEnv` and the agent-dir override are both
// resolved at module load from `process.cwd()`.
import { getAgentDir } from "../../src/dirs";
import { $credentialEnv } from "../../src/env";

console.log(
	JSON.stringify({
		agentDir: getAgentDir(),
		probeValue: $credentialEnv("GJC_TRUST_PROBE_VALUE") ?? null,
	}),
);

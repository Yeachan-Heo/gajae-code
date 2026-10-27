// Prints the ACP permission mode resolved in this process. Spawned with a
// controlled cwd so the caller can plant a project `.env`, which is parsed at
// module load from `process.cwd()`.
import { applyAcpPermissionMode } from "../../src/modes/acp/acp-agent";
import { createAcpClientBridge } from "../../src/modes/acp/acp-client-bridge";

const modes: string[] = [];
await applyAcpPermissionMode(
	{
		control: async (_name: string, input: { mode?: unknown }) => {
			modes.push(String(input.mode));
		},
	} as never,
	undefined,
);
const bridge = createAcpClientBridge({} as never, "session-1", undefined);
process.stdout.write(
	`${JSON.stringify({
		mode: modes[0] ?? null,
		requestPermission: bridge.capabilities.requestPermission === true,
	})}\n`,
);

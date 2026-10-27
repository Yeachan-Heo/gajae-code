// Public `ooo` entry with a controlled cwd so Bun loads that directory's `.env`
// before the bridge resolves the executable override. PATH is the process
// start value: Bun does not re-read a later `process.env.PATH` assignment
// when a spawn omits `env`.
import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";
import { createOuroborosOooBridge } from "../../src/extensibility/extensions/ouroboros-ooo-bridge";
import type { ExtensionContext, InputEvent } from "../../src/extensibility/extensions/types";

const notes: string[] = [];
const handler = createOuroborosOooBridge();
const result = await handler(
	{ type: "input", text: "ooo status", source: "interactive" } as InputEvent,
	{
		cwd: process.cwd(),
		ui: {
			notify(message: string) {
				notes.push(message);
			},
		},
	} as unknown as ExtensionContext,
);
const mcpEnv = projectSafeSpawnEnv();
console.log(
	JSON.stringify({
		result,
		parent: process.env.OUROBOROS_CLI ?? null,
		notes,
		mcpCli: mcpEnv.OUROBOROS_CLI ?? null,
	}),
);

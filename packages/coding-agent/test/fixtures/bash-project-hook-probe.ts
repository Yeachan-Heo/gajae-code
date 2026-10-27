// Runs `git status` through the bash tool's real execution paths (isolated
// non-PTY worker and interactive PTY) from the caller-chosen cwd, so the caller
// can plant a project `.env` whose hook variables point at a marker script.
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { executeBash, setShellFactoryForTests } from "@gajae-code/coding-agent/exec/bash-executor";
import { runInteractiveBashPty } from "@gajae-code/coding-agent/tools/bash-interactive";
import { Shell } from "@gajae-code/natives";

const mode = process.argv[2];
const command = process.env.GJC_TEST_PROBE_COMMAND ?? "git status --short >/dev/null 2>&1; echo probe-done";
// `inprocess` drives the native shell directly in this process, the path Windows
// uses, where the shell imports the host environment before `sessionEnv`.
if (mode === "inprocess") {
	setShellFactoryForTests(async options => new Shell(options));
}
const cwd = process.cwd();
// `shellPath` is read from global settings only, so set it there.
const shellPath = process.env.GJC_TEST_SHELL_PATH;
const settings = shellPath ? Settings.isolated({ shellPath }) : await Settings.init({ inMemory: true, cwd });
const dotenvAfterStartup = process.env.GJC_TEST_DOTENV_AFTER_START;
if (dotenvAfterStartup !== undefined) await Bun.write(path.join(cwd, ".env"), dotenvAfterStartup);

function headlessUi(): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(factory: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				let component: { dispose?: () => void } | undefined;
				try {
					component = (
						factory as (
							tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
							theme: Record<string, never>,
							keybindings: Record<string, never>,
							done: (result: T) => void,
						) => { dispose?: () => void }
					)({ terminal: { rows: 24, columns: 80 }, requestRender: () => {} }, {}, {}, result => {
						component?.dispose?.();
						resolve(result);
					});
				} catch (error) {
					reject(error);
				}
			});
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

const result =
	mode === "pty"
		? await runInteractiveBashPty(headlessUi(), { command, cwd, timeoutMs: 20_000, settings })
		: await executeBash(command, { cwd, settings, timeout: 20_000, oneShot: true });
console.log(JSON.stringify({ exitCode: result.exitCode, done: result.output.includes("probe-done") }));
process.exit(0);

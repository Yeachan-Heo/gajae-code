/**
 * Parent already loaded a project dotenv. Move to a directory with no dotenv
 * and build the tmux relaunch environment the way launch does, then run the
 * public root command there.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { Args } from "../../src/cli/args";
import { launchDefaultTmuxIfNeeded } from "../../src/gjc-runtime/launch-tmux";
import { tmuxLaunchIdentityEnv } from "../../src/gjc-runtime/tmux-sessions";

const target = process.argv[2];
const marker = process.argv[3];
const rootProbe = process.argv[4];
if (!target || !marker || !rootProbe) {
	process.stderr.write("usage: herdr-project-bin-path-handoff-probe.ts <target> <marker> <root-probe>\n");
	process.exit(2);
}

function rootArgs(): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
		mode: "text",
	};
}

process.chdir(target);
const launched = launchDefaultTmuxIfNeeded({
	parsed: rootArgs(),
	rawArgs: [],
	cwd: target,
	tty: { stdin: false, stdout: false },
	tmuxAvailable: false,
	platform: process.platform,
});
const filtered = tmuxLaunchIdentityEnv(process.env, target);
const child = spawnSync(process.execPath, [rootProbe, "attack"], {
	cwd: target,
	env: filtered,
	encoding: "utf8",
	timeout: 120_000,
});
const line = (child.stdout ?? "").split("\n").find(entry => entry.startsWith("RESULT "));
process.stdout.write(
	`HANDOFF launched=${launched ? 1 : 0} tmux_has=${filtered.HERDR_BIN_PATH === undefined ? 0 : 1} marker=${fs.existsSync(marker) ? 1 : 0} status=${child.status ?? -1} line=${line ?? ""}\n`,
);
if (child.status !== 0) {
	process.stderr.write(child.stderr ?? "");
	process.exit(1);
}

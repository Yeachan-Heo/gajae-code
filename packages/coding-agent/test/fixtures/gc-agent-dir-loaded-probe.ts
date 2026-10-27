/**
 * Child entry for the load-time agent-dir trust regression.
 *
 * The parent writes cwd/.env, then starts this process so Bun and the utils
 * snapshot see that declaration. This file then changes the declaration and
 * calls `runGjcGcCommand` with the already-loaded process environment.
 */
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@gajae-code/utils";
import { type GcStoreAdapter, runGjcGcCommand } from "../../src/gjc-runtime/gc-runtime";

const root = process.cwd();
const mode = process.argv[2];
const key = process.argv[3];
const loaded = key ? process.env[key] : undefined;

if (mode === "drop") {
	await Bun.write(path.join(root, ".env"), "UNRELATED=1\n");
} else if (mode === "rewrite") {
	const rewritten = process.argv[4];
	await Bun.write(path.join(root, ".env"), `${key}=${rewritten}\n`);
}

const duringCollect: GcStoreAdapter[] | undefined =
	mode === "during"
		? [
				{
					store: "file_locks",
					async collect() {
						await Bun.write(path.join(root, ".env"), `${key}=${process.argv[4]}\n`);
						return { records: [], errors: [] };
					},
					async prune() {
						return { removed: false };
					},
				},
			]
		: undefined;

const result = await runGjcGcCommand(["--disk", "--json"], root, process.env, duringCollect);
let sessions: string | undefined;
if (result.status !== 2) {
	const report = JSON.parse(result.stdout) as {
		disk?: { surfaces?: { sessions?: { root?: string } } };
	};
	sessions = report.disk?.surfaces?.sessions?.root;
}
process.stdout.write(
	`${JSON.stringify({
		status: result.status,
		stderr: result.stderr,
		loaded: loaded ?? null,
		sessions: sessions ?? null,
		fallback: getSessionsDir(getAgentDir()),
	})}\n`,
);

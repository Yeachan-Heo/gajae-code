// Prints coordinator workdir authorization after the project dotenv is loaded.
// Spawned with a controlled cwd so that directory's `.env` is what the
// managed-root reader sees. `@gajae-code/utils` performs the same env merge
// the coordinator serve command does.
import "@gajae-code/utils";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertCoordinatorSessionLocations, buildCoordinatorMcpConfig } from "../../src/coordinator-mcp/policy";
import { createCoordinatorSafetyPolicy } from "../../src/coordinator-mcp/safety";

const drop = process.env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_DROP;
if (drop === "unlink") fs.rmSync(".env", { force: true });
else if (drop === "chdir") process.chdir(os.tmpdir());

const subject = process.env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_SUBJECT;
const kept = process.env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_KEPT;
if (!subject || !kept) throw new Error("missing probe paths");

function rejected(error: unknown): { ok: false; error: string } {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const config = buildCoordinatorMcpConfig();
const safety = await createCoordinatorSafetyPolicy();

async function workdir(target: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
	try {
		return { ok: true, value: await safety.resolveWorkdir(target) };
	} catch (error) {
		return rejected(error);
	}
}

async function session(cwd: string): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await assertCoordinatorSessionLocations(config, cwd, path.join(cwd, ".gjc"));
		return { ok: true };
	} catch (error) {
		return rejected(error);
	}
}

console.log(
	JSON.stringify({
		envValue: process.env.GJC_WORKTREE_DIR ?? null,
		managed: config.managedWorktreeRoots,
		subjectWorkdir: await workdir(subject),
		keptWorkdir: await workdir(kept),
		subjectSession: await session(subject),
	}),
);

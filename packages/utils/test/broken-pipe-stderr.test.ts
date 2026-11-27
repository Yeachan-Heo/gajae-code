import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeRmSync } from "../../../scripts/safe-cleanup";
import { BROKEN_PIPE_EXIT_CODE } from "../src/broken-pipe";

const CHILD = path.join(import.meta.dir, "fixtures", "stderr-epipe-child.ts");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) safeRmSync(dir, { recursive: true, force: true });
});

/** Run the child with its stderr read end closed at once; returns the exit code and crash log path. */
async function runWithClosedStderr(mode: "stderr" | "ordinary"): Promise<{ code: number | null; crashLog: string }> {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-stderr-epipe-"));
	dirs.push(agentDir);
	const child = Bun.spawn([process.execPath, CHILD, mode], {
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	await child.stderr.cancel();
	const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { code, crashLog: stdout.trim() };
}

describe("direct stderr writes to a closed pipe (#7790)", () => {
	it("exit as a broken pipe without recording a crash", async () => {
		const { code, crashLog } = await runWithClosedStderr("stderr");
		expect(code).toBe(BROKEN_PIPE_EXIT_CODE);
		expect(crashLog).not.toBe("");
		expect(fs.existsSync(crashLog)).toBe(false);
	});

	it("still records an ordinary fatal as a crash", async () => {
		const { code, crashLog } = await runWithClosedStderr("ordinary");
		expect(code).toBe(1);
		expect(fs.readFileSync(crashLog, "utf8")).toContain("ordinary fatal");
	});
});

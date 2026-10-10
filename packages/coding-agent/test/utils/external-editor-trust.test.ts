import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The external editor command is executed on the user's draft. `$env` merges the
 * caller's `cwd/.env`, so without a trust boundary a repository could plant
 * `VISUAL`/`EDITOR` and run its own program the next time the user opens the editor.
 */

const PROBE = path.join(import.meta.dir, "..", "fixtures", "external-editor-env-probe.ts");
const EDITOR_KEYS = ["VISUAL", "EDITOR"] as const;

const tempDirs: string[] = [];

function tempDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-editor-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveEditorIn(cwd: string, overrides: Record<string, string> = {}): Promise<string | null> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of EDITOR_KEYS) delete env[key];
	// Keep user-owned env files (agent `.env`, `~/.env`, shell rc) out of the result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { editor: string | null }).editor;
}

describe("external editor trust boundary", () => {
	it("ignores VISUAL and EDITOR planted by the project .env", async () => {
		const cwd = tempDir("VISUAL=./pwn.sh\nEDITOR=./pwn.sh\n");
		expect(await resolveEditorIn(cwd)).toBeNull();
	});

	it("still honors VISUAL from the launching shell", async () => {
		expect(await resolveEditorIn(tempDir(), { VISUAL: "nvim" })).toBe("nvim");
	});

	it("falls back to EDITOR from the launching shell", async () => {
		expect(await resolveEditorIn(tempDir(), { EDITOR: "vim" })).toBe("vim");
	});

	it("does not let the project .env override an inherited editor", async () => {
		const cwd = tempDir("VISUAL=./pwn.sh\n");
		expect(await resolveEditorIn(cwd, { EDITOR: "vim" })).toBe("vim");
	});
});

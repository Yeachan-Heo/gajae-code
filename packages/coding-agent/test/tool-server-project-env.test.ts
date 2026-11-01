import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * GJC starts tool servers on its own: stdio MCP servers when a session starts,
 * LSP servers and linter CLIs (Biome, SwiftLint) on file writes (diagnostics on
 * write is on by default), and DAP adapters for the debug tool. A repository
 * `.env` must not be able to make those servers run repository code. Each case
 * plants a `NODE_OPTIONS` preload in the project `.env`, starts the real client
 * with a `node` server from that project, and checks the preload marker.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "tool-server-project-env-probe.ts");
// MCP and DAP spread the process environment, so the project value reaches them
// even under `--no-env-file`, where `@gajae-code/utils/env` copies it in. LSP
// servers and linter CLIs inherited the OS environment, which Bun's autoload sets.
const OPS = [
	{ op: "mcp", modes: [false, true] },
	{ op: "lsp", modes: [false] },
	{ op: "biome", modes: [false] },
	{ op: "dap", modes: [false, true] },
] as const;

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tool-server-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Project {
	cwd: string;
	marker: string;
	preload: string;
}

function project(): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "preload-ran");
	const preload = path.join(cwd, "preload.cjs");
	fs.writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
	return { cwd, marker, preload };
}

async function runProbe(
	target: Project,
	op: string,
	noEnvFile: boolean,
	extraEnv: Record<string, string> = {},
): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
	}
	const home = tempDir();
	Object.assign(env, { HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent") }, extraEnv);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE, op] : ["bun", PROBE, op];
	const proc = Bun.spawn(argv, { cwd: target.cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(target.marker);
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))("tool servers ignore project .env hooks", () => {
	for (const { op, modes } of OPS) {
		for (const noEnvFile of modes) {
			it(`does not let a project NODE_OPTIONS preload run in the ${op} server (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				const target = project();
				fs.writeFileSync(path.join(target.cwd, ".env"), `NODE_OPTIONS=--require ${target.preload}\n`);
				expect(await runProbe(target, op, noEnvFile)).toBe(false);
			}, 30_000);
		}

		it(`still passes an operator-exported NODE_OPTIONS to the ${op} server`, async () => {
			const target = project();
			expect(await runProbe(target, op, false, { NODE_OPTIONS: `--require ${target.preload}` })).toBe(true);
		}, 30_000);
	}
});

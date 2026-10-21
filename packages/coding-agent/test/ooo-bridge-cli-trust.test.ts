import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveOuroborosCommand` is spawned as the `ooo` executable. Bun loads
 * `cwd/.env` into `process.env` before the module runs, so the refusal is only
 * visible from a process whose cwd declares `OUROBOROS_CLI`.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "ouroboros-cli-trust-probe.ts");
const CLEARED = [
	"OUROBOROS_CLI",
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"GJC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
] as const;

interface ProbeResult {
	result: { handled?: boolean; text?: string };
	parent: string | null;
	notes: string[];
	mcpCli: string | null;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(file: string, marker: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`#!/bin/sh\nprintf 'marker=%s\\nchild-env=%s\\nargs=%s\\n' ${JSON.stringify(marker)} "\${OUROBOROS_CLI-__UNSET__}" "$*"\n`,
		{ mode: 0o755 },
	);
}

function project(): { dir: string; home: string; bin: string; planted: string; allowed: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ooo-cli-trust-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ooo-cli-home-"));
	tempDirs.push(dir, home);
	const bin = path.join(dir, "bin");
	const planted = path.join(dir, "planted-ooo");
	const allowed = path.join(dir, "allowed-ooo");
	writeExecutable(path.join(bin, "ouroboros"), "DEFAULT");
	writeExecutable(planted, "ATTACK");
	writeExecutable(allowed, "ALLOWED");
	return { dir, home, bin, planted, allowed };
}

async function runProbe(
	dir: string,
	bin: string,
	home: string,
	dotenv?: string,
	overrides: Record<string, string> = {},
): Promise<ProbeResult> {
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of CLEARED) delete env[key];
	env.HOME = home;
	env.USERPROFILE = home;
	env.PATH = `${bin}${path.delimiter}${env.PATH ?? "/usr/bin:/bin"}`;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as ProbeResult;
}

function marker(resolved: ProbeResult): string {
	const text = resolved.result.text ?? "";
	const found = /^marker=(\S+)/m.exec(text);
	return found?.[1] ?? text;
}

describe.skipIf(process.platform === "win32")("ooo bridge OUROBOROS_CLI trust (POSIX spawn recorder)", () => {
	it("ignores an executable path planted by the project .env and hides it from the child", async () => {
		const { dir, home, bin, planted } = project();
		const resolved = await runProbe(dir, bin, home, `OUROBOROS_CLI=${planted}\n`);
		expect(marker(resolved)).toBe("DEFAULT");
		expect(resolved.result.text).toContain("child-env=__UNSET__");
		expect(resolved.result.text).toContain("args=dispatch --runtime gjc ooo status");
		expect(resolved.parent).toBeNull();
		expect(resolved.mcpCli).toBeNull();
	});

	it("ignores a quoted project value and a dynamic project declaration", async () => {
		const quoted = project();
		const quotedResult = await runProbe(
			quoted.dir,
			quoted.bin,
			quoted.home,
			`OUROBOROS_CLI="${quoted.planted}" # note\n`,
		);
		expect(marker(quotedResult)).toBe("DEFAULT");
		expect(quotedResult.result.text).toContain("child-env=__UNSET__");

		const dynamic = project();
		const dynamicResult = await runProbe(dynamic.dir, dynamic.bin, dynamic.home, "OUROBOROS_CLI=$PLANTED_OOO\n", {
			PLANTED_OOO: dynamic.planted,
		});
		expect(marker(dynamicResult)).toBe("DEFAULT");
		expect(dynamicResult.result.text).toContain("child-env=__UNSET__");
		expect(dynamicResult.parent).toBeNull();
		expect(dynamicResult.mcpCli).toBeNull();
	});

	it("ignores an operator value repeated verbatim by the project .env", async () => {
		const { dir, home, bin, allowed } = project();
		const resolved = await runProbe(dir, bin, home, `OUROBOROS_CLI=${allowed}\n`, { OUROBOROS_CLI: allowed });
		expect(marker(resolved)).toBe("DEFAULT");
		expect(resolved.result.text).toContain("child-env=__UNSET__");
		expect(resolved.parent).toBeNull();
		expect(resolved.mcpCli).toBeNull();
	});

	it("keeps the default command when OUROBOROS_CLI is unset", async () => {
		const { dir, home, bin } = project();
		const resolved = await runProbe(dir, bin, home);
		expect(marker(resolved)).toBe("DEFAULT");
		expect(resolved.result.text).toContain("args=dispatch --runtime gjc ooo status");
		expect(resolved.parent).toBeNull();
	});

	it("keeps the default command when the project value is empty", async () => {
		const { dir, home, bin } = project();
		const resolved = await runProbe(dir, bin, home, "OUROBOROS_CLI=\n");
		expect(marker(resolved)).toBe("DEFAULT");
		expect(resolved.result.text).toContain("args=dispatch --runtime gjc ooo status");
	});

	it("still allows an operator OUROBOROS_CLI the project does not declare", async () => {
		const { dir, home, bin, allowed } = project();
		const resolved = await runProbe(dir, bin, home, undefined, { OUROBOROS_CLI: allowed });
		expect(marker(resolved)).toBe("ALLOWED");
		expect(resolved.result.text).toContain(`child-env=${allowed}`);
		expect(resolved.result.text).toContain("args=dispatch --runtime gjc ooo status");
		expect(resolved.parent).toBe(allowed);
		expect(resolved.mcpCli).toBe(allowed);
	});

	it("ignores a different operator value when the project declaration is dynamic", async () => {
		const { dir, home, bin, planted, allowed } = project();
		const resolved = await runProbe(dir, bin, home, "OUROBOROS_CLI=$PLANTED_OOO\n", {
			OUROBOROS_CLI: allowed,
			PLANTED_OOO: planted,
		});
		expect(marker(resolved)).toBe("DEFAULT");
		expect(resolved.result.text).toContain("child-env=__UNSET__");
		expect(resolved.parent).toBeNull();
		expect(resolved.mcpCli).toBeNull();
	});

	it("still allows an inherited command when the project .env names another executable", async () => {
		const { dir, home, bin, planted, allowed } = project();
		const resolved = await runProbe(dir, bin, home, `OUROBOROS_CLI=${planted}\n`, { OUROBOROS_CLI: allowed });
		expect(marker(resolved)).toBe("ALLOWED");
		expect(resolved.result.text).toContain(`child-env=${allowed}`);
		expect(resolved.parent).toBe(allowed);
		expect(resolved.mcpCli).toBe(allowed);
	});
});

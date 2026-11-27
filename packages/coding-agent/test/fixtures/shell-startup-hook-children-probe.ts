import * as fs from "node:fs";
import { getShellConfig } from "@gajae-code/utils/shell-config";
import fc from "fast-check";
import { defaultFinalizeChecks } from "../../src/harness-control-plane/finalize";
import { runStatusLineCommand } from "../../src/modes/components/status-line/command";

const outDir = process.env.PROBE_OUT;
if (!outDir) throw new Error("PROBE_OUT is required");
const cwd = process.cwd();

function q(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function dumpCmd(file: string): string {
	return `printf '%s\\n' "\${BASH_ENV-}" "\${ZDOTDIR-}" "\${ENV-}" "\${UNRELATED_OK-}" "\${Bash_Env-}" > ${q(file)}`;
}

function readDump(file: string) {
	if (!fs.existsSync(file)) return null;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const [bash = "", zdot = "", env = "", unrelated = "", caseName = ""] = lines;
	return { bash, zdot, env, unrelated, caseName };
}

async function run(shell: string, env: Record<string, string>, file: string) {
	const result = await runStatusLineCommand(dumpCmd(file), {
		cwd,
		shell,
		shellArgs: ["-l", "-c"],
		env,
		timeoutMs: 15_000,
	});
	return { exitCode: result.exitCode, stderr: result.stderr, dump: readDump(file) };
}

const cfg = getShellConfig("/bin/bash");
const bashStatus = await run("/bin/bash", cfg.env, `${outDir}/bash.env`);
const zsh = fs.existsSync("/bin/zsh") ? await run("/bin/zsh", cfg.env, `${outDir}/zsh.env`) : null;

let fin: { exitStatus: number; pass: boolean; dump: ReturnType<typeof readDump> } | { error: string };
try {
	const checks = defaultFinalizeChecks(cwd);
	const validation = await checks.runValidation({ name: "hooks", command: dumpCmd(`${outDir}/fin.env`) });
	fin = { exitStatus: validation.exitStatus, pass: validation.pass, dump: readDump(`${outDir}/fin.env`) };
} catch (error) {
	fin = { error: error instanceof Error ? error.message : String(error) };
}

let cachedDelete = null;
let cachedReplace = null;
if (process.env.PROBE_CACHE === "1") {
	delete process.env.BASH_ENV;
	delete process.env.ENV;
	delete process.env.ZDOTDIR;
	cachedDelete = await run("/bin/bash", cfg.env, `${outDir}/del.env`);
	process.env.BASH_ENV = "replaced-bash-value";
	process.env.ENV = "replaced-env-value";
	process.env.ZDOTDIR = "replaced-zdot-value";
	cachedReplace = await run("/bin/bash", cfg.env, `${outDir}/rep.env`);
}

let concurrent = null;
if (process.env.PROBE_CONCURRENT === "1") {
	const pair = await Promise.all([
		run("/bin/bash", cfg.env, `${outDir}/c1.env`),
		run("/bin/bash", cfg.env, `${outDir}/c2.env`),
	]);
	concurrent = pair;
}

let caseNeighbor = null;
let spaced = null;
let trimmed = null;
if (process.env.PROBE_NEIGHBOR === "1") {
	caseNeighbor = await run("/bin/bash", { ...cfg.env, Bash_Env: "kept-case" }, `${outDir}/case.env`);
	spaced = await run("/bin/bash", { ...cfg.env, ENV: "  kept spaced  " }, `${outDir}/space.env`);
	trimmed = await run("/bin/bash", { ...cfg.env, BASH_ENV: `${cfg.env.BASH_ENV ?? ""} ` }, `${outDir}/trim.env`);
}

let explicit = null;
const explicitBash = process.env.PROBE_EXPLICIT_BASH;
const explicitEnv = process.env.PROBE_EXPLICIT_ENV;
const explicitZdot = process.env.PROBE_EXPLICIT_ZDOT;
if (explicitBash && explicitEnv && explicitZdot) {
	explicit = await run(
		"/bin/bash",
		{ ...cfg.env, BASH_ENV: explicitBash, ENV: explicitEnv, ZDOTDIR: explicitZdot },
		`${outDir}/explicit.env`,
	);
}

let propertyRan = false;
if (process.env.PROBE_PROPERTY === "1") {
	const commandMod = await import("../../src/modes/components/status-line/command");
	const omit = commandMod.omitProjectShellStartupEnv;
	if (typeof omit === "function") {
		const projectBash = cfg.env.BASH_ENV ?? "";
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.string({ minLength: 1, maxLength: 40 }).filter(value => {
					return !value.includes("\0") && value !== projectBash && value.trim() !== projectBash;
				}),
				(dropLive, replaceLive, override) => {
					const saved = process.env.BASH_ENV;
					try {
						if (dropLive) delete process.env.BASH_ENV;
						else if (replaceLive) process.env.BASH_ENV = `other-${override}`;
						const cached = omit(cfg.env);
						const caller = omit({ ...cfg.env, BASH_ENV: override, UNRELATED_OK: "kept-token" });
						return (
							cached.BASH_ENV === undefined &&
							cfg.env.BASH_ENV === projectBash &&
							caller.BASH_ENV === override &&
							caller.UNRELATED_OK === "kept-token"
						);
					} finally {
						if (saved === undefined) delete process.env.BASH_ENV;
						else process.env.BASH_ENV = saved;
					}
				},
			),
			{ seed: 593, numRuns: 64 },
		);
		propertyRan = true;
	}
}

const report = {
	before: { bash: cfg.env.BASH_ENV ?? "", zdot: cfg.env.ZDOTDIR ?? "", env: cfg.env.ENV ?? "" },
	after: { bash: cfg.env.BASH_ENV ?? "", zdot: cfg.env.ZDOTDIR ?? "", env: cfg.env.ENV ?? "" },
	bashStatus,
	zsh,
	fin,
	cachedDelete,
	cachedReplace,
	concurrent,
	caseNeighbor,
	spaced,
	trimmed,
	explicit,
	propertyRan,
};
fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report));

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { filterEnv } from "@gajae-code/coding-agent/eval/py/runtime";
import fc from "fast-check";

const SHELL_URL = "http://127.0.0.1:9/shell";
const PROJECT_URL = "http://127.0.0.1:9/project";
const HAS_PYTHON = Bun.which("python3") !== null || Bun.which("python") !== null;
const runtimeSource = path.resolve(import.meta.dir, "../../src/eval/py/runtime.ts");
const executorSource = path.resolve(import.meta.dir, "../../src/eval/py/executor.ts");

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProject(dir: string, files: Record<string, string | Buffer>): void {
	for (const [name, content] of Object.entries(files)) {
		const dest = path.join(dir, name);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, content);
	}
}

function withProject(files: Record<string, string | Buffer>, nodeEnv: string | undefined, run: () => void): void {
	const cwd = tempDir("gjc-bridge-proj-");
	writeProject(cwd, files);
	const previousCwd = process.cwd();
	const previousNode = process.env.NODE_ENV;
	process.chdir(cwd);
	if (nodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = nodeEnv;
	try {
		run();
	} finally {
		process.chdir(previousCwd);
		if (previousNode === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNode;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function bridgeEnv(url: string): Record<string, string | undefined> {
	return {
		PATH: "/usr/bin:/bin",
		PI_TOOL_BRIDGE_URL: url,
		PI_TOOL_BRIDGE_CAPABILITY: "operator-cap",
		PI_TOOL_BRIDGE_SESSION: "operator-session",
		PI_CUSTOM: "kept",
	};
}

const QUOTED_NEWLINE = 'PI_TOOL_BRIDGE_URL="http://127.0.0.1:9/attack\\n"\n';
const REAL_MULTILINE = 'PI_TOOL_BRIDGE_URL="http://127.0.0.1:9/attack\nmore"\n';

describe("python tool-bridge dotenv provenance", () => {
	it("drops a quoted development-layer URL when .env assigns the live NODE_ENV", () => {
		withProject(
			{
				".env": "NODE_ENV=production\n",
				".env.development": QUOTED_NEWLINE,
				".env.production": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/decoy\n",
			},
			"production",
			() => {
				const filtered = filterEnv(bridgeEnv("http://127.0.0.1:9/attack\n"));
				expect(filtered.PI_TOOL_BRIDGE_URL).toBeUndefined();
				expect(filtered.PI_TOOL_BRIDGE_CAPABILITY).toBe("operator-cap");
				expect(filtered.PI_TOOL_BRIDGE_SESSION).toBe("operator-session");
				expect(filtered.PI_CUSTOM).toBe("kept");
			},
		);
	});

	it("drops a development URL when .env.local assigns the live NODE_ENV", () => {
		withProject(
			{
				".env.local": "NODE_ENV=production\n",
				".env.development": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/attack\n",
			},
			"production",
			() => {
				const filtered = filterEnv(bridgeEnv("http://127.0.0.1:9/attack"));
				expect(filtered.PI_TOOL_BRIDGE_URL).toBeUndefined();
				expect(filtered.PI_TOOL_BRIDGE_CAPABILITY).toBe("operator-cap");
			},
		);
	});

	it("drops a multiline quoted URL that hides a later declaration", () => {
		withProject(
			{
				".env": 'PI_TOOL_BRIDGE_URL="http://127.0.0.1:9/attack\nPI_TOOL_BRIDGE_URL=decoy\n"\n',
			},
			"production",
			() => {
				expect(
					filterEnv(bridgeEnv("http://127.0.0.1:9/attack\nPI_TOOL_BRIDGE_URL=decoy\n")).PI_TOOL_BRIDGE_URL,
				).toBeUndefined();
			},
		);
	});

	it("keeps a different shell URL when the project quotes are a single plain pair", () => {
		withProject({ ".env": `PI_TOOL_BRIDGE_URL="${PROJECT_URL}"\n` }, "production", () => {
			expect(filterEnv(bridgeEnv(SHELL_URL)).PI_TOOL_BRIDGE_URL).toBe(SHELL_URL);
		});
	});

	it("drops a real multiline quoted URL from the development layer", () => {
		withProject(
			{
				".env": "NODE_ENV=production\n",
				".env.development": REAL_MULTILINE,
				".env.production": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/decoy\n",
			},
			"production",
			() => {
				expect(filterEnv(bridgeEnv("http://127.0.0.1:9/attack\nmore")).PI_TOOL_BRIDGE_URL).toBeUndefined();
			},
		);
	});

	it("keeps a different shell URL when NODE_ENV is only in the shell", () => {
		withProject(
			{
				".env": "UNRELATED=1\n",
				".env.development": QUOTED_NEWLINE,
				".env.production": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/decoy\n",
			},
			"production",
			() => {
				const filtered = filterEnv(bridgeEnv(SHELL_URL));
				expect(filtered.PI_TOOL_BRIDGE_URL).toBe(SHELL_URL);
				expect(filtered.PI_CUSTOM).toBe("kept");
			},
		);
	});

	it("keeps a shell URL that differs by more than surrounding whitespace", () => {
		withProject({ ".env": `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n` }, "production", () => {
			expect(filterEnv(bridgeEnv(` ${SHELL_URL} `)).PI_TOOL_BRIDGE_URL).toBe(` ${SHELL_URL} `);
		});
	});

	it("drops a project URL that matches after trim", () => {
		withProject({ ".env": `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n` }, "production", () => {
			expect(filterEnv(bridgeEnv(`${PROJECT_URL} `)).PI_TOOL_BRIDGE_URL).toBeUndefined();
		});
	});

	it("keeps a shell URL that is not the decoded escaped-dollar literal", () => {
		withProject({ ".env": "PI_TOOL_BRIDGE_URL=\\$literal\n" }, "production", () => {
			expect(filterEnv(bridgeEnv(SHELL_URL)).PI_TOOL_BRIDGE_URL).toBe(SHELL_URL);
		});
	});

	it("drops a shell value equal to an escaped-dollar project literal", () => {
		withProject({ ".env": "PI_TOOL_BRIDGE_URL=\\$literal\n" }, "production", () => {
			expect(filterEnv(bridgeEnv("$literal")).PI_TOOL_BRIDGE_URL).toBeUndefined();
		});
	});

	it("drops every live value when the project declaration is dynamic", () => {
		withProject({ ".env": "PI_TOOL_BRIDGE_URL=$HOME/bridge\n" }, "production", () => {
			expect(filterEnv(bridgeEnv(SHELL_URL)).PI_TOOL_BRIDGE_URL).toBeUndefined();
		});
	});

	it("ignores a lookalike dotfile and a lowercase name on a case-sensitive platform", () => {
		withProject({ "..env": `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n` }, "production", () => {
			expect(filterEnv(bridgeEnv(SHELL_URL)).PI_TOOL_BRIDGE_URL).toBe(SHELL_URL);
			if (process.platform !== "win32") {
				const lower = filterEnv({ PATH: "/usr/bin:/bin", pi_tool_bridge_url: SHELL_URL, PI_CUSTOM: "kept" });
				expect(lower.pi_tool_bridge_url).toBeUndefined();
				expect(lower.PI_CUSTOM).toBe("kept");
			}
		});
	});

	function withSymlinkedEnv(run: () => void): void {
		const cwd = tempDir("gjc-bridge-link-");
		const real = tempDir("gjc-bridge-real-");
		fs.writeFileSync(path.join(real, "declared.env"), `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n`);
		fs.symlinkSync(path.join(real, "declared.env"), path.join(cwd, ".env"));
		const previous = process.cwd();
		process.chdir(cwd);
		try {
			run();
		} finally {
			process.chdir(previous);
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(real, { recursive: true, force: true });
		}
	}

	it.skipIf(process.platform === "win32")("keeps a different shell URL when the declaration file is a symlink", () => {
		withSymlinkedEnv(() => {
			expect(filterEnv(bridgeEnv(SHELL_URL)).PI_TOOL_BRIDGE_URL).toBe(SHELL_URL);
		});
	});

	it.skipIf(process.platform === "win32")("drops a project URL declared through a symlinked dotenv file", () => {
		withSymlinkedEnv(() => {
			expect(filterEnv(bridgeEnv(PROJECT_URL)).PI_TOOL_BRIDGE_URL).toBeUndefined();
		});
	});
});

function childEnv(extra: Record<string, string | undefined>): Record<string, string> {
	const home = tempDir("gjc-bridge-home-");
	const env: Record<string, string> = {
		PATH: process.env.PATH && process.env.PATH.length > 0 ? process.env.PATH : "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		TERM: "dumb",
		TMPDIR: os.tmpdir(),
	};
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function runProbe(
	script: string,
	cwd: string,
	env: Record<string, string>,
	timeoutMs: number,
	args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const dir = tempDir("gjc-bridge-script-");
	const file = path.join(dir, "probe.ts");
	fs.writeFileSync(file, script);
	const proc = Bun.spawn([process.execPath, file, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	fs.rmSync(dir, { recursive: true, force: true });
	return { code, stdout, stderr };
}

const FILTER_PROBE = `
import { filterEnv } from ${JSON.stringify(runtimeSource)};
import * as path from "node:path";
const root = process.argv[2];
const names = ["fifo", "big", "dir", "swap", "link", "small"];
const out = {};
for (const name of names) {
  process.chdir(path.join(root, name));
  const filtered = filterEnv({
    PATH: process.env.PATH,
    PI_TOOL_BRIDGE_URL: ${JSON.stringify(SHELL_URL)},
    PI_CUSTOM: "kept",
  });
  out[name] = { url: filtered.PI_TOOL_BRIDGE_URL ?? null, custom: filtered.PI_CUSTOM ?? null };
}
console.log(JSON.stringify(out));
`;

describe("bounded tool-bridge reads", () => {
	it.skipIf(process.platform === "win32")(
		"finishes when a layer is a FIFO, oversized, unreadable, or replaced",
		async () => {
			const root = tempDir("gjc-bridge-bound-");
			const make = (name: string) => {
				const dir = path.join(root, name);
				fs.mkdirSync(dir);
				return dir;
			};
			Bun.spawnSync(["mkfifo", path.join(make("fifo"), ".env")]);
			const envFile = await import("@gajae-code/utils/env-file");
			const layerMax =
				typeof envFile.PROJECT_TOOL_BRIDGE_LAYER_MAX_BYTES === "number"
					? envFile.PROJECT_TOOL_BRIDGE_LAYER_MAX_BYTES
					: 1024 * 1024;
			const big = Buffer.alloc(layerMax * 2, 0x61);
			Buffer.from(`PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n`).copy(big);
			fs.writeFileSync(path.join(make("big"), ".env"), big);
			fs.mkdirSync(path.join(make("dir"), ".env"));
			const swap = make("swap");
			const replaced = path.join(swap, ".env");
			fs.writeFileSync(replaced, `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n`);
			fs.renameSync(replaced, path.join(swap, "env.prev"));
			Bun.spawnSync(["mkfifo", replaced]);
			const linkDir = make("link");
			const fifo = path.join(linkDir, "pipe");
			Bun.spawnSync(["mkfifo", fifo]);
			fs.symlinkSync(fifo, path.join(linkDir, ".env"));
			fs.writeFileSync(path.join(make("small"), ".env"), `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n`);
			const runner = tempDir("gjc-bridge-runner-");
			const result = await runProbe(FILTER_PROBE, runner, childEnv({}), 5_000, [root]);
			expect(result.code, result.stderr).toBe(0);
			const parsed = JSON.parse(result.stdout.trim()) as Record<
				string,
				{ url: string | null; custom: string | null }
			>;
			for (const name of ["fifo", "big", "dir", "swap", "link"]) {
				expect(parsed[name]?.url, name).toBeNull();
				expect(parsed[name]?.custom, name).toBe("kept");
			}
			expect(parsed.small?.url).toBe(SHELL_URL);
			expect(parsed.small?.custom).toBe("kept");
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(runner, { recursive: true, force: true });
		},
		15_000,
	);
});

const PYTHON_PROBE = `
import { executePython } from ${JSON.stringify(executorSource)};
const registered = process.argv[2] === "registered";
const result = await executePython(
  'import json,os; print("BRIDGE_ENV " + json.dumps({"url":os.environ.get("PI_TOOL_BRIDGE_URL"),"capability":os.environ.get("PI_TOOL_BRIDGE_CAPABILITY"),"session":os.environ.get("PI_TOOL_BRIDGE_SESSION")}))',
  {
    cwd: process.cwd(),
    kernelMode: "per-call",
    timeoutMs: 20000,
    bridge: registered ? { url: "http://127.0.0.1:9/registered", capability: "reg-cap" } : undefined,
    bridgeSessionId: registered ? "reg-session" : undefined,
  },
);
const line = result.output.split(/\\r?\\n/).find(item => item.startsWith("BRIDGE_ENV "));
console.log(line ?? result.output);
process.exit(result.exitCode === 0 && line ? 0 : 1);
`;

async function pythonBridge(
	files: Record<string, string>,
	env: Record<string, string>,
	mode = "plain",
): Promise<{ url: string | null; capability: string | null; session: string | null }> {
	const cwd = tempDir("gjc-bridge-py-");
	writeProject(cwd, files);
	const result = await runProbe(PYTHON_PROBE, cwd, env, 25_000, [mode]);
	fs.rmSync(cwd, { recursive: true, force: true });
	expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
	const line = result.stdout.split(/\r?\n/).find(item => item.startsWith("BRIDGE_ENV "));
	if (!line) throw new Error(`missing bridge line\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(line.slice("BRIDGE_ENV ".length)) as {
		url: string | null;
		capability: string | null;
		session: string | null;
	};
}

const CHDIR_PROBE = `
import { filterEnv } from ${JSON.stringify(runtimeSource)};
import { executePython } from ${JSON.stringify(executorSource)};
const url = process.env.PI_TOOL_BRIDGE_URL;
const sample = { PATH: process.env.PATH, PI_TOOL_BRIDGE_URL: url, PI_CUSTOM: "kept" };
const before = filterEnv(sample).PI_TOOL_BRIDGE_URL ?? null;
process.chdir(process.argv[2]);
const after = filterEnv(sample).PI_TOOL_BRIDGE_URL ?? null;
const result = await executePython('import os; print(os.environ.get("PI_TOOL_BRIDGE_URL"))', {
  cwd: process.cwd(),
  kernelMode: "per-call",
  timeoutMs: 20000,
});
console.log(JSON.stringify({ before, after, exitCode: result.exitCode, output: result.output }));
process.exit(result.exitCode === 0 ? 0 : 1);
`;

describe.skipIf(!HAS_PYTHON)("python kernel child env", () => {
	const attack = {
		".env": "NODE_ENV=production\n",
		".env.development": QUOTED_NEWLINE,
		".env.production": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/decoy\n",
	};

	it("omits a project URL from the child when capability and session come from the shell", async () => {
		const seen = await pythonBridge(
			attack,
			childEnv({
				PI_TOOL_BRIDGE_CAPABILITY: "operator-cap",
				PI_TOOL_BRIDGE_SESSION: "operator-session",
			}),
		);
		expect(seen.url).toBeNull();
		expect(seen.capability).toBe("operator-cap");
		expect(seen.session).toBe("operator-session");
	}, 40_000);

	it("omits a project URL loaded at startup after the process moves", async () => {
		const origin = tempDir("gjc-bridge-origin-");
		const moved = tempDir("gjc-bridge-moved-");
		writeProject(origin, { ".env": `PI_TOOL_BRIDGE_URL=${PROJECT_URL}\n` });
		const result = await runProbe(CHDIR_PROBE, origin, childEnv({}), 25_000, [moved]);
		fs.rmSync(origin, { recursive: true, force: true });
		fs.rmSync(moved, { recursive: true, force: true });
		expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
		const parsed = JSON.parse(result.stdout.trim()) as {
			before: string | null;
			after: string | null;
			output: string;
		};
		expect(parsed.before).toBeNull();
		expect(parsed.after).toBeNull();
		expect(parsed.output).not.toContain(PROJECT_URL);
	}, 40_000);

	it("omits a real multiline project URL from the child", async () => {
		const seen = await pythonBridge(
			{ ...attack, ".env.development": REAL_MULTILINE },
			childEnv({
				PI_TOOL_BRIDGE_CAPABILITY: "operator-cap",
				PI_TOOL_BRIDGE_SESSION: "operator-session",
			}),
		);
		expect(seen.url).toBeNull();
		expect(seen.capability).toBe("operator-cap");
	}, 40_000);

	it("keeps a different shell URL and a registered bridge", async () => {
		const shell = await pythonBridge(
			{
				".env": "UNRELATED=1\n",
				".env.development": QUOTED_NEWLINE,
				".env.production": "PI_TOOL_BRIDGE_URL=http://127.0.0.1:9/decoy\n",
			},
			childEnv({
				NODE_ENV: "production",
				PI_TOOL_BRIDGE_URL: SHELL_URL,
				PI_TOOL_BRIDGE_CAPABILITY: "operator-cap",
				PI_TOOL_BRIDGE_SESSION: "operator-session",
			}),
		);
		expect(shell.url).toBe(SHELL_URL);
		expect(shell.capability).toBe("operator-cap");
		const registered = await pythonBridge(
			attack,
			childEnv({
				PI_TOOL_BRIDGE_CAPABILITY: "operator-cap",
				PI_TOOL_BRIDGE_SESSION: "operator-session",
			}),
			"registered",
		);
		expect(registered.url).toBe("http://127.0.0.1:9/registered");
		expect(registered.capability).toBe("reg-cap");
		expect(registered.session).toBe("reg-session");
	}, 40_000);
});

describe("python tool-bridge literal property", () => {
	it("rejects a plain project literal and accepts a different suffix", () => {
		fc.assert(
			fc.property(
				fc
					.array(fc.constantFrom(..."abc123".split("")), { minLength: 1, maxLength: 12 })
					.map(chars => chars.join("")),
				literal => {
					withProject({ ".env": `PI_TOOL_BRIDGE_URL=${literal}\n` }, "production", () => {
						expect(filterEnv(bridgeEnv(literal)).PI_TOOL_BRIDGE_URL).toBeUndefined();
						expect(filterEnv(bridgeEnv(`${literal}x`)).PI_TOOL_BRIDGE_URL).toBe(`${literal}x`);
					});
				},
			),
			{ seed: 70118, numRuns: 64 },
		);
	});
});

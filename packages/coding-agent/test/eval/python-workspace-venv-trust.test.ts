import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { pythonBackend } from "@gajae-code/coding-agent/eval";
import { checkPythonKernelAvailability } from "@gajae-code/coding-agent/eval/py/kernel";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { relativePathEscapesRoot, TempDir } from "@gajae-code/utils";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";
import fc from "fast-check";

const HOST_PYTHON = Bun.which("python3") ?? Bun.which("python");
const ENV_KEYS = [
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"NODE_ENV",
	"BUN_ENV",
	"GJC_PYTHON_SKIP_CHECK",
	"PI_PYTHON_SKIP_CHECK",
] as const;

function symlinkOk(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-py-link-"));
	try {
		fs.symlinkSync("target", path.join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const SYMLINK_OK = symlinkOk();

function venvPythonResolvesOutside(): boolean {
	if (!HOST_PYTHON) return false;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-py-venv-probe-"));
	const venv = path.join(dir, "v");
	try {
		const created = Bun.spawnSync([HOST_PYTHON, "-m", "venv", venv], { stdout: "ignore", stderr: "pipe" });
		if (created.exitCode !== 0) return false;
		const canonical = fs.realpathSync(interpreterFile(venv));
		return !under(venv, canonical);
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// In-tree copies (typical Windows venv launchers) are the rejected shape.
const OUTSIDE_VENV = venvPythonResolvesOutside();

async function createVenv(target: string): Promise<void> {
	const proc = Bun.spawn([HOST_PYTHON as string, "-m", "venv", target], { stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`venv create failed (${code}): ${await new Response(proc.stderr).text()}`);
	}
}

function sessionFor(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
	} as ToolSession;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeScript(file: string, marker: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `#!/bin/sh\nprintf 'ran\\n' >> ${shellQuote(marker)}\nexit 0\n`);
	await fs.promises.chmod(file, 0o755);
}

async function writeCfg(venvDir: string, home: string): Promise<void> {
	await Bun.write(
		path.join(venvDir, "pyvenv.cfg"),
		`home = ${home}\ninclude-system-site-packages = false\nversion = 3.12.0\n`,
	);
}

function interpreterFile(venvDir: string): string {
	return process.platform === "win32"
		? path.join(venvDir, "Scripts", "python.exe")
		: path.join(venvDir, "bin", "python");
}

async function withProbeEnv<T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));
	for (const key of ENV_KEYS) delete Bun.env[key];
	for (const [key, value] of Object.entries(extra)) Bun.env[key] = value;
	resetShellConfigCache();
	try {
		return await fn();
	} finally {
		for (const key of ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		resetShellConfigCache();
	}
}

function under(root: string, candidate: string | undefined): boolean {
	if (!candidate) return false;
	const normalize = (value: string): string => {
		const resolved = path.resolve(value);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return !relativePathEscapesRoot(path.relative(normalize(root), normalize(candidate)));
}

function referenceContained(root: string, candidate: string): boolean {
	const normalize = (value: string): string => {
		const resolved = path.resolve(value);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const normalizedRoot = normalize(root);
	const normalizedCandidate = normalize(candidate);
	if (normalizedCandidate === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
	return normalizedCandidate.startsWith(prefix);
}

describe("workspace venv interpreter trust", () => {
	it("does not execute a repository .venv or venv python from the python eval backend", async () => {
		using tempDir = TempDir.createSync("@gjc-py-venv-attack-");
		const marker = tempDir.join("planted-python-ran");
		const repo = tempDir.join("repo");
		await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
		const payload = path.join(repo, "payload", "python");
		await writeScript(payload, marker);
		await writeCfg(path.join(repo, ".venv"), path.dirname(HOST_PYTHON ?? "."));
		await writeCfg(path.join(repo, "venv"), path.dirname(HOST_PYTHON ?? "."));
		const dotPython = interpreterFile(path.join(repo, ".venv"));
		const plainPython = interpreterFile(path.join(repo, "venv"));
		if (process.platform !== "win32" && SYMLINK_OK) {
			await fs.promises.mkdir(path.dirname(dotPython), { recursive: true });
			await fs.promises.symlink(payload, dotPython);
			await writeScript(plainPython, marker);
		} else {
			await writeScript(dotPython, marker);
			await writeScript(plainPython, marker);
		}

		await withProbeEnv({}, async () => {
			const session = sessionFor(repo);
			await pythonBackend.isAvailable(session);
			const availability = await checkPythonKernelAvailability(repo, undefined, undefined, session.settings);
			expect(fs.existsSync(marker)).toBe(false);
			expect(under(path.join(repo, ".venv"), availability.pythonPath)).toBe(false);
			expect(under(path.join(repo, "venv"), availability.pythonPath)).toBe(false);
		});
	}, 20_000);

	it.skipIf(!OUTSIDE_VENV)(
		"still uses a workspace .venv whose interpreter resolves outside the project (skipped when python -m venv keeps the interpreter inside the tree)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-py-venv-allow-");
			const repo = tempDir.join("repo");
			await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
			const venv = path.join(repo, ".venv");
			await createVenv(venv);

			await withProbeEnv({}, async () => {
				const session = sessionFor(repo);
				expect(await pythonBackend.isAvailable(session)).toBe(true);
				const availability = await checkPythonKernelAvailability(repo, undefined, undefined, session.settings);
				expect(availability.ok).toBe(true);
				expect(under(venv, availability.pythonPath)).toBe(true);
				expect(under(repo, fs.realpathSync(availability.pythonPath as string))).toBe(false);
			});
		},
		60_000,
	);

	it("does not execute a repository interpreter when the workspace is HOME", async () => {
		using tempDir = TempDir.createSync("@gjc-py-venv-home-");
		const repo = tempDir.join("home");
		const marker = tempDir.join("planted-python-ran");
		await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
		await writeScript(interpreterFile(path.join(repo, ".venv")), marker);
		await writeScript(interpreterFile(path.join(repo, "venv")), marker);
		await writeCfg(path.join(repo, ".venv"), path.dirname(HOST_PYTHON ?? "."));
		await writeCfg(path.join(repo, "venv"), path.dirname(HOST_PYTHON ?? "."));
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const probe = path.resolve(import.meta.dir, "../fixtures/python-workspace-venv-home-probe.ts");
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string" && !ENV_KEYS.includes(key as (typeof ENV_KEYS)[number])) env[key] = value;
		}
		env.HOME = repo;
		env.USERPROFILE = repo;
		const child = Bun.spawn([process.execPath, probe, repo], {
			cwd: repoRoot,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const reported = JSON.parse(stdout.trim()) as { pythonPath: string | null };
		expect(fs.existsSync(marker)).toBe(false);
		expect(under(path.join(repo, ".venv"), reported.pythonPath ?? undefined)).toBe(false);
		expect(under(path.join(repo, "venv"), reported.pythonPath ?? undefined)).toBe(false);
	}, 30_000);

	it.skipIf(!HOST_PYTHON || !SYMLINK_OK)(
		"does not select an outside interpreter symlink without pyvenv.cfg (skipped without python or symlink)",
		async () => {
			for (const name of [".venv", "venv"] as const) {
				using tempDir = TempDir.createSync(`@gjc-py-venv-nocfg-${name}-`);
				const repo = tempDir.join("repo");
				await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
				const pythonPath = interpreterFile(path.join(repo, name));
				await fs.promises.mkdir(path.dirname(pythonPath), { recursive: true });
				await fs.promises.symlink(HOST_PYTHON as string, pythonPath);
				await withProbeEnv({}, async () => {
					const session = sessionFor(repo);
					await pythonBackend.isAvailable(session);
					const availability = await checkPythonKernelAvailability(repo, undefined, undefined, session.settings);
					expect(under(path.join(repo, name), availability.pythonPath)).toBe(false);
				});
			}
		},
		30_000,
	);

	it.skipIf(!HOST_PYTHON || !SYMLINK_OK)(
		"still uses an outside interpreter symlink when pyvenv.cfg exists (skipped without python or symlink)",
		async () => {
			for (const name of [".venv", "venv"] as const) {
				using tempDir = TempDir.createSync(`@gjc-py-venv-cfg-${name}-`);
				const repo = tempDir.join("repo");
				await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
				const venv = path.join(repo, name);
				const pythonPath = interpreterFile(venv);
				await fs.promises.mkdir(path.dirname(pythonPath), { recursive: true });
				await fs.promises.symlink(HOST_PYTHON as string, pythonPath);
				await writeCfg(venv, path.dirname(HOST_PYTHON as string));
				await withProbeEnv({}, async () => {
					const session = sessionFor(repo);
					await pythonBackend.isAvailable(session);
					const availability = await checkPythonKernelAvailability(repo, undefined, undefined, session.settings);
					expect(under(venv, availability.pythonPath)).toBe(true);
				});
			}
		},
		30_000,
	);

	it.skipIf(!HOST_PYTHON)(
		"still uses VIRTUAL_ENV over a planted workspace .venv (skipped without python)",
		async () => {
			using tempDir = TempDir.createSync("@gjc-py-venv-env-");
			const marker = tempDir.join("planted-python-ran");
			const repo = tempDir.join("repo");
			const operator = tempDir.join("operator-venv");
			await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
			await writeScript(interpreterFile(path.join(repo, ".venv")), marker);
			await writeCfg(path.join(repo, ".venv"), path.dirname(HOST_PYTHON as string));
			await createVenv(operator);

			await withProbeEnv({ VIRTUAL_ENV: operator }, async () => {
				const session = sessionFor(repo);
				expect(await pythonBackend.isAvailable(session)).toBe(true);
				const availability = await checkPythonKernelAvailability(repo, undefined, undefined, session.settings);
				expect(fs.existsSync(marker)).toBe(false);
				expect(availability.ok).toBe(true);
				expect(under(operator, availability.pythonPath)).toBe(true);
				expect(under(path.join(repo, ".venv"), availability.pythonPath)).toBe(false);
			});
		},
		60_000,
	);

	it.skipIf(!SYMLINK_OK)(
		"does not execute a HOME workspace interpreter whose resolved name is ..payload (skipped without symlink)",
		async () => {
			for (const name of [".venv", "venv"] as const) {
				using tempDir = TempDir.createSync(`@gjc-py-venv-dotdot-${name}-`);
				const repo = tempDir.join("home");
				const marker = tempDir.join("planted-python-ran");
				const planted = path.join(repo, "..payload", "python");
				await fs.promises.mkdir(path.join(repo, ".git"), { recursive: true });
				await writeScript(planted, marker);
				const pythonPath = interpreterFile(path.join(repo, name));
				await fs.promises.mkdir(path.dirname(pythonPath), { recursive: true });
				await fs.promises.symlink(planted, pythonPath);
				await writeCfg(path.join(repo, name), path.dirname(HOST_PYTHON ?? "."));
				const repoRoot = path.resolve(import.meta.dir, "../../..");
				const probe = path.resolve(import.meta.dir, "../fixtures/python-workspace-venv-home-probe.ts");
				const env: Record<string, string> = {};
				for (const [key, value] of Object.entries(process.env)) {
					if (typeof value === "string" && !ENV_KEYS.includes(key as (typeof ENV_KEYS)[number])) env[key] = value;
				}
				env.HOME = repo;
				env.USERPROFILE = repo;
				const child = Bun.spawn([process.execPath, probe, repo], {
					cwd: repoRoot,
					env,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exitCode, stderr).toBe(0);
				const reported = JSON.parse(stdout.trim()) as { pythonPath: string | null };
				expect(fs.existsSync(marker)).toBe(false);
				expect(under(repo, fs.realpathSync(pythonPath))).toBe(true);
				expect(under(path.join(repo, name), reported.pythonPath ?? undefined)).toBe(false);
				expect(reported.pythonPath === null || path.resolve(reported.pythonPath) !== path.resolve(pythonPath)).toBe(
					true,
				);
			}
		},
		60_000,
	);

	it("property: workspace path containment agrees with the root prefix for dot-dot names", async () => {
		const { workspacePathContained } = await import("@gajae-code/coding-agent/eval/py/runtime");
		const leaf = fc.constantFrom("..payload", "a\\b", "python", ".venv", "bin");
		fc.assert(
			fc.property(
				fc.array(fc.stringMatching(/^[A-Za-z0-9]{1,8}$/), { minLength: 0, maxLength: 3 }),
				leaf,
				(segments, name) => {
					const root = path.resolve("/workspace-root");
					const inside = path.resolve(root, ...segments, name);
					const dotted = path.resolve(root, "a", "..", name);
					const outside = path.resolve(root, "..", name);
					expect(workspacePathContained(root, inside)).toBe(true);
					expect(workspacePathContained(root, inside)).toBe(referenceContained(root, inside));
					expect(workspacePathContained(root, dotted)).toBe(referenceContained(root, dotted));
					expect(workspacePathContained(root, dotted)).toBe(true);
					expect(workspacePathContained(root, outside)).toBe(false);
					expect(workspacePathContained(root, outside)).toBe(referenceContained(root, outside));
					expect(workspacePathContained(root, root)).toBe(true);
					expect(workspacePathContained(root, path.resolve(root, ".", name))).toBe(true);
					expect(workspacePathContained(root, `${root}-sib`)).toBe(false);
					expect(workspacePathContained(`${root}${path.sep}`, inside)).toBe(workspacePathContained(root, inside));
					const payload = path.resolve(root, ...segments, "..payload");
					const payloadRelative = path.relative(path.resolve(root), payload);
					expect(workspacePathContained(root, payload)).toBe(true);
					expect(workspacePathContained(root, payload)).toBe(referenceContained(root, payload));
					expect(relativePathEscapesRoot(payloadRelative)).toBe(false);
					expect(payloadRelative === "..payload" || payloadRelative.includes(`${path.sep}..payload`)).toBe(true);
				},
			),
			{ seed: 47521, numRuns: 80 },
		);
	});
});

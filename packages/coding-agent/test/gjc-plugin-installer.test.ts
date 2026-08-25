import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleUpdate,
	bundleIdentity,
	GjcPluginLoadError,
	getGjcBundle,
	installGjcBundle,
	isGjcPluginBundleSource,
	previewGjcBundleUpdate,
	readRegistry,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-install-"));
	tempDirs.push(cwd);
	return cwd;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			reject(new Error("Failed to allocate a local TCP port"));
			return;
		}
		server.close(error => {
			if (error) reject(error);
			else resolve(address.port);
		});
	});
	return promise;
}

async function startRejectingGitServer(): Promise<{ url: string; stop: () => Promise<void> }> {
	const server = createServer(socket => socket.destroy());
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") reject(new Error("Failed to start rejecting git server"));
		else resolve(address.port);
	});
	const port = await promise;
	return {
		url: `git://127.0.0.1:${port}/no-such-repo.git`,
		stop: async () => {
			const { promise: closed, resolve: resolveClosed, reject: rejectClosed } = Promise.withResolvers<void>();
			server.close(error => {
				if (error) rejectClosed(error);
				else resolveClosed();
			});
			await closed;
		},
	};
}

async function mkGitDaemonRepo(manifest: object): Promise<{ url: string; repoDir: string; stop: () => Promise<void> }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-git-src-"));
	tempDirs.push(base);
	const repoDir = path.join(base, "plugin-repo");
	await fs.mkdir(repoDir, { recursive: true });
	await fs.writeFile(path.join(repoDir, "gajae-plugin.json"), JSON.stringify(manifest));
	await fs.writeFile(path.join(repoDir, "README.md"), "# git-sourced plugin\n");
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env: gitEnv }).status).toBe(0);
	expect(spawnSync("git", ["add", "-A"], { cwd: repoDir, env: gitEnv }).status).toBe(0);
	expect(spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir, env: gitEnv }).status).toBe(0);

	const port = await getAvailablePort();
	const url = `git://127.0.0.1:${port}/plugin-repo`;
	const daemon = spawn(
		"git",
		["daemon", `--base-path=${base}`, "--export-all", "--listen=127.0.0.1", `--port=${port}`, "--reuseaddr"],
		{ stdio: "ignore" },
	);
	const startedAt = Date.now();
	while (true) {
		if (daemon.exitCode !== null) throw new Error(`git daemon exited before readiness with code ${daemon.exitCode}`);
		if (spawnSync("git", ["ls-remote", url, "HEAD"], { stdio: "ignore", timeout: 1_000 }).status === 0) break;
		if (Date.now() - startedAt > 5_000) {
			daemon.kill("SIGTERM");
			throw new Error("git daemon did not become ready within 5 seconds");
		}
		await Bun.sleep(100);
	}

	return {
		url,
		repoDir,
		stop: async () => {
			if (daemon.exitCode !== null) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			daemon.once("close", () => resolve());
			daemon.kill("SIGTERM");
			await promise;
		},
	};
}
describe("GJC plugin installer", () => {
	test("installs a local-path bundle into the project scope", async () => {
		const cwd = await mkProjectCwd();
		const result = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.status).toBe("installed");
		expect(result.value.summary.identity).toEqual(bundleIdentity("project", "valid-six-surface-bundle"));

		const installedDir = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle");
		expect(await exists(path.join(installedDir, "gajae-plugin.json"))).toBe(true);

		const registry = await readRegistry("project", cwd);
		expect(registry.plugins.map(p => p.name)).toEqual(["valid-six-surface-bundle"]);
		expect(registry.plugins[0]?.surfaces.tools[0]?.name).toBe("domain_note");
	});

	test("reinstalling identical content requires upgrade and an upgrade is unchanged", async () => {
		const cwd = await mkProjectCwd();
		const ctx = { cwd };
		const identity = bundleIdentity("project", "valid-six-surface-bundle");
		const first = await installGjcBundle(ctx, "project", sixSurface);
		expect(first.ok).toBe(true);

		const before = await getGjcBundle(ctx, identity);
		expect(before.ok).toBe(true);
		if (!before.ok) throw new Error(before.error.code);
		const second = await installGjcBundle(ctx, "project", sixSurface);
		expect(second).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });
		const after = await getGjcBundle(ctx, identity);
		expect(after.ok).toBe(true);
		if (!after.ok) throw new Error(after.error.code);
		expect(after.value.targetFingerprint).toBe(before.value.targetFingerprint);

		const preview = await previewGjcBundleUpdate(ctx, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value.changed).toBe(false);
		const applied = await applyGjcBundleUpdate(ctx, preview.value.token);
		expect(applied).toMatchObject({ ok: true, value: { status: "unchanged" } });
	});

	test("reinstalling different content requires upgrade and preview/apply updates", async () => {
		const cwd = await mkProjectCwd();
		const ctx = { cwd };
		const source = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-modsrc-"));
		tempDirs.push(source);
		await fs.cp(sixSurface, source, { recursive: true });
		const identity = bundleIdentity("project", "valid-six-surface-bundle");
		const first = await installGjcBundle(ctx, "project", source);
		expect(first.ok).toBe(true);

		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "\nExtra policy line.\n");
		const reinstall = await installGjcBundle(ctx, "project", source);
		expect(reinstall).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });

		const preview = await previewGjcBundleUpdate(ctx, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value.changed).toBe(true);
		const applied = await applyGjcBundleUpdate(ctx, preview.value.token);
		expect(applied).toMatchObject({ ok: true, value: { status: "updated" } });
		const summary = await getGjcBundle(ctx, identity);
		expect(summary.ok).toBe(true);
		if (!summary.ok) throw new Error(summary.error.code);
		expect(summary.value.version).toBe(preview.value.candidateVersion);
		expect(summary.value.manifestHash).toBe(preview.value.candidateManifestHash);
	});

	test("a bad bundle leaves no files and no registry entry", async () => {
		const cwd = await mkProjectCwd();
		const bad = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bad-"));
		tempDirs.push(bad);
		await fs.writeFile(
			path.join(bad, "gajae-plugin.json"),
			JSON.stringify({ kind: "gajae-code-plugin", name: "bad-bundle", version: "1.0.0", agents: [] }),
		);
		await expect(installGjcBundle({ cwd }, "project", bad)).rejects.toBeInstanceOf(GjcPluginLoadError);

		expect(await exists(path.join(cwd, ".gjc", "gjc-plugins", "bad-bundle"))).toBe(false);
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins).toEqual([]);
	});

	test("install never imports plugin code", async () => {
		const cwd = await mkProjectCwd();
		const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-install-sentinel-"));
		tempDirs.push(sentinelDir);
		const sentinel = path.join(sentinelDir, "sentinel.txt");
		const prev = process.env.GJC_TEST_IMPORT_SENTINEL;
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			await installGjcBundle({ cwd }, "project", sixSurface);
		} finally {
			if (prev === undefined) delete process.env.GJC_TEST_IMPORT_SENTINEL;
			else process.env.GJC_TEST_IMPORT_SENTINEL = prev;
		}
		expect(await exists(sentinel)).toBe(false);
	});

	test("installs from a tarball through the same validate step", async () => {
		const cwd = await mkProjectCwd();
		const tarDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tar-"));
		tempDirs.push(tarDir);
		const tarball = path.join(tarDir, "bundle.tar.gz");
		// Pack the fixture contents at the archive root.
		const res = spawnSync("tar", ["-czf", tarball, "-C", sixSurface, "."], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		expect(res.status).toBe(0);
		const result = await installGjcBundle({ cwd }, "project", tarball);
		expect(result).toMatchObject({ ok: true, value: { status: "installed" } });
		expect(await isGjcPluginBundleSource(tarball)).toBe(true);
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins[0]?.source.kind).toBe("tarball");
	});
	test("installs a git source bundle via a local git daemon", async () => {
		const served = await mkGitDaemonRepo({
			kind: "gajae-code-plugin",
			name: "git-source-bundle",
			version: "1.0.0",
			subskills: [],
			tools: [],
			hooks: [],
			mcps: [],
			system_appendix: [{ name: "git-policy", content: "policy body" }],
			"agent-appendix": [],
		});
		const cwd = await mkProjectCwd();
		try {
			const result = await installGjcBundle({ cwd }, "project", served.url);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error.code);
			expect(result.value.status).toBe("installed");
			expect(result.value.summary.source.kind).toBe("git");

			const installedDir = path.join(cwd, ".gjc", "gjc-plugins", "git-source-bundle");
			expect(await exists(path.join(installedDir, "gajae-plugin.json"))).toBe(true);

			const registry = await readRegistry("project", cwd);
			expect(registry.plugins.map(p => p.name)).toEqual(["git-source-bundle"]);
			expect(registry.plugins[0]?.source.kind).toBe("git");
			expect(typeof registry.plugins[0]?.source.sha).toBe("string");
		} finally {
			await served.stop();
		}
	});

	test("preview and apply agree on unavailable versus reachable malformed tar and git sources", async () => {
		const applyToken = (identity: ReturnType<typeof bundleIdentity>) => ({
			identity,
			agentDir: getAgentDir(),
			candidateFingerprint: "0".repeat(64),
			baselineFingerprint: "0".repeat(64),
			decisionContextFingerprint: "0".repeat(64),
			reviewedAt: new Date().toISOString(),
		});

		const validTarDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-classify-tar-"));
		tempDirs.push(validTarDir);
		const validTar = path.join(validTarDir, "bundle.tar.gz");
		expect(
			spawnSync("tar", ["-czf", validTar, "-C", sixSurface, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
				.status,
		).toBe(0);
		const unavailableTarCwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd: unavailableTarCwd }, "project", validTar)).ok).toBe(true);
		await fs.rm(validTar);
		const tarIdentity = bundleIdentity("project", "valid-six-surface-bundle");
		expect(await previewGjcBundleUpdate({ cwd: unavailableTarCwd }, tarIdentity)).toMatchObject({
			ok: false,
			error: { code: "source_unavailable" },
		});
		expect(await applyGjcBundleUpdate({ cwd: unavailableTarCwd }, applyToken(tarIdentity))).toMatchObject({
			ok: false,
			error: { code: "source_unavailable" },
		});

		const malformedTarDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-classify-malformed-tar-"));
		tempDirs.push(malformedTarDir);
		const validTar2 = path.join(malformedTarDir, "valid.tar.gz");
		expect(
			spawnSync("tar", ["-czf", validTar2, "-C", sixSurface, "."], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			}).status,
		).toBe(0);
		const malformedSource = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-classify-malformed-source-"));
		tempDirs.push(malformedSource);
		await fs.writeFile(path.join(malformedSource, "README.md"), "manifest intentionally absent\n");
		const malformedTar = path.join(malformedTarDir, "malformed.tar.gz");
		expect(
			spawnSync("tar", ["-czf", malformedTar, "-C", malformedSource, "."], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			}).status,
		).toBe(0);
		const malformedTarCwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd: malformedTarCwd }, "project", validTar2)).ok).toBe(true);
		await fs.copyFile(malformedTar, validTar2);
		expect(await previewGjcBundleUpdate({ cwd: malformedTarCwd }, tarIdentity)).toMatchObject({
			ok: false,
			error: { code: "invalid_target" },
		});
		expect(await applyGjcBundleUpdate({ cwd: malformedTarCwd }, applyToken(tarIdentity))).toMatchObject({
			ok: false,
			error: { code: "invalid_target" },
		});

		const unavailableGit = await mkGitDaemonRepo({
			kind: "gajae-code-plugin",
			name: "git-classify",
			version: "1.0.0",
			tools: [],
			subskills: [],
		});
		const unavailableGitCwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd: unavailableGitCwd }, "project", unavailableGit.url)).ok).toBe(true);
		await unavailableGit.stop();
		const gitIdentity = bundleIdentity("project", "git-classify");
		expect(await previewGjcBundleUpdate({ cwd: unavailableGitCwd }, gitIdentity)).toMatchObject({
			ok: false,
			error: { code: "source_unavailable" },
		});
		expect(await applyGjcBundleUpdate({ cwd: unavailableGitCwd }, applyToken(gitIdentity))).toMatchObject({
			ok: false,
			error: { code: "source_unavailable" },
		});

		const malformedGit = await mkGitDaemonRepo({
			kind: "gajae-code-plugin",
			name: "git-malformed",
			version: "1.0.0",
			tools: [],
			subskills: [],
		});
		const malformedGitCwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd: malformedGitCwd }, "project", malformedGit.url)).ok).toBe(true);
		await fs.rm(path.join(malformedGit.repoDir, "gajae-plugin.json"));
		spawnSync("git", ["add", "-A"], { cwd: malformedGit.repoDir });
		spawnSync(
			"git",
			["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "remove manifest"],
			{ cwd: malformedGit.repoDir },
		);
		const malformedGitIdentity = bundleIdentity("project", "git-malformed");
		expect(await previewGjcBundleUpdate({ cwd: malformedGitCwd }, malformedGitIdentity)).toMatchObject({
			ok: false,
			error: { code: "invalid_target" },
		});
		expect(await applyGjcBundleUpdate({ cwd: malformedGitCwd }, applyToken(malformedGitIdentity))).toMatchObject({
			ok: false,
			error: { code: "invalid_target" },
		});
		await malformedGit.stop();
	});
	test("an unavailable git source maps to a typed missing_file install error", async () => {
		const cwd = await mkProjectCwd();
		const rejectingServer = await startRejectingGitServer();
		try {
			await expect(installGjcBundle({ cwd }, "project", rejectingServer.url)).rejects.toMatchObject({
				code: "missing_file",
				name: "GjcPluginLoadError",
			});
		} finally {
			await rejectingServer.stop();
		}
		const registry = await readRegistry("project", cwd);
		expect(registry.plugins).toEqual([]);
		expect(await exists(path.join(cwd, ".gjc", "gjc-plugins", "no-such-repo"))).toBe(false);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	executableCommandNames,
	findGjcOnPath,
	type GjcHit,
	isWorkspaceSourceGjcHit,
} from "./dev-link";

const tempRoots: string[] = [];

async function makeExecutable(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function linkWorkspaceCodingAgent(root: string, packageRoot: string): Promise<void> {
	const scopeDir = path.join(root, "node_modules", "@gajae-code");
	await fs.mkdir(scopeDir, { recursive: true });
	await fs.symlink(packageRoot, path.join(scopeDir, "coding-agent"), process.platform === "win32" ? "junction" : "dir");
}

async function makeCodingAgentPackage(root: string): Promise<{ cliSource: string; packageRoot: string }> {
	const packageRoot = path.join(root, "packages", "coding-agent");
	const cliSource = path.join(packageRoot, "src", "cli.ts");
	await Bun.write(cliSource, "export async function runCli(): Promise<void> {}\n");
	await Bun.write(path.join(packageRoot, "bin", "gjc.js"), "#!/usr/bin/env bun\n");
	return { cliSource, packageRoot };
}

async function makeWorkspaceShim(root: string, name: string): Promise<string> {
	const shim = path.join(root, "node_modules", ".bin", name);
	await makeExecutable(shim, "#!/usr/bin/env sh\nexit 0\n");
	return shim;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("dev:link", () => {
	test("resolves Windows gjc.exe shims through PATHEXT", () => {
		const firstBinDir = path.join(os.tmpdir(), "workspace", "node_modules", ".bin");
		const secondBinDir = path.join(os.tmpdir(), "other-bin");
		const gjcExe = path.join(firstBinDir, "gjc.exe");
		const existing = new Set([gjcExe]);

		const hits = findGjcOnPath({
			exists: file => existing.has(file),
			pathext: ".COM;.EXE;.CMD",
			pathValue: `${firstBinDir};${secondBinDir}`,
			platform: "win32",
			realpath: file => file,
		});

		expect(executableCommandNames("gjc", "win32", ".EXE;.CMD;.exe")).toEqual(["gjc", "gjc.exe", "gjc.cmd"]);
		expect(hits).toEqual([{ dir: firstBinDir, file: gjcExe, real: gjcExe }]);
	});

	test("accepts a Bun workspace gjc.exe shim backed by the local coding-agent package", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-windows-shim-"));
		tempRoots.push(root);
		const { cliSource, packageRoot } = await makeCodingAgentPackage(root);
		await linkWorkspaceCodingAgent(root, packageRoot);
		const shim = await makeWorkspaceShim(root, "gjc.exe");
		const hit: GjcHit = { dir: path.dirname(shim), file: shim, real: await fs.realpath(shim) };

		expect(
			isWorkspaceSourceGjcHit(hit, {
				cliSourceReal: await fs.realpath(cliSource),
				platform: "win32",
				repoRoot: root,
			}),
		).toBe(true);
	});

	test("rejects a repo-local gjc.exe shim when the workspace package link points elsewhere", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-foreign-shim-"));
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-foreign-package-"));
		tempRoots.push(root, foreignRoot);
		const { cliSource } = await makeCodingAgentPackage(root);
		const foreignPackage = path.join(foreignRoot, "packages", "coding-agent");
		await Bun.write(path.join(foreignPackage, "bin", "gjc.js"), "#!/usr/bin/env bun\n");
		await linkWorkspaceCodingAgent(root, foreignPackage);
		const shim = await makeWorkspaceShim(root, "gjc.exe");
		const hit: GjcHit = { dir: path.dirname(shim), file: shim, real: await fs.realpath(shim) };

		expect(
			isWorkspaceSourceGjcHit(hit, {
				cliSourceReal: await fs.realpath(cliSource),
				platform: "win32",
				repoRoot: root,
			}),
		).toBe(false);
	});

	test("fails when a shadow gjc earlier on PATH would make smoke-test validate the wrong command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-shadow-"));
		tempRoots.push(root);
		const shadowDir = path.join(root, "shadow-bin");
		const targetDir = path.join(root, "managed-bin");
		await makeExecutable(
			path.join(shadowDir, "gjc"),
			`#!/usr/bin/env sh\nif [ "$1" = "--smoke-test" ]; then echo "smoke-test: ok"; exit 0; fi\necho shadow\nexit 0\n`,
		);

		const result = Bun.spawnSync([process.execPath, "scripts/dev-link.ts"], {
			env: {
				...process.env,
				GJC_DEV_LINK_DIR: targetDir,
				PATH: `${shadowDir}:${targetDir}`,
			},
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toContain(`Linked ${path.join(targetDir, "gjc")}`);
		expect(result.stderr.toString()).toContain("still resolves to a different command earlier on PATH");
		expect(result.stderr.toString()).toContain(path.join(shadowDir, "gjc"));
	});
});

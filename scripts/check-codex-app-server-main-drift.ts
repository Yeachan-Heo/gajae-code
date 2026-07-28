#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const vendorRoot = path.join(repoRoot, "packages/coding-agent/vendor/codex-app-server-schema");
const codexRoot = process.argv[2];

if (!codexRoot) {
	throw new Error("Usage: bun scripts/check-codex-app-server-main-drift.ts <codex-main-checkout>");
}

async function files(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const relative = entry.name;
		const absolute = path.join(root, relative);
		if (entry.isDirectory()) {
			for (const child of await files(absolute)) found.push(path.join(relative, child));
		} else if (entry.isFile()) {
			found.push(relative);
		} else {
			throw new Error(`Unsupported entry in schema tree: ${absolute}`);
		}
	}
	return found.sort();
}

async function compareTrees(expected: string, actual: string): Promise<string[]> {
	const [expectedFiles, actualFiles] = await Promise.all([files(expected), files(actual)]);
	const paths = new Set([...expectedFiles, ...actualFiles]);
	const drift: string[] = [];
	for (const relative of Array.from(paths).sort()) {
		const expectedPath = path.join(expected, relative);
		const actualPath = path.join(actual, relative);
		const [expectedExists, actualExists] = await Promise.all([Bun.file(expectedPath).exists(), Bun.file(actualPath).exists()]);
		if (!expectedExists) {
			drift.push(`added ${relative}`);
			continue;
		}
		if (!actualExists) {
			drift.push(`removed ${relative}`);
			continue;
		}
		if (!Buffer.from(await Bun.file(expectedPath).arrayBuffer()).equals(Buffer.from(await Bun.file(actualPath).arrayBuffer()))) drift.push(`changed ${relative}`);
	}
	return drift;
}

async function exportProfile(output: string, experimental: boolean): Promise<void> {
	const command = ["cargo", "run", "-p", "codex-app-server-protocol", "--bin", "export", "--", "--out", output, ...(experimental ? ["--experimental"] : [])];
	const process = Bun.spawn(command, { cwd: codexRoot, stdout: "inherit", stderr: "inherit" });
	if (await process.exited !== 0) throw new Error(`Codex ${experimental ? "experimental" : "stable"} schema export failed`);
}

const mainCommitProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: codexRoot, stdout: "pipe", stderr: "pipe" });
if (await mainCommitProcess.exited !== 0) throw new Error(`Not a readable Codex checkout: ${codexRoot}`);
const mainCommit = (await new Response(mainCommitProcess.stdout).text()).trim();
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-main-drift-"));

try {
	await exportProfile(path.join(temporaryRoot, "stable"), false);
	await exportProfile(path.join(temporaryRoot, "experimental"), true);
	const drift = (await Promise.all(["stable", "experimental"].map(async profile => {
		const profileDrift = [
			...(await compareTrees(path.join(vendorRoot, profile, "json"), path.join(temporaryRoot, profile, "json"))).map(entry => `${profile}/json ${entry}`),
			...(await compareTrees(path.join(vendorRoot, profile, "typescript"), path.join(temporaryRoot, profile, "typescript"))).map(entry => `${profile}/typescript ${entry}`),
		];
		return profileDrift;
	}))).flat();
	if (drift.length) {
		console.error(`Codex app-server schema drift from main ${mainCommit}:`);
		for (const entry of drift) console.error(` - ${entry}`);
		process.exitCode = 1;
	} else {
		console.log(`No Codex app-server schema drift from main ${mainCommit}.`);
	}
} finally {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
}

import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { type CliConfig, run } from "@gajae-code/utils/cli";

import { commands } from "../../../src/cli";

type CapturedOutput = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | string | undefined;
};

type VersionedError = {
	readonly schemaVersion: string;
	readonly code: string;
	readonly exitCode: number;
};

const CONFIG: CliConfig = { bin: "gjc", version: "0.0.0-test", commands: new Map() };
let captureQueue: Promise<void> = Promise.resolve();

async function captureOutput(runAction: () => Promise<void>): Promise<CapturedOutput> {
	const previousCapture = captureQueue;
	let release!: () => void;
	captureQueue = new Promise<void>(resolve => {
		release = resolve;
	});
	await previousCapture;

	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const originalExitCode = process.exitCode;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	process.exitCode = 0;

	try {
		await runAction();
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		process.exitCode = originalExitCode ?? 0;
		release();
	}
}

async function runRegistered(argv: readonly string[]): Promise<CapturedOutput> {
	return captureOutput(() => run({ bin: CONFIG.bin, version: CONFIG.version, argv: [...argv], commands }));
}

async function withIsolatedRoot<T>(runAction: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-write-lifecycle-"));
	const previousAgentDir = getAgentDir();
	const previousProjectDir = getProjectDir();
	const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
	try {
		setAgentDir(agentDir);
		setProjectDir(agentDir);
		process.env.GJC_CODING_AGENT_DIR = agentDir;
		return await runAction(agentDir);
	} finally {
		setAgentDir(previousAgentDir);
		setProjectDir(previousProjectDir);
		if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function snapshotTree(root: string): Promise<readonly string[]> {
	const output: string[] = [];
	async function visit(current: string, prefix: string): Promise<void> {
		let entries: readonly Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
			const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			const absolutePath = path.join(current, entry.name);
			const stat = await fs.lstat(absolutePath);
			const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
			const content = kind === "file" ? (await fs.readFile(absolutePath)).toString("base64") : "";
			output.push(`${relPath}\t${kind}\t${stat.mode & 0o7777}\t${content}`);
			if (kind === "directory" && !stat.isSymbolicLink()) await visit(absolutePath, relPath);
		}
	}
	await visit(root, "");
	return output;
}

function parseJson<T>(output: CapturedOutput): T {
	expect(output.stderr).toBe("");
	return JSON.parse(output.stdout) as T;
}

function parseError(output: CapturedOutput): VersionedError {
	expect(output.stderr).toContain("error:");
	return JSON.parse(output.stdout) as VersionedError;
}

describe("registered M6 memory write lifecycle", () => {
	it("returns typed not-initialized failures before init without creating a store", async () => {
		await withIsolatedRoot(async agentDir => {
			// Scope to the memory root: the agent dir also holds unrelated runtime state
			// (agent.db plus its WAL/SHM sidecars).
			const before = await snapshotTree(path.join(agentDir, "memory"));
			const actions: readonly (readonly string[])[] = [
				["resolve", "global://missing.md", "--json"],
				["get", "global://missing.md", "--json"],
				["search", "missing", "--json"],
				["recall", "missing", "--json"],
				["checkpoint", "--goal", "goal", "--task", "task", "--session-id", "write-test", "--json"],
				["resume", "--session-id", "write-test", "--json"],
				["doctor", "--json"],
				["propose", "--type", "note", "--content", "before init", "--json"],
				["apply", "unknown-proposal", "--json"],
				["forget", "global://missing.md", "--json"],
			];

			for (const action of actions) {
				const result = await runRegistered(["memory", ...action]);
				expect(result.exitCode, action.join(" ")).toBe(3);
				expect(parseError(result)).toMatchObject({
					schemaVersion: "gajae.memory.error.v1",
					code: "not-initialized",
					exitCode: 3,
				});
				expect(await snapshotTree(path.join(agentDir, "memory"))).toEqual(before);
			}
		});
	});

	it("completes propose, apply, and forget through the registered command", async () => {
		await withIsolatedRoot(async agentDir => {
			const initialized = await runRegistered(["memory", "init", "--json"]);
			expect(initialized).toMatchObject({ stderr: "", exitCode: 0 });
			expect(parseJson<{ readonly schemaVersion: string }>(initialized).schemaVersion).toBe(
				"gajae.memory.init-receipt.v1",
			);

			const proposed = await runRegistered([
				"memory",
				"propose",
				"--type",
				"decision",
				"--content",
				"Use the append-only transaction.",
				"--target-uri",
				"global://constraints/transaction.md",
				"--json",
			]);
			expect(proposed).toMatchObject({ stderr: "", exitCode: 0 });
			const proposal = parseJson<{
				readonly schemaVersion: string;
				readonly proposalId: string;
				readonly recommendedUri: string;
				readonly requiresApproval: boolean;
				readonly conflicts: readonly unknown[];
			}>(proposed);
			expect(proposal).toMatchObject({
				schemaVersion: "gajae.memory.write-proposal.v1",
				recommendedUri: "global://constraints/transaction.md",
				requiresApproval: true,
				conflicts: [],
			});
			expect(proposal.proposalId).toMatch(/^[0-9a-f]{64}$/);

			const applied = await runRegistered(["memory", "apply", proposal.proposalId, "--json"]);
			expect(applied).toMatchObject({ stderr: "", exitCode: 0 });
			expect(parseJson<{ readonly schemaVersion: string; readonly proposalId: string }>(applied)).toMatchObject({
				schemaVersion: "gajae.memory.apply-receipt.v1",
				proposalId: proposal.proposalId,
			});
			expect(
				await fs.readFile(path.join(agentDir, "memory", "global", "constraints", "transaction.md"), "utf8"),
			).toContain("Use the append-only transaction.");
			expect(await fs.readFile(path.join(agentDir, "memory", "MEMORY.md"), "utf8")).toContain(
				"memory://global/constraints/transaction.md",
			);
			expect(
				await fs.stat(path.join(agentDir, "memory", "global", `proposals-${proposal.proposalId}.receipt.json`)),
			).toBeDefined();

			const current = await runRegistered(["memory", "get", "global://constraints/transaction.md", "--json"]);
			const currentDocument = parseJson<{ readonly digest: string }>(current);
			expect(currentDocument.digest).toMatch(/^[0-9a-f]{64}$/);

			const staleBefore = await snapshotTree(path.join(agentDir, "memory"));
			const stale = await runRegistered([
				"memory",
				"forget",
				"global://constraints/transaction.md",
				"--expected-digest",
				"0".repeat(64),
				"--json",
			]);
			expect(stale.exitCode).toBe(12);
			expect(parseError(stale)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "lock-conflict",
				exitCode: 12,
			});
			expect(await snapshotTree(path.join(agentDir, "memory"))).toEqual(staleBefore);

			const forgotten = await runRegistered([
				"memory",
				"forget",
				"global://constraints/transaction.md",
				"--expected-digest",
				currentDocument.digest,
				"--reason",
				"no longer current",
				"--json",
			]);
			expect(forgotten).toMatchObject({ stderr: "", exitCode: 0 });
			expect(
				parseJson<{ readonly schemaVersion: string; readonly forgotten: boolean; readonly superseded: boolean }>(
					forgotten,
				),
			).toMatchObject({
				schemaVersion: "gajae.memory.forget-receipt.v1",
				forgotten: true,
				superseded: true,
			});
			expect(
				await fs.readFile(path.join(agentDir, "memory", "global", "constraints", "transaction.md"), "utf8"),
			).toContain("gajae: tombstone no longer current");
			expect(
				(await fs.readdir(path.join(agentDir, "memory", "global"))).filter(name => name.endsWith(".receipt.json")),
			).toHaveLength(2);
		});
	});

	it("refuses secret-bearing content and unknown proposals without writes", async () => {
		await withIsolatedRoot(async agentDir => {
			const initialized = await runRegistered(["memory", "init", "--json"]);
			expect(initialized.exitCode).toBe(0);
			const beforeSecret = await snapshotTree(path.join(agentDir, "memory"));
			const secret = await runRegistered([
				"memory",
				"propose",
				"--type",
				"note",
				"--content",
				"password-super-secret-token-123456",
				"--target-uri",
				"global://profile/secret.md",
				"--json",
			]);
			expect(secret.exitCode).toBe(11);
			expect(parseError(secret)).toMatchObject({ code: "sensitivity-violation", exitCode: 11 });
			expect(await snapshotTree(path.join(agentDir, "memory"))).toEqual(beforeSecret);

			const beforeUnknown = await snapshotTree(path.join(agentDir, "memory"));
			const unknown = await runRegistered(["memory", "apply", "unknown-proposal", "--json"]);
			expect(unknown.exitCode).toBe(5);
			expect(parseError(unknown)).toMatchObject({ code: "not-found", exitCode: 5 });
			expect(await snapshotTree(path.join(agentDir, "memory"))).toEqual(beforeUnknown);
		});
	});

	it("rejects missing required values and unexpected positionals with exit 2", async () => {
		await withIsolatedRoot(async agentDir => {
			// Scope to the memory root: the agent dir also holds unrelated runtime state
			// (agent.db plus its WAL/SHM sidecars).
			const before = await snapshotTree(path.join(agentDir, "memory"));
			for (const args of [
				["memory", "apply", "--json"],
				["memory", "forget", "--json"],
				["memory", "propose", "unexpected", "--type", "note", "--content", "value", "--json"],
			] as const) {
				const result = await runRegistered(args);
				expect(result.exitCode, args.join(" ")).toBe(2);
				expect(parseError(result)).toMatchObject({ code: "invalid-input", exitCode: 2 });
				expect(await snapshotTree(path.join(agentDir, "memory"))).toEqual(before);
			}
		});
	});
});

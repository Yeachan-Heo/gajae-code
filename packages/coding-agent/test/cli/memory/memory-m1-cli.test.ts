import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MemoryCommandArgs, type MemoryCommandDependencies, runMemoryCommand } from "../../../src/cli/memory";

type CapturedOutput = {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
};

const EXPECTED_CAPABILITIES = {
	schemaVersion: "gajae.memory.capabilities.v1",
	packageVersion: "0.12.0",
	milestone: "M6",
	commands: [
		"init",
		"capabilities",
		"scopes",
		"resolve",
		"get",
		"search",
		"recall",
		"checkpoint",
		"resume",
		"doctor",
		"propose",
		"apply",
		"forget",
	],
	agentTools: ["memory_recall", "memory_checkpoint", "memory_propose_write", "memory_forget"],
	schemaVersions: {
		capabilities: "gajae.memory.capabilities.v1",
		initReceipt: "gajae.memory.init-receipt.v1",
		scopeResolution: "gajae.memory.scope-resolution.v1",
		searchResult: "gajae.memory.search-result.v1",
		recall: "gajae.memory.recall.v1",
		retrievalLedgerEntry: "gajae.memory.retrieval-ledger-entry.v1",
		error: "gajae.memory.error.v1",
		checkpoint: "gajae.memory.checkpoint.v1",
		handoff: "gajae.memory.handoff.v1",
		audit: "gajae.memory.audit.v1",
		writeProposal: "gajae.memory.write-proposal.v1",
		applyReceipt: "gajae.memory.apply-receipt.v1",
		forgetReceipt: "gajae.memory.forget-receipt.v1",
		resource: "gajae.memory.resource.v1",
	},
	features: {
		deterministicRetrieval: true,
		writes: true,
		checkpointResume: true,
	},
	absentOptionalFeatures: ["answer", "mcp", "embeddings", "graphrag", "legacy-data-migration", "remote-service"],
} as const;

const EXPECTED_SCAFFOLD = [
	".journal",
	".locks",
	"MEMORY.md",
	"config.yaml",
	"global",
	"global/archive",
	"global/constraints",
	"global/conventions",
	"global/profile",
	"projects",
	"projects/registry.yaml",
	"routes.yaml",
	"sessions",
] as const;

const EXPECTED_FILES = ["MEMORY.md", "config.yaml", "projects/registry.yaml", "routes.yaml"] as const;

let captureQueue: Promise<void> = Promise.resolve();

async function captureOutput(run: () => Promise<void>): Promise<CapturedOutput> {
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
		await run();
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		process.exitCode = originalExitCode ?? 0;
		release();
	}
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-m1-cli-"));
	try {
		return await run(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

function dependenciesFor(agentDir: string): MemoryCommandDependencies {
	return {
		settings: { getAgentDir: () => agentDir },
		clock: () => new Date("2026-07-29T00:00:00.000Z"),
	};
}

function command(action: MemoryCommandArgs["action"], json = false): MemoryCommandArgs {
	return { action, flags: { json } };
}

async function readExpectedFiles(memoryRoot: string): Promise<Record<string, string>> {
	const entries = await Promise.all(
		EXPECTED_FILES.map(async relPath => [relPath, await Bun.file(path.join(memoryRoot, relPath)).text()] as const),
	);
	return Object.fromEntries(entries);
}

describe("M1 memory CLI handler", () => {
	it("renders deterministic human capabilities before initialization", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = dependenciesFor(agentDir);
			const first = await captureOutput(() => runMemoryCommand(command("capabilities"), deps));
			const second = await captureOutput(() => runMemoryCommand(command("capabilities"), deps));
			const expected = [
				"Memory capabilities (gajae.memory.capabilities.v1)",
				"Package: @gajae-code/memory-core 0.12.0",
				"Milestone: M6",
				"Commands: init, capabilities, scopes, resolve, get, search, recall, checkpoint, resume, doctor, propose, apply, forget",
				"Agent tools: memory_recall, memory_checkpoint, memory_propose_write, memory_forget",
				"Absent optional features: answer, mcp, embeddings, graphrag, legacy-data-migration, remote-service",
				"",
			].join("\n");

			expect(first).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
			expect(second).toEqual(first);
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("emits versioned deterministic capabilities JSON with stdout-only success", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = dependenciesFor(agentDir);
			const first = await captureOutput(() => runMemoryCommand(command("capabilities", true), deps));
			const second = await captureOutput(() => runMemoryCommand(command("capabilities", true), deps));
			const expected = `${JSON.stringify(EXPECTED_CAPABILITIES, null, 2)}\n`;

			expect(first).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
			expect(second).toEqual(first);
			expect(JSON.parse(first.stdout)).toEqual(EXPECTED_CAPABILITIES);
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("initializes exactly under the injected agent directory in human mode", async () => {
		await withTempAgentDir(async agentDir => {
			const memoryRoot = path.join(await fs.realpath(agentDir), "memory");

			const deps = dependenciesFor(agentDir);
			const first = await captureOutput(() => runMemoryCommand(command("init"), deps));
			const second = await captureOutput(() => runMemoryCommand(command("init"), deps));

			expect(first).toEqual({
				stdout: `Initialized memory root: ${memoryRoot} (${EXPECTED_SCAFFOLD.length} paths created)\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(second).toEqual({
				stdout: `Memory root already initialized: ${memoryRoot}\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(await fs.realpath(memoryRoot)).toBe(memoryRoot);
			expect((await fs.readdir(agentDir)).sort()).toEqual(["memory"]);
			expect((await fs.readdir(memoryRoot)).sort()).toEqual([
				".journal",
				".locks",
				"MEMORY.md",
				"config.yaml",
				"global",
				"projects",
				"routes.yaml",
				"sessions",
			]);
			for (const relPath of EXPECTED_SCAFFOLD) {
				const stats = await fs.lstat(path.join(memoryRoot, relPath));
				const isFile = EXPECTED_FILES.some(file => file === relPath);
				expect(isFile ? stats.isFile() : stats.isDirectory()).toBe(true);
			}
		});
	});

	it("emits versioned init receipts and keeps the scaffold idempotent in JSON mode", async () => {
		await withTempAgentDir(async agentDir => {
			const memoryRoot = path.join(await fs.realpath(agentDir), "memory");

			const deps = dependenciesFor(agentDir);
			const first = await captureOutput(() => runMemoryCommand(command("init", true), deps));
			const firstPayload = JSON.parse(first.stdout) as {
				schemaVersion: string;
				memoryRoot: string;
				created: readonly string[];
				alreadyPresent: readonly string[];
			};
			const before = await readExpectedFiles(memoryRoot);
			const second = await captureOutput(() => runMemoryCommand(command("init", true), deps));
			const secondPayload = JSON.parse(second.stdout) as typeof firstPayload;
			const after = await readExpectedFiles(memoryRoot);

			expect(first.stderr).toBe("");
			expect(first.exitCode).toBe(0);
			expect(firstPayload).toEqual({
				schemaVersion: "gajae.memory.init-receipt.v1",
				memoryRoot,
				created: EXPECTED_SCAFFOLD,
				alreadyPresent: [],
			});
			expect(second).toEqual({
				stdout: `${JSON.stringify(
					{
						schemaVersion: "gajae.memory.init-receipt.v1",
						memoryRoot,
						created: [],
						alreadyPresent: EXPECTED_SCAFFOLD,
					},
					null,
					2,
				)}\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(secondPayload).toEqual({
				schemaVersion: "gajae.memory.init-receipt.v1",
				memoryRoot,
				created: [],
				alreadyPresent: EXPECTED_SCAFFOLD,
			});
			expect(after).toEqual(before);
		});
	});
	it("renders sanitized initialization failures in human mode", async () => {
		await withTempAgentDir(async agentDir => {
			const memoryRoot = path.join(agentDir, "memory");
			await fs.writeFile(memoryRoot, "not a directory\n");
			const output = await captureOutput(() => runMemoryCommand(command("init"), dependenciesFor(agentDir)));
			const envelope = {
				schemaVersion: "gajae.memory.error.v1",
				code: "policy-denied",
				exitCode: 6,
				destination: "global-canonical",
				reason: "memory initialization denied: root-not-directory",
			};

			expect(output).toEqual({
				stdout: "",
				stderr: `error: policy-denied\n${JSON.stringify(envelope, null, 2)}\n`,
				exitCode: 6,
			});
			expect(output.stderr).not.toContain(agentDir);
		});
	});

	it("emits sanitized initialization failures as deterministic JSON", async () => {
		await withTempAgentDir(async agentDir => {
			const memoryRoot = path.join(agentDir, "memory");
			await fs.writeFile(memoryRoot, "not a directory\n");
			const output = await captureOutput(() => runMemoryCommand(command("init", true), dependenciesFor(agentDir)));
			const envelope = {
				schemaVersion: "gajae.memory.error.v1",
				code: "policy-denied",
				exitCode: 6,
				destination: "global-canonical",
				reason: "memory initialization denied: root-not-directory",
			};
			const expected = `${JSON.stringify(envelope, null, 2)}\n`;

			expect(output).toEqual({
				stdout: expected,
				stderr: `error: policy-denied\n${expected}`,
				exitCode: 6,
			});
			expect(JSON.parse(output.stdout)).toEqual(envelope);
			expect(output.stdout).not.toContain(agentDir);
		});
	});
});

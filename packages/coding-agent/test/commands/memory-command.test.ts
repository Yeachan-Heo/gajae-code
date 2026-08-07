import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { type CliConfig, run } from "@gajae-code/utils/cli";

import { commands } from "../../src/cli";

import Memory from "../../src/commands/memory";

type CapturedOutput = {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
};

const CONFIG: CliConfig = {
	bin: "gjc",
	version: "0.0.0-test",
	commands: new Map(),
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

async function runCapturing(argv: string[]): Promise<CapturedOutput> {
	return captureOutput(() => run({ bin: CONFIG.bin, version: CONFIG.version, argv, commands }));
}

async function withIsolatedCliRoot<T>(runAction: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-command-"));
	const previousAgentDir = getAgentDir();
	const previousProjectDir = getProjectDir();
	const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
	try {
		setAgentDir(agentDir);
		setProjectDir(agentDir);
		return await runAction(agentDir);
	} finally {
		setAgentDir(previousAgentDir);
		setProjectDir(previousProjectDir);
		if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("gjc memory command parsing and dispatch", () => {
	it("registers and lazily loads the production memory command", async () => {
		const entry = commands.find(command => command.name === "memory");
		expect(entry).toBeDefined();
		expect(await entry!.load()).toBe(Memory);
	});
	it.each([
		"init",
		"capabilities",
		"scopes",
		"resolve",
		"get",
		"search",
		"recall",
	] as const)("accepts the advertised %s action", async action => {
		const parsed = await new Memory([action], CONFIG).parse(Memory);

		expect(parsed.args.action).toBe(action);
		expect(parsed.flags.json).toBeUndefined();
	});

	it.each([
		"init",
		"capabilities",
		"scopes",
	] as const)("rejects a positional value for value-less %s through the registered command", async action => {
		await withIsolatedCliRoot(async agentDir => {
			const result = await runCapturing(["memory", action, "unexpected", "--json"]);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("error: invalid-input");
			expect(JSON.parse(result.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "invalid-input",
				exitCode: 2,
			});
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it.each([
		"resolve",
		"get",
		"search",
		"recall",
	] as const)("keeps missing-value validation for %s on the registered command", async action => {
		await withIsolatedCliRoot(async () => {
			const result = await runCapturing(["memory", action, "--json"]);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("error: invalid-input");
			expect(JSON.parse(result.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "invalid-input",
				exitCode: 2,
			});
		});
	});

	it("routes unsupported --format values through the registered command's typed error envelope", async () => {
		await withIsolatedCliRoot(async agentDir => {
			const result = await runCapturing(["memory", "recall", "needle", "--format", "yaml"]);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("error: invalid-input");
			expect(result.stderr).not.toContain("USAGE");
			expect(result.stdout).not.toContain("USAGE");
			expect(JSON.parse(result.stdout)).toEqual({
				schemaVersion: "gajae.memory.error.v1",
				code: "invalid-input",
				exitCode: 2,
				detail: "memory format must be json or text",
			});
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("rejects unknown actions instead of passing them to the handler", async () => {
		await expect(new Memory(["inspect"], CONFIG).parse(Memory)).rejects.toThrow(
			'Expected action to be one of: init, capabilities, scopes, resolve, get, search, recall, checkpoint, resume, doctor, propose, apply, forget; got "inspect"',
		);
	});

	it("treats a missing action as help and supports explicit --help", async () => {
		const missing = await runCapturing(["memory"]);
		const explicit = await runCapturing(["memory", "--help"]);

		for (const result of [missing, explicit]) {
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("Initialize, inspect, or update the opt-in GJC memory capability");
			expect(result.stdout).toContain("USAGE");
			expect(result.stdout).toContain("$ gjc memory [ACTION] [VALUE] [FLAGS]");
			expect(result.stdout).toContain("init|capabilities|scopes|resolve|get|search|recall");
			expect(result.stdout).toContain("--json");
		}
	});

	it("renders usage and exits 2 for an unknown action", async () => {
		const result = await runCapturing(["memory", "inspect"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			'Expected action to be one of: init, capabilities, scopes, resolve, get, search, recall, checkpoint, resume, doctor, propose, apply, forget; got "inspect"',
		);
		expect(result.stdout).toContain("USAGE");
		expect(result.stdout).toContain("$ gjc memory [ACTION] [VALUE] [FLAGS]");
	});

	it("keeps unknown top-level commands on stderr with exit code 1", async () => {
		const result = await runCapturing(["memories"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Error: command memories not found\n");
	});

	it("passes --json to the capabilities handler and emits only versioned JSON", async () => {
		const parsed = await new Memory(["capabilities", "--json"], CONFIG).parse(Memory);
		expect(parsed.args.action).toBe("capabilities");
		expect(parsed.flags.json).toBe(true);

		const result = await runCapturing(["memory", "capabilities", "--json"]);

		expect(result).toEqual({
			stdout: `${JSON.stringify(EXPECTED_CAPABILITIES, null, 2)}\n`,
			stderr: "",
			exitCode: 0,
		});
	});

	it("parses --json for init without requiring an implicit action default", async () => {
		const parsed = await new Memory(["init", "--json"], CONFIG).parse(Memory);

		expect(parsed.args.action).toBe("init");
		expect(parsed.flags.json).toBe(true);
	});
});

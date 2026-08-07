import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { type CliConfig, run } from "@gajae-code/utils/cli";
import { commands } from "../../../src/cli";
import Memory from "../../../src/commands/memory";

type CapturedOutput = {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
};

type DoctorPayload = {
	readonly schemaVersion: string;
	readonly healthy: boolean;
	readonly findings: readonly {
		readonly code: string;
		readonly severity: string;
		readonly relPath: string | null;
		readonly detail: string;
	}[];
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

async function withIsolatedCliRoot<T>(runAction: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-doctor-cli-"));
	const previousAgentDir = getAgentDir();
	const previousProjectDir = getProjectDir();
	const previousAgentOverride = process.env.GJC_CODING_AGENT_DIR;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		setAgentDir(agentDir);
		setProjectDir(agentDir);
		delete process.env.GJC_SESSION_ID;
		return await runAction(agentDir);
	} finally {
		setAgentDir(previousAgentDir);
		setProjectDir(previousProjectDir);
		if (previousAgentOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = previousAgentOverride;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function runRegistered(argv: readonly string[]): Promise<CapturedOutput> {
	return captureOutput(() => run({ bin: CONFIG.bin, version: CONFIG.version, argv: [...argv], commands }));
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
		const ordered = [...entries].sort((left, right) =>
			Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
		);
		for (const entry of ordered) {
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

function brokenMap(): string {
	return [
		"# Memory Map",
		"",
		"<!-- AUTO:PROJECTS START -->",
		"[Missing document](memory://global/missing.md)",
		"<!-- AUTO:PROJECTS END -->",
		"",
		"<!-- AUTO:INDEX-HEALTH START -->",
		"<!-- AUTO:INDEX-HEALTH END -->",
		"",
	].join("\n");
}

async function initialize(agentDir: string): Promise<void> {
	const result = await runRegistered(["memory", "init", "--json"]);
	expect(result).toMatchObject({ stderr: "", exitCode: 0 });
	expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: "gajae.memory.init-receipt.v1" });
	expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeDefined();
}

describe("registered memory doctor command", () => {
	it("parses doctor and its positive integer max-bytes flag", async () => {
		const parsed = await new Memory(["doctor", "--max-bytes", "2048"], CONFIG).parse(Memory);
		expect(parsed.args).toEqual({ action: "doctor", value: undefined });
		expect(parsed.flags["max-bytes"]).toBe(2048);
	});

	it("returns typed not-initialized before init without creating a store", async () => {
		await withIsolatedCliRoot(async agentDir => {
			await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const before = await snapshotTree(agentDir);

			const result = await runRegistered(["memory", "doctor", "--json"]);
			expect(result.exitCode).toBe(3);
			expect(result.stderr).toContain("error: not-initialized");
			expect(JSON.parse(result.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "not-initialized",
				exitCode: 3,
			});
			expect(await snapshotTree(agentDir)).toEqual(before);
		});
	});

	it("reports a healthy initialized store as deterministic versioned JSON and does not mutate it", async () => {
		await withIsolatedCliRoot(async agentDir => {
			await initialize(agentDir);
			await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const before = await snapshotTree(agentDir);

			const first = await runRegistered(["memory", "doctor", "--json"]);
			expect(await snapshotTree(agentDir)).toEqual(before);
			const second = await runRegistered(["memory", "doctor", "--json"]);
			expect(await snapshotTree(agentDir)).toEqual(before);

			expect(first).toEqual(second);
			expect(first).toMatchObject({ stderr: "", exitCode: 0 });
			expect(first.stdout.startsWith("{")).toBe(true);
			const payload = JSON.parse(first.stdout) as DoctorPayload;
			expect(payload.schemaVersion).toBe("gajae.memory.audit.v1");
			expect(payload.healthy).toBe(true);
			expect(payload.findings.filter(finding => finding.severity === "error")).toHaveLength(0);
		});
	});

	it("reports stable defect findings, rejects values, and validates max-bytes", async () => {
		await withIsolatedCliRoot(async agentDir => {
			await initialize(agentDir);
			const defectPath = path.join(agentDir, "memory", "MEMORY.md");
			await fs.writeFile(defectPath, brokenMap());
			await fs.chmod(defectPath, 0o600);
			const before = await snapshotTree(agentDir);

			const result = await runRegistered(["memory", "doctor", "--json"]);
			expect(await snapshotTree(agentDir)).toEqual(before);
			expect(result).toMatchObject({ stderr: "", exitCode: 0 });
			const payload = JSON.parse(result.stdout) as DoctorPayload;
			expect(payload.healthy).toBe(false);
			expect(payload.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "structural.broken-map-link",
						severity: "error",
						relPath: "MEMORY.md",
					}),
				]),
			);

			const human = await runRegistered(["memory", "doctor"]);
			expect(human).toMatchObject({ stderr: "", exitCode: 0 });
			expect(human.stdout).toContain("healthy: false");
			expect(human.stdout).toContain("finding: severity=error code=structural.broken-map-link path=MEMORY.md");
			expect(await snapshotTree(agentDir)).toEqual(before);

			const unexpected = await runRegistered(["memory", "doctor", "unexpected-value", "--json"]);
			expect(unexpected.exitCode).toBe(2);
			expect(unexpected.stderr).toContain("error: invalid-input");
			expect(JSON.parse(unexpected.stdout)).toMatchObject({ code: "invalid-input", exitCode: 2 });

			const invalidMaxBytes = await runRegistered(["memory", "doctor", "--max-bytes", "0", "--json"]);
			expect(invalidMaxBytes.exitCode).toBe(2);
			expect(invalidMaxBytes.stderr).toContain("error: invalid-input");
			expect(JSON.parse(invalidMaxBytes.stdout)).toMatchObject({ code: "invalid-input", exitCode: 2 });
		});
	});
});

import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { type CliConfig, run } from "@gajae-code/utils/cli";
import { commands } from "../../../src/cli";
import {
	type MemoryCommandArgs,
	type MemoryCommandDependencies,
	type MemoryGitDependencies,
	runMemoryCommand,
} from "../../../src/cli/memory";
import Memory from "../../../src/commands/memory";

type CapturedOutput = {
	stdout: string;
	stderr: string;
	exitCode: number | string | undefined;
};

const AS_OF = "2026-07-29T00:00:00.000Z";
const CLI_SECRET = "sk_test_123456789012";
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

async function withTempAgentDir<T>(runAction: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-m2-cli-"));
	try {
		return await runAction(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function withRegisteredCliRoot<T>(runAction: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-m2-registered-"));
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

function gitOutsideRepository(): MemoryGitDependencies {
	return {
		repo: { resolve: async () => null },
		remote: {
			list: async () => [],
			url: async () => undefined,
		},
	};
}

function failingGit(): MemoryGitDependencies {
	return {
		repo: {
			resolve: async () => {
				throw new Error("/host/project/.git: remote output contains secret sk_live_123456789012");
			},
		},
		remote: {
			list: async () => {
				throw new Error("/host/project/.git/config: remote output contains secret sk_live_123456789012");
			},
			url: async () => undefined,
		},
	};
}

function dependenciesFor(agentDir: string): MemoryCommandDependencies {
	return {
		settings: { getAgentDir: () => agentDir },
		cwd: agentDir,
		clock: () => new Date(AS_OF),
		git: gitOutsideRepository(),
		env: {},
	};
}

function command(
	action: MemoryCommandArgs["action"],
	value?: string,
	flags: MemoryCommandArgs["flags"] = {},
): MemoryCommandArgs {
	return { action, value, flags };
}

function document(): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		"id: m2-cli-fixture",
		"type: fact",
		"scope: global",
		"authority: user-confirmed",
		"volatility: stable",
		"sensitivity: public-safe",
		"status: active",
		`created: ${AS_OF}`,
		`updated: ${AS_OF}`,
		"aliases: [needle]",
		"supersedes: []",
		"verification:",
		"  provider: local",
		"  resource: m2-cli-fixture",
		"  id: m2-cli-fixture",
		"---",
		"# M2 fixture",
		"The deterministic needle is present in this memory document.",
		"",
	].join("\n");
}

async function initializeFixture(agentDir: string): Promise<MemoryCommandDependencies> {
	const deps = dependenciesFor(agentDir);
	const init = await captureOutput(() => runMemoryCommand(command("init"), deps));
	expect(init).toMatchObject({ stderr: "", exitCode: 0 });
	await fs.writeFile(path.join(agentDir, "memory", "global", "fixture.md"), document(), { mode: 0o600 });
	await fs.mkdir(path.join(agentDir, "memory", "sessions", "m2-cli-session"), { recursive: true, mode: 0o700 });
	return deps;
}

async function initializeRegisteredFixture(agentDir: string): Promise<void> {
	const init = await captureOutput(() =>
		run({ bin: CONFIG.bin, version: CONFIG.version, argv: ["memory", "init", "--json"], commands }),
	);
	expect(init).toMatchObject({ stderr: "", exitCode: 0 });
	expect(JSON.parse(init.stdout)).toMatchObject({ schemaVersion: "gajae.memory.init-receipt.v1" });
	await fs.writeFile(
		path.join(agentDir, "memory", "global", "fixture.md"),
		document().replace("deterministic needle", `deterministic needle ${CLI_SECRET}`),
		{ mode: 0o600 },
	);
}

describe("M2 memory CLI handler", () => {
	it("returns typed not-initialized for pre-init scopes without creating the memory root", async () => {
		await withTempAgentDir(async agentDir => {
			const output = await captureOutput(() =>
				runMemoryCommand(command("scopes", undefined, { json: true }), dependenciesFor(agentDir)),
			);
			expect(output).toMatchObject({ exitCode: 3 });
			expect(JSON.parse(output.stdout)).toMatchObject({ code: "not-initialized", exitCode: 3 });
			expect(output.stderr).toContain("error: not-initialized");
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("redacts unexpected dependency errors from both output channels", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = await initializeFixture(agentDir);
			const output = await captureOutput(() =>
				runMemoryCommand(command("scopes", undefined, { json: true }), { ...deps, git: failingGit() }),
			);
			const leakedText = "/host/project/.git";
			const leakedSecret = "sk_live_123456789012";
			expect(output.exitCode).toBe(6);
			expect(JSON.parse(output.stdout)).toMatchObject({
				code: "policy-denied",
				exitCode: 6,
				reason: "memory command failed",
			});
			expect(output.stdout).not.toContain(leakedText);
			expect(output.stdout).not.toContain(leakedSecret);
			expect(output.stderr).not.toContain(leakedText);
			expect(output.stderr).not.toContain(leakedSecret);
		});
	});
	it("initializes without resolving inherited sessions or repository metadata", async () => {
		await withTempAgentDir(async agentDir => {
			const output = await captureOutput(() =>
				runMemoryCommand(command("init", undefined, { json: true }), {
					...dependenciesFor(agentDir),
					env: { GJC_SESSION_ID: "../malformed-session" },
					git: failingGit(),
				}),
			);
			expect(output).toMatchObject({ stderr: "", exitCode: 0 });
			expect(JSON.parse(output.stdout)).toMatchObject({ schemaVersion: "gajae.memory.init-receipt.v1" });
			expect((await fs.stat(path.join(agentDir, "memory"))).isDirectory()).toBe(true);
		});
	});

	it.each([
		"resolve",
		"get",
		"search",
		"recall",
	] as const)("returns not-initialized for pre-init %s without creating the memory root", async action => {
		await withTempAgentDir(async agentDir => {
			const value = action === "resolve" || action === "get" ? "global://missing.md" : "needle";
			const output = await captureOutput(() =>
				runMemoryCommand(command(action, value, { json: true }), dependenciesFor(agentDir)),
			);
			expect(output.exitCode).toBe(3);
			expect(JSON.parse(output.stdout)).toMatchObject({
				code: "not-initialized",
				exitCode: 3,
			});
			expect(output.stderr).toContain("error: not-initialized");
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("returns invalid-input for missing URI/query values before building an environment", async () => {
		await withTempAgentDir(async agentDir => {
			const output = await captureOutput(() =>
				runMemoryCommand(command("search", undefined, { json: true }), dependenciesFor(agentDir)),
			);
			expect(output.exitCode).toBe(2);
			expect(JSON.parse(output.stdout)).toMatchObject({ code: "invalid-input", exitCode: 2 });
			expect(output.stderr).toContain("error: invalid-input");
			expect(await fs.stat(path.join(agentDir, "memory")).catch(() => undefined)).toBeUndefined();
		});
	});

	it("renders initialized scopes, resolve, get, search, and recall in human and JSON modes", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = await initializeFixture(agentDir);
			const scopesHuman = await captureOutput(() => runMemoryCommand(command("scopes"), deps));
			const resolveHuman = await captureOutput(() =>
				runMemoryCommand(command("resolve", "global://fixture.md"), deps),
			);
			const getHuman = await captureOutput(() => runMemoryCommand(command("get", "global://fixture.md"), deps));
			const searchHuman = await captureOutput(() => runMemoryCommand(command("search", "needle"), deps));
			const recallHuman = await captureOutput(() => runMemoryCommand(command("recall", "needle"), deps));

			expect(scopesHuman).toMatchObject({ stderr: "", exitCode: 0 });
			expect(scopesHuman.stdout).toContain("global:");
			expect(resolveHuman).toMatchObject({ stderr: "", exitCode: 0 });
			expect(resolveHuman.stdout).toContain("uri: global://fixture.md");
			expect(getHuman).toMatchObject({ stderr: "", exitCode: 0 });
			expect(getHuman.stdout).toContain("deterministic needle");
			expect(searchHuman).toMatchObject({ stderr: "", exitCode: 0 });
			expect(searchHuman.stdout).toContain("query: needle");
			expect(recallHuman).toMatchObject({ stderr: "", exitCode: 0 });
			expect(recallHuman.stdout).toContain("query: needle");

			const scopesJson = await captureOutput(() =>
				runMemoryCommand(command("scopes", undefined, { json: true }), deps),
			);
			const resolveJson = await captureOutput(() =>
				runMemoryCommand(command("resolve", "global://fixture.md", { json: true }), deps),
			);
			const getJson = await captureOutput(() =>
				runMemoryCommand(command("get", "global://fixture.md", { json: true }), deps),
			);
			const searchJson = await captureOutput(() =>
				runMemoryCommand(command("search", "needle", { json: true, deterministic: true, asOf: AS_OF }), deps),
			);
			const recallJson = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { json: true, deterministic: true, asOf: AS_OF }), deps),
			);

			for (const output of [scopesJson, resolveJson, getJson, searchJson, recallJson]) {
				expect(output.stderr).toBe("");
				expect(output.exitCode).toBe(0);
			}
			expect(JSON.parse(scopesJson.stdout)).toMatchObject({ schemaVersion: "gajae.memory.scope-resolution.v1" });
			expect(JSON.parse(resolveJson.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.resource.v1",
				uri: "global://fixture.md",
			});
			expect(JSON.parse(getJson.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.resource.v1",
				content: expect.stringContaining("deterministic needle"),
			});
			expect(JSON.parse(searchJson.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.search-result.v1",
				query: "needle",
			});
			expect(JSON.parse(recallJson.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.recall.v1",
				query: "needle",
			});
		});
	});

	it("normalizes repeatable/comma scopes and threads deterministic inputs", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = await initializeFixture(agentDir);
			const first = await captureOutput(() =>
				runMemoryCommand(
					command("recall", "needle", {
						json: true,
						scopes: ["session,global", "global", "project"],
						intent: "generic-recall",
						deterministic: true,
						asOf: AS_OF,
						sessionId: "m2-cli-session",
					}),
					deps,
				),
			);
			const second = await captureOutput(() =>
				runMemoryCommand(
					command("recall", "needle", {
						json: true,
						scopes: ["global", "project", "session"],
						intent: "generic-recall",
						deterministic: true,
						asOf: AS_OF,
						sessionId: "m2-cli-session",
					}),
					deps,
				),
			);
			expect(first).toEqual(second);
			expect(JSON.parse(first.stdout)).toMatchObject({ intent: "generic-recall" });
		});
	});

	it("keeps typed failures on the error channel and rejects invalid scope/intent values", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = await initializeFixture(agentDir);
			const scopeError = await captureOutput(() =>
				runMemoryCommand(command("search", "needle", { json: true, scopes: ["global,wat"], asOf: AS_OF }), deps),
			);
			const intentError = await captureOutput(() =>
				runMemoryCommand(command("recall", "needle", { intent: "unknown", asOf: AS_OF }), deps),
			);
			expect(scopeError.exitCode).toBe(2);
			expect(scopeError.stderr).toContain("error: invalid-input");
			expect(JSON.parse(scopeError.stdout)).toMatchObject({ code: "invalid-input", exitCode: 2 });
			expect(intentError).toMatchObject({ stdout: "", exitCode: 2 });
			expect(intentError.stderr).toContain("error: invalid-input");
		});
	});

	it("returns a null ledger id for a no-session dependency invocation without creating a session directory", async () => {
		await withTempAgentDir(async agentDir => {
			const deps = dependenciesFor(agentDir);
			const init = await captureOutput(() => runMemoryCommand(command("init"), deps));
			expect(init).toMatchObject({ stderr: "", exitCode: 0 });
			await fs.writeFile(path.join(agentDir, "memory", "global", "fixture.md"), document(), { mode: 0o600 });

			const output = await captureOutput(() =>
				runMemoryCommand(command("search", "needle", { json: true, deterministic: true, asOf: AS_OF }), deps),
			);
			expect(output).toMatchObject({ stderr: "", exitCode: 0 });
			expect(JSON.parse(output.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.search-result.v1",
				ledgerId: null,
			});
			const sessions = await fs.readdir(path.join(agentDir, "memory", "sessions"), { withFileTypes: true });
			expect(sessions).toHaveLength(0);
		});
	});
});

describe("registered memory command", () => {
	it("parses the seven-action command surface and all M2 flags", async () => {
		const parsed = await new Memory(
			[
				"search",
				"needle",
				"--json",
				"--intent",
				"generic-recall",
				"--scope",
				"project,global",
				"--scope",
				"session",
				"--limit",
				"5",
				"--complete",
				"--deterministic",
				"--as-of",
				AS_OF,
				"--session-id",
				"m2-session",
			],
			CONFIG,
		).parse(Memory);
		expect(parsed.args).toEqual({ action: "search", value: "needle" });
		expect(parsed.flags).toMatchObject({
			json: true,
			intent: "generic-recall",
			scope: ["project,global", "session"],
			limit: 5,
			complete: true,
			deterministic: true,
			"as-of": AS_OF,
			"session-id": "m2-session",
		});
	});

	it("routes registered capabilities and missing values through real command handling", async () => {
		const capabilities = await captureOutput(() =>
			run({ bin: CONFIG.bin, version: CONFIG.version, argv: ["memory", "capabilities", "--json"], commands }),
		);
		expect(capabilities.exitCode).toBe(0);
		expect(capabilities.stderr).toBe("");
		expect(JSON.parse(capabilities.stdout)).toMatchObject({ milestone: "M6" });

		const missing = await captureOutput(() =>
			run({ bin: CONFIG.bin, version: CONFIG.version, argv: ["memory", "search", "--json"], commands }),
		);
		expect(missing.exitCode).toBe(2);
		expect(missing.stderr).toContain("error: invalid-input");
		expect(JSON.parse(missing.stdout)).toMatchObject({ code: "invalid-input", exitCode: 2 });
	});

	it.each([
		"search",
		"recall",
	] as const)("dispatches initialized %s with explicit session precedence and one metadata-only ledger line", async action => {
		await withRegisteredCliRoot(async agentDir => {
			await initializeRegisteredFixture(agentDir);
			const previousSessionId = process.env.GJC_SESSION_ID;
			process.env.GJC_SESSION_ID = "ambient-session";
			try {
				const output = await captureOutput(() =>
					run({
						bin: CONFIG.bin,
						version: CONFIG.version,
						argv: [
							"memory",
							action,
							"needle",
							"--json",
							"--deterministic",
							"--as-of",
							AS_OF,
							"--session-id",
							"explicit-session",
						],
						commands,
					}),
				);
				expect(output).toMatchObject({ stderr: "", exitCode: 0 });
				const payload = JSON.parse(output.stdout) as {
					readonly schemaVersion: unknown;
					readonly ledgerId: unknown;
				};
				expect(payload.schemaVersion).toBe(
					action === "search" ? "gajae.memory.search-result.v1" : "gajae.memory.recall.v1",
				);
				expect(payload.ledgerId).toEqual(expect.stringMatching(/^memledger_[0-9a-f]{64}$/));

				const ledgerPath = path.join(agentDir, "memory", "sessions", "explicit-session", "retrieval-ledger.jsonl");
				const ledgerText = await fs.readFile(ledgerPath, "utf8");
				const lines = ledgerText.trimEnd().split("\n");
				expect(lines).toHaveLength(1);
				const ledger = JSON.parse(lines[0]) as {
					readonly schemaVersion: unknown;
					readonly ledgerId: unknown;
				};
				expect(ledger.schemaVersion).toBe("gajae.memory.retrieval-ledger-entry.v1");
				expect(ledger.ledgerId).toBe(payload.ledgerId);
				expect(ledgerText).not.toContain("deterministic needle");
				expect(ledgerText).not.toContain(CLI_SECRET);
				expect(ledger).not.toHaveProperty("content");
				expect(
					await fs.stat(path.join(agentDir, "memory", "sessions", "ambient-session")).catch(() => undefined),
				).toBeUndefined();
			} finally {
				if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
				else process.env.GJC_SESSION_ID = previousSessionId;
			}
		});
	});

	it("dispatches initialized search without a session source without creating a session directory", async () => {
		await withRegisteredCliRoot(async agentDir => {
			await initializeRegisteredFixture(agentDir);
			const previousSessionId = process.env.GJC_SESSION_ID;
			delete process.env.GJC_SESSION_ID;
			try {
				const output = await captureOutput(() =>
					run({
						bin: CONFIG.bin,
						version: CONFIG.version,
						argv: ["memory", "search", "needle", "--json", "--deterministic", "--as-of", AS_OF],
						commands,
					}),
				);
				expect(output).toMatchObject({ stderr: "", exitCode: 0 });
				const payload = JSON.parse(output.stdout) as {
					readonly schemaVersion: unknown;
					readonly ledgerId: unknown;
				};
				expect(payload.schemaVersion).toBe("gajae.memory.search-result.v1");
				expect(payload.ledgerId).toBeNull();
				const sessions = await fs.readdir(path.join(agentDir, "memory", "sessions"), { withFileTypes: true });
				expect(sessions).toHaveLength(0);
			} finally {
				if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
				else process.env.GJC_SESSION_ID = previousSessionId;
			}
		});
	});
	it("reaches conflict-requires-confirmation through the registered recall CLI", async () => {
		await withRegisteredCliRoot(async agentDir => {
			await initializeRegisteredFixture(agentDir);
			// The shared fixture document intentionally carries a secret and is therefore
			// denied by the reader, so this test writes two clean competing documents that
			// collide on one claim key with every authority dimension tied.
			for (const [name, id, claim] of [
				["conflict-a.md", "m2-cli-conflict-a", "present"],
				["conflict-b.md", "m2-cli-conflict-b", "absent"],
			] as const) {
				await fs.writeFile(
					path.join(agentDir, "memory", "global", name),
					document()
						.replaceAll("m2-cli-fixture", id)
						.replace("deterministic needle is present", `deterministic needle is ${claim}`),
					{ mode: 0o600 },
				);
			}
			const output = await captureOutput(() =>
				run({
					bin: CONFIG.bin,
					version: CONFIG.version,
					argv: [
						"memory",
						"recall",
						"needle",
						"--require-resolved",
						"--json",
						"--deterministic",
						"--as-of",
						AS_OF,
					],
					commands,
				}),
			);
			expect(output.exitCode).toBe(7);
			expect(output.stderr).toContain("error: conflict-requires-confirmation");
			expect(JSON.parse(output.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "conflict-requires-confirmation",
				exitCode: 7,
				conflicts: expect.arrayContaining([expect.any(Object)]),
			});
		});
	});
});

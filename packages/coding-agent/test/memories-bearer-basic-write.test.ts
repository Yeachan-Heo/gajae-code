import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getMemoryRoot, startMemoryStartupTask } from "@gajae-code/coding-agent/memories";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/**
 * Phase-2 consolidation writes MEMORY.md and memory_summary.md through
 * startMemoryStartupTask. Bearer and Basic assignments have no vendor prefix,
 * so they used to land in those files verbatim.
 */

const ORDINARY = "Ran the github workflow twice; the second attempt passed.";
const PROSE = "Basic authentication is documented for the proxy. The bearer of this request is the caller.";
const BEARER = "Zm9vYmFyYmF6MTIzNDU2Nzg";
const BASIC = "dXNlcjpwYXNzd29yZA==";
const GITHUB = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

const createdDirs = new Set<string>();
let savedXdgData: string | undefined;
let savedXdgState: string | undefined;

beforeEach(() => {
	vi.restoreAllMocks();
	savedXdgData = process.env.XDG_DATA_HOME;
	savedXdgState = process.env.XDG_STATE_HOME;
	process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
	process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.env.XDG_DATA_HOME = savedXdgData;
	process.env.XDG_STATE_HOME = savedXdgState;
	for (const dir of createdDirs) {
		await fs.rm(dir, { recursive: true, force: true });
	}
	createdDirs.clear();
});

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(20);
	}
	throw lastError;
}

async function persistMemory(input: {
	rawMemory: string;
	memoryMd: string;
	memorySummary: string;
	skill: string;
}): Promise<{ memory: string; summary: string; raw: string; skill: string }> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-bearer-"));
	createdDirs.add(agentDir);
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);
	const threadId = "thread-bearer";
	const rollout = [
		{ type: "session", id: threadId, cwd: agentDir },
		{ type: "message", message: { role: "user", content: "summarize this rollout" } },
	];
	await fs.writeFile(
		path.join(sessionDir, `${threadId}.jsonl`),
		`${rollout.map(row => JSON.stringify(row)).join("\n")}\n`,
	);

	const settings = Settings.isolated({
		"memories.enabled": true,
		"memories.minRolloutIdleHours": 0,
		"memories.maxRolloutsPerStartup": 16,
		"memories.threadScanLimit": 64,
		"memories.phase2HeartbeatSeconds": 1,
	});
	const model = { provider: "openai", id: "test-model", name: "test-model", reasoning: false, contextWindow: 32_000 };
	const modelRegistry = {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
	};
	let calls = 0;
	vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
		calls += 1;
		const body =
			calls === 1
				? { rollout_summary: "Rollout summary", rollout_slug: threadId, raw_memory: input.rawMemory }
				: {
						memory_md: input.memoryMd,
						memory_summary: input.memorySummary,
						skills: [{ name: "deploy-playbook", content: input.skill }],
					};
		return createAssistantMessage(JSON.stringify(body));
	});

	startMemoryStartupTask({
		session: {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionDir: () => sessionDir,
				getSessionId: () => "current-thread",
				getCwd: () => agentDir,
			},
			settings,
			taskDepth: 0,
			model,
			modelRegistry,
			refreshBaseSystemPrompt: vi.fn(async () => undefined),
		} as never,
		settings,
		modelRegistry: modelRegistry as never,
		agentDir,
		taskDepth: 0,
	});

	const memoryRoot = getMemoryRoot(agentDir, agentDir);
	let memory = "";
	let summary = "";
	await waitFor(async () => {
		memory = await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8");
		summary = await fs.readFile(path.join(memoryRoot, "memory_summary.md"), "utf8");
		expect(memory.length).toBeGreaterThan(0);
		expect(summary.length).toBeGreaterThan(0);
	});
	const raw = await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8");
	const skill = await fs.readFile(path.join(memoryRoot, "skills", "deploy-playbook", "SKILL.md"), "utf8");
	return { memory, summary, raw, skill };
}

test("redacts bearer and basic-auth assignments in written memory", async () => {
	const secretLines = [
		`Authorization: Bearer ${BEARER}`,
		`Authorization: Basic ${BASIC}`,
		`note "Bearer ${BEARER}" done`,
		`cfg='Basic ${BASIC}'`,
		`kept ${GITHUB} alongside`,
	].join("\n");
	const written = await persistMemory({
		rawMemory: `${ORDINARY}\n${secretLines}`,
		memoryMd: `# Memory\n\n${ORDINARY}\n${secretLines}`,
		memorySummary: `${ORDINARY} Bearer ${BEARER} Basic ${BASIC}`,
		skill: `# Deploy\n${ORDINARY}\nAuthorization: Bearer ${BEARER}\nAuthorization: Basic ${BASIC}`,
	});

	for (const body of [written.memory, written.summary, written.raw, written.skill]) {
		expect(body).not.toContain(BEARER);
		expect(body).not.toContain(BASIC);
		expect(body).not.toContain(GITHUB);
		expect(body).toContain(ORDINARY);
	}
	expect(written.memory).toContain("Authorization: Bearer [REDACTED]");
	expect(written.memory).toContain("Authorization: Basic [REDACTED]");
	expect(written.skill).toContain("Authorization: Bearer [REDACTED]");
	expect(written.skill).toContain("Authorization: Basic [REDACTED]");
});

test("keeps an ordinary sentence in written memory", async () => {
	const body = `${ORDINARY}\n${PROSE}\nAuthorization: Basic authentication stays descriptive.`;
	const written = await persistMemory({
		rawMemory: body,
		memoryMd: `# Memory\n\n${body}`,
		memorySummary: body,
		skill: `# Deploy\n${body}\nBearer [REDACTED] stays`,
	});

	expect(written.memory).toBe(`# Memory\n\n${body}\n`);
	expect(written.summary).toBe(`${body}\n`);
	expect(written.raw).toContain(body);
	expect(written.skill).toContain(body);
	expect(written.skill).toContain("Bearer [REDACTED] stays");
	expect(written.memory).not.toContain("[REDACTED]");
	expect(written.summary).not.toContain("[REDACTED]");
	expect(written.raw).not.toContain("[REDACTED]");
});

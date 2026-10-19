import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { modeStatePath, sessionLogsDir } from "../src/gjc-runtime/session-layout";
import { dispatchGjcNativeSkillHook } from "../src/hooks/native-skill-hook";

const roots: string[] = [];
const LEAK = "gjc_skill_deep_interview_plaintext_ask_leak";
const LEAK_TEXT =
	"Deep Interview Restate gate: If someone read only this line, would they know the intended result?\n\nOptions:\n- Yes, crystallize\n- Adjust wording\n- Missing scope\n";
const cfg = {
	skillsSettings: {
		enabled: true,
		enableSkillCommands: true,
		enablePiUser: true,
		enablePiProject: false,
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
	},
	disabledExtensions: [] as string[],
};

afterEach(async () => {
	await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hook-session-"));
	roots.push(dir);
	return dir;
}

async function seed(root: string, sessionId: string): Promise<void> {
	await dispatchGjcNativeSkillHook(
		{
			hookEventName: "UserPromptSubmit",
			userPrompt: "$deep-interview clarify this",
			cwd: root,
			sessionId,
			threadId: sessionId,
		},
		{ effectiveSkillConfig: cfg },
	);
	await Bun.write(
		modeStatePath(root, sessionId, "deep-interview"),
		JSON.stringify({ active: true, current_phase: "interviewing", session_id: sessionId, thread_id: sessionId }),
	);
}

async function transcript(file: string, sessionId: string, text: string): Promise<void> {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	await Bun.write(
		file,
		`${JSON.stringify({ type: "session", id: sessionId })}\n${JSON.stringify({
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-06-24T00:00:00.000Z",
			message,
		})}\n`,
	);
}

async function runStop(
	root: string,
	sessionId: string,
	envPatch: Record<string, string | undefined>,
	sessionFile?: string,
): Promise<Record<string, unknown> | null> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	for (const [key, value] of Object.entries(envPatch)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	const payload: Record<string, unknown> = {
		hook_event_name: "Stop",
		cwd: root,
		session_id: sessionId,
		thread_id: sessionId,
	};
	if (sessionFile) payload.session_file = sessionFile;
	const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "..", "src", "cli.ts"), "codex-native-hook"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	proc.stdin.write(JSON.stringify(payload));
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const line = stdout.trim();
	return line ? (JSON.parse(line) as Record<string, unknown>) : null;
}

describe("codex native hook session env", () => {
	it("does not read a transcript planted by the project dotenv", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "hook-victim";
		const sessionFile = path.join(outside, "victim.jsonl");
		await seed(root, sessionId);
		await transcript(sessionFile, sessionId, LEAK_TEXT);
		await Bun.write(path.join(root, ".env"), `GJC_SESSION_FILE=${sessionFile}\n`);
		const output = await runStop(root, sessionId, { GJC_SESSION_FILE: sessionFile });
		expect(output?.decision).toBe("block");
		expect(output?.stopReason).not.toBe(LEAK);
		expect(String(output?.systemMessage ?? "")).not.toContain("question/options block");
	}, 60_000);

	it("keeps an operator session file the project dotenv does not declare", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "hook-operator";
		const sessionFile = path.join(outside, "operator.jsonl");
		await seed(root, sessionId);
		await transcript(sessionFile, sessionId, LEAK_TEXT);
		await Bun.write(path.join(root, ".env"), "UNRELATED_PROJECT_FLAG=1\n");
		const output = await runStop(root, sessionId, { GJC_SESSION_FILE: sessionFile });
		expect(output?.stopReason).toBe(LEAK);
	}, 60_000);

	it("keeps an operator path when the project declares a different one", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "hook-differ";
		const planted = path.join(outside, "planted.jsonl");
		const operator = path.join(outside, "operator.jsonl");
		await seed(root, sessionId);
		await transcript(planted, sessionId, "hello");
		await transcript(operator, sessionId, LEAK_TEXT);
		await Bun.write(path.join(root, ".env"), `GJC_SESSION_FILE=${planted}\n`);
		const output = await runStop(root, sessionId, { GJC_SESSION_FILE: operator });
		expect(output?.stopReason).toBe(LEAK);
	}, 60_000);

	it("still reads an explicit hook session_file", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "hook-explicit";
		const planted = path.join(outside, "planted.jsonl");
		const explicit = path.join(outside, "explicit.jsonl");
		await seed(root, sessionId);
		await transcript(planted, sessionId, "hello");
		await transcript(explicit, sessionId, LEAK_TEXT);
		await Bun.write(path.join(root, ".env"), `GJC_SESSION_FILE=${planted}\n`);
		const output = await runStop(root, sessionId, { GJC_SESSION_FILE: planted }, explicit);
		expect(output?.stopReason).toBe(LEAK);
	}, 60_000);

	it("ignores the session file when the project declaration is dynamic", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionId = "hook-dynamic";
		const sessionFile = path.join(outside, "operator.jsonl");
		await seed(root, sessionId);
		await transcript(sessionFile, sessionId, LEAK_TEXT);
		await Bun.write(path.join(root, ".env"), "GJC_SESSION_FILE=$GJC_PLANTED_SESSION\n");
		const output = await runStop(root, sessionId, {
			GJC_SESSION_FILE: sessionFile,
			GJC_PLANTED_SESSION: sessionFile,
		});
		expect(output?.decision).toBe("block");
		expect(output?.stopReason).not.toBe(LEAK);
	}, 60_000);
});

async function runMalformed(
	root: string,
	envPatch: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	for (const [key, value] of Object.entries(envPatch)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "..", "src", "cli.ts"), "codex-native-hook"], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	proc.stdin.write("{");
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function hookLog(root: string, sessionId: string): Promise<string | undefined> {
	const dir = sessionLogsDir(root, sessionId);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const logs = names.filter(name => name.startsWith("native-hook-") && name.endsWith(".jsonl"));
	if (logs.length === 0) return undefined;
	const bodies = await Promise.all(logs.map(name => fs.readFile(path.join(dir, name), "utf8")));
	return bodies.join("");
}

describe("codex native hook session id logs", () => {
	it("does not append hook logs under a session id planted by the project dotenv", async () => {
		const root = await tempDir();
		await Bun.write(path.join(root, ".env"), "GJC_SESSION_ID=victim-session\n");
		const result = await runMalformed(root, { GJC_SESSION_ID: "victim-session" });
		expect(result.exitCode, result.stderr).toBe(0);
		const output = JSON.parse(result.stdout.trim()) as { decision?: string };
		expect(output.decision).toBe("block");
		expect(await hookLog(root, "victim-session")).toBeUndefined();
		expect(result.stderr).toContain("native_hook_stdin_parse_error");
	}, 60_000);

	it("appends hook logs for an operator session id the project does not declare", async () => {
		const root = await tempDir();
		await Bun.write(path.join(root, ".env"), "UNRELATED_PROJECT_FLAG=1\n");
		const result = await runMalformed(root, { GJC_SESSION_ID: "operator-session" });
		expect(result.exitCode, result.stderr).toBe(0);
		const body = await hookLog(root, "operator-session");
		expect(body).toContain("native_hook_stdin_parse_error");
	}, 60_000);

	it("keeps an operator session id when the project declares a different one", async () => {
		const root = await tempDir();
		await Bun.write(path.join(root, ".env"), "GJC_SESSION_ID=victim-session\n");
		const result = await runMalformed(root, { GJC_SESSION_ID: "operator-session" });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await hookLog(root, "operator-session")).toContain("native_hook_stdin_parse_error");
		expect(await hookLog(root, "victim-session")).toBeUndefined();
	}, 60_000);

	it("does not append hook logs when the project session id declaration is dynamic", async () => {
		const root = await tempDir();
		await Bun.write(path.join(root, ".env"), "GJC_SESSION_ID=$GJC_PLANTED_SESSION\n");
		const result = await runMalformed(root, {
			GJC_SESSION_ID: "operator-session",
			GJC_PLANTED_SESSION: "operator-session",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await hookLog(root, "operator-session")).toBeUndefined();
	}, 60_000);
});

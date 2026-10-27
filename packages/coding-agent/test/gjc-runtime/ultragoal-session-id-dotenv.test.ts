import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GJC_SESSION_FILE_ENV, GJC_SESSION_ID_ENV } from "@gajae-code/coding-agent/gjc-runtime/goal-mode-request";
import { sessionStateDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-session-id-dotenv-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTranscript(sessionFile: string, cwd: string): Promise<void> {
	const timestamp = new Date().toISOString();
	await Bun.write(
		sessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd }),
			JSON.stringify({
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "start ultragoal" }] },
			}),
			"",
		].join("\n"),
	);
}

function runCreateGoals(cwd: string, sessionFile: string, sessionId: string) {
	const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
	return Bun.spawnSync(["bun", cliPath, "ultragoal", "create-goals", "--brief", "Ship native goal"], {
		cwd,
		env: {
			...process.env,
			[GJC_SESSION_FILE_ENV]: sessionFile,
			[GJC_SESSION_ID_ENV]: sessionId,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function requestPath(cwd: string, sessionId: string): string {
	return path.join(sessionStateDir(cwd, sessionId), "goal-mode-request.json");
}

async function requestSessionId(cwd: string, sessionId: string): Promise<string | undefined> {
	const file = Bun.file(requestPath(cwd, sessionId));
	if (!(await file.exists())) return undefined;
	const body = (await file.json()) as { sessionId?: unknown };
	return typeof body.sessionId === "string" ? body.sessionId : undefined;
}

describe("ultragoal session id dotenv provenance", () => {
	it("does not point goal-mode at a session id planted by the project dotenv", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "operator-session.jsonl");
		await writeTranscript(sessionFile, root);
		await Bun.write(path.join(root, ".env"), `${GJC_SESSION_ID_ENV}=victim-session\n`);

		const result = runCreateGoals(root, sessionFile, "victim-session");

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await Bun.file(requestPath(root, "victim-session")).exists()).toBe(false);
	}, 30_000);

	it("writes the goal-mode request for an operator session id the project does not declare", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "operator-session.jsonl");
		await writeTranscript(sessionFile, root);
		await Bun.write(path.join(root, ".env"), "UNRELATED_PROJECT_FLAG=1\n");

		const result = runCreateGoals(root, sessionFile, "session-owner");

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await requestSessionId(root, "session-owner")).toBe("session-owner");
	}, 30_000);

	it("keeps an operator session id when the project dotenv declares a different id", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "operator-session.jsonl");
		await writeTranscript(sessionFile, root);
		await Bun.write(path.join(root, ".env"), `${GJC_SESSION_ID_ENV}=victim-session\n`);

		const result = runCreateGoals(root, sessionFile, "session-owner");

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await requestSessionId(root, "session-owner")).toBe("session-owner");
		expect(await Bun.file(requestPath(root, "victim-session")).exists()).toBe(false);
	}, 30_000);

	it("does not use an operator session id when the project declaration is dynamic", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "operator-session.jsonl");
		await writeTranscript(sessionFile, root);
		await Bun.write(path.join(root, ".env"), `${GJC_SESSION_ID_ENV}=$GJC_PLANTED_SESSION\n`);

		const result = runCreateGoals(root, sessionFile, "session-owner");

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await Bun.file(requestPath(root, "session-owner")).exists()).toBe(false);
	}, 30_000);
});

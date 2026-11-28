import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Args as ParsedArgs } from "../src/cli/args";
import { runSessionHost } from "../src/commands/sdk";
import { deriveLifecycleDeadlines, type SessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";
import type { CreateLifecycleAgentSessionOptions } from "../src/sdk/lifecycle-session";
import type { SessionManager } from "../src/session/session-manager";

const HOST_ENV = ["GJC_AGENT_DIR", "GJC_STATE_ROOT", "GJC_LIFECYCLE_REQUEST_ID", "GJC_SDK_LIFECYCLE_REQUEST"] as const;
const previousEnv = new Map<string, string | undefined>(HOST_ENV.map(name => [name, process.env[name]]));
const tempDirs: string[] = [];

afterEach(async () => {
	for (const [name, value] of previousEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** Runs the lifecycle host until session construction and returns the options it was given. */
async function captureLifecycleOptions(appendFile: string | undefined): Promise<CreateLifecycleAgentSessionOptions> {
	const cwd = await mkdtemp(path.join(tmpdir(), "gjc-lifecycle-append-"));
	tempDirs.push(cwd);
	const agentDir = path.join(cwd, "agent");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessionId = "append-prompt";
	const effectMarker = "append-prompt-marker";
	await mkdir(path.join(stateRoot, "sdk"), { recursive: true, mode: 0o700 });
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
	);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.create",
		sessionId,
		cwd,
		stateRoot,
		effectMarker,
		...deriveLifecycleDeadlines(1_000, 60_000),
	};
	process.env.GJC_AGENT_DIR = agentDir;
	process.env.GJC_STATE_ROOT = stateRoot;
	process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
	process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify(request);

	let captured: CreateLifecycleAgentSessionOptions | undefined;
	const stop = new Error("stop after construction options");
	const sessionManager = {
		getSessionId: () => sessionId,
		getSessionFile: () => undefined,
		close: async () => {},
	} as unknown as SessionManager;
	await runSessionHost({
		cwd,
		now: () => 1_000,
		processIncarnation: () => "test-incarnation",
		initTheme: async () => {},
		openLifecycleSessionManager: async () => ({
			parsed: { messages: [], fileArgs: [], unknownFlags: new Map() } as ParsedArgs,
			sessionManager,
		}),
		discoverAppendSystemPromptFile: () => appendFile,
		createLifecycleAgentSession: async options => {
			captured = options;
			throw stop;
		},
	}).catch(() => {});
	if (!captured) throw new Error("lifecycle host did not reach session construction");
	return captured;
}

test("lifecycle session prompt ends with the user append system prompt file", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "gjc-append-file-"));
	tempDirs.push(dir);
	const appendFile = path.join(dir, "APPEND_SYSTEM.md");
	await writeFile(appendFile, "Address the user as Captain.");

	const options = await captureLifecycleOptions(appendFile);

	expect(typeof options.systemPrompt).toBe("function");
	const build = options.systemPrompt as (defaultPrompt: string[]) => string[];
	expect(build(["base prompt", "context"])).toEqual(["base prompt", "context", "Address the user as Captain."]);
});

test("lifecycle session never appends the pathname of an append file it cannot read as a regular file", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "gjc-append-dir-"));
	tempDirs.push(dir);
	const notAFile = path.join(dir, "APPEND_SYSTEM.md");
	await mkdir(notAFile);

	const unreadable = await captureLifecycleOptions(notAFile);
	const vanished = await captureLifecycleOptions(path.join(dir, "gone", "APPEND_SYSTEM.md"));

	expect(unreadable.systemPrompt).toBeUndefined();
	expect(vanished.systemPrompt).toBeUndefined();
});

test("lifecycle session keeps the default prompt when no append file exists", async () => {
	const options = await captureLifecycleOptions(undefined);

	expect(options.systemPrompt).toBeUndefined();
});

import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	type DesktopSnapshot,
	parseRequest,
} from "../src/protocol";

let environment: NodeJS.ProcessEnv;
let agentDir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	environment = { ...process.env };
	agentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(agentDir);
	}
});

async function launch() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-failure-"));
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const frames: DesktopFrame[] = [];
	const captures: CreateAgentSessionOptions[] = [];
	const results: CreateAgentSessionResult[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: async options => {
			captures.push(options);
			const result = await createAgentSession(options);
			results.push(result);
			return result;
		},
	});
	cleanups.push(async () => {
		await host.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (!response || response.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const reject = async (method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<string> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (!response || response.type !== "response" || response.ok) throw new Error("Expected a rejected request");
		return response.error;
	};
	const open = async () => {
		const projectPath = path.join(directory, "project");
		await fs.mkdir(projectPath, { recursive: true });
		const project = await call<DesktopProject>("project.open", { path: projectPath });
		return call<DesktopSession>("session.create", { projectId: project.id });
	};
	const session = async (sessionId: string) => {
		const snapshot = await call<DesktopSnapshot>("bootstrap");
		return snapshot.sessions.find(item => item.id === sessionId);
	};
	return { call, reject, open, session, results };
}

// A refused administrative operation is an operation error, not a failed
// conversation: the transcript and the session status must stay untouched.
test("a refused non-turn operation leaves the conversation idle", async () => {
	const { reject, open, session } = await launch();
	const created = await open();
	expect(created.status).toBe("idle");

	expect(await reject("session.rename", { sessionId: created.id, title: "   " })).toContain("Invalid title");

	const after = await session(created.id);
	expect(after?.status).toBe("idle");
	expect(after?.error).toBeUndefined();
	expect(after?.title).toBe(created.title);
});

// The complement: a rejected turn really did run, so it stays visible on the
// conversation even though the same text also answers the prompt request.
test("a rejected turn marks the conversation failed", async () => {
	const { reject, open, session, results } = await launch();
	const created = await open();
	vi.spyOn(results[0]!.session, "prompt").mockRejectedValue(new Error("provider unavailable"));

	expect(await reject("prompt", { sessionId: created.id, text: "hello" })).toContain("provider unavailable");

	const after = await session(created.id);
	expect(after?.status).toBe("error");
	expect(after?.error).toContain("provider unavailable");
});

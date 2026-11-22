import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";
import { parseRequest } from "../src/protocol";
import { TOOL_DETAIL_UNAVAILABLE } from "../src/tool-projection";

describe("desktop tool methods on a live session", () => {
	let environment: NodeJS.ProcessEnv;
	let agentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	const spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		environment = { ...process.env };
		agentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		spies.push(vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined));
	});
	afterEach(async () => {
		try {
			for (const cleanup of cleanups.splice(0)) await cleanup();
		} finally {
			for (const spy of spies.splice(0)) spy.mockRestore();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(agentDir);
		}
	});

	async function fixture() {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-tools-")));
		const dataDir = path.join(directory, "app");
		const projectDir = path.join(directory, "project");
		await fs.mkdir(projectDir);
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const frames: DesktopFrame[] = [];
		const sessions: CreateAgentSessionResult[] = [];
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const result = await createAgentSession(options);
				sessions.push(result);
				return result;
			},
		});
		cleanups.push(async () => {
			await host.close();
			await Promise.all(sessions.map(result => result.session.awaitDisposeCompletion()));
			await fs.rm(directory, { recursive: true, force: true });
		});
		const respond = async (method: DesktopRequest["method"], params: Record<string, unknown>) => {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing response");
			return response;
		};
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}) => {
			const response = await respond(method, params);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return { call, respond, session, sdk: sessions[0]!.session };
	}

	test("tools.list returns the session's SDK tool names", async () => {
		const h = await fixture();
		const result = await h.call<{ available: string[]; active: string[] }>("tools.list", {
			sessionId: h.session.id,
		});
		expect(result).toEqual({ available: h.sdk.getAllToolNames(), active: h.sdk.getActiveToolNames() });
		expect(result.active.length).toBeGreaterThan(0);
	}, 30_000);

	test("tool.detail is admitted for a live session and fails closed without data", async () => {
		const h = await fixture();
		const response = await h.respond("tool.detail", { sessionId: h.session.id, callId: "toolu_unknown" });
		expect(response).toMatchObject({ ok: false, error: TOOL_DETAIL_UNAVAILABLE });
		expect("result" in response).toBe(false);
		expect(await h.respond("tool.detail", { sessionId: h.session.id })).toMatchObject({
			ok: false,
			error: "Invalid callId",
		});
	}, 30_000);
});

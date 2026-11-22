/** Running tool rows through a real Host, `AgentSession` and agent loop with a controllable tool. */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopMessage,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	parseRequest,
} from "../src/protocol";

const CALL_ID = "toolu_live_1";

/** A `read` tool that reports partial output, then parks until released or aborted. */
function parkedRead() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Parks until the test releases it",
		parameters: z.object({ path: z.string() }),
		execute: async (_id, _args, signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "partial output" }] });
			entered.resolve();
			const aborted = Promise.withResolvers<never>();
			signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
			await Promise.race([release.promise, aborted.promise]);
			return { content: [{ type: "text", text: "file body" }] };
		},
	};
	return { tool, entered: entered.promise, release: () => release.resolve() };
}

describe("desktop live tool rows", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		delete process.env.GJC_CODING_AGENT_DIR;
	});
	afterEach(async () => {
		try {
			while (cleanups.length > 0) await cleanups.pop()?.();
		} finally {
			vi.restoreAllMocks();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
	});

	async function launch() {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-tools-live-"));
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-tools-project-"));
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		await Bun.write(
			path.join(projectDir, ".gjc", "config.yml"),
			"compaction:\n  enabled: false\nretry:\n  enabled: false\n",
		);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		const read = parkedRead();
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: CALL_ID, name: "read", arguments: { path: "src/app.ts" } }] },
				{ content: ["finished"] },
			],
		});
		const frames: DesktopFrame[] = [];
		const waiters: Array<{ test(session: DesktopSession): boolean; resolve(session: DesktopSession): void }> = [];
		const host = new DesktopHost({
			dataDir,
			emit: frame => {
				frames.push(frame);
				if (frame.type !== "session") return;
				for (const waiter of waiters.splice(0))
					if (waiter.test(frame.session)) waiter.resolve(frame.session);
					else waiters.push(waiter);
			},
			createSession: async options => {
				if (!options.sessionManager || !options.settings || !options.modelRegistry || !options.authStorage)
					throw new Error("Host must supply genuine session-scoped SDK services");
				options.authStorage.setRuntimeApiKey(mock.model.provider, "local-only");
				options.settings.override("compaction.enabled", false);
				options.settings.override("retry.enabled", false);
				const agent = new Agent({
					initialState: { model: mock.model, systemPrompt: ["test"], tools: [read.tool], messages: [] },
					getApiKey: () => "local-only",
					streamFn: mock.stream,
				});
				const session = new AgentSession({
					agent,
					sessionManager: options.sessionManager,
					settings: options.settings,
					modelRegistry: options.modelRegistry,
					agentDir: options.agentDir,
					workflowGatePublication: "local",
				});
				const eventBus = new EventBus();
				session.registerToolSessionCleanup(() => eventBus.clear());
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: undefined as never },
					eventBus,
					setToolUIContext: () => {},
				} satisfies CreateAgentSessionResult;
			},
		});
		cleanups.push(async () => {
			try {
				await host.close();
			} finally {
				await fs.rm(dataDir, { recursive: true, force: true });
				await fs.rm(projectDir, { recursive: true, force: true });
			}
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.findLast(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error(`No response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		/** The next published session frame that satisfies `test`. */
		const published = (test: (session: DesktopSession) => boolean) => {
			const next = Promise.withResolvers<DesktopSession>();
			waiters.push({ test, resolve: next.resolve });
			return next.promise;
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		return { call, published, session, read };
	}

	const rowsFor = (session: DesktopSession): DesktopMessage[] =>
		session.messages.filter(message => message.tool?.callId === CALL_ID);

	test("one call id is a running row while it executes and a single settled row after", async () => {
		const h = await launch();
		const running = h.published(session => rowsFor(session)[0]?.tool?.status === "running");
		const prompt = h.call("prompt", { sessionId: h.session.id, text: "read it" });
		await h.read.entered;
		const live = await running;
		expect(rowsFor(live)).toEqual([
			{
				id: `call:${CALL_ID}`,
				role: "tool",
				toolName: "read",
				text: "partial output",
				tool: { callId: CALL_ID, status: "running", family: "read", subject: "src/app.ts", detail: true },
			},
		]);
		expect(live.status).toBe("running");

		const settled = h.published(session => session.status === "done" && rowsFor(session)[0]?.tool?.status === "done");
		h.read.release();
		await prompt;
		const done = await settled;
		const rows = rowsFor(done);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id.startsWith("call:")).toBe(false);
		expect(rows[0]).toMatchObject({
			role: "tool",
			text: "file body",
			tool: { status: "done", subject: "src/app.ts" },
		});
		expect(done.messages.some(message => message.id.startsWith("call:"))).toBe(false);
	}, 30_000);

	test("a call stopped while it runs settles as cancelled, never as running", async () => {
		const h = await launch();
		const running = h.published(session => rowsFor(session)[0]?.tool?.status === "running");
		const prompt = h.call("prompt", { sessionId: h.session.id, text: "read it" });
		await h.read.entered;
		await running;
		const settled = h.published(session => session.status !== "running" && rowsFor(session).length > 0);
		await h.call("abort", { sessionId: h.session.id });
		await prompt.catch(() => {});
		const stopped = await settled;
		expect(rowsFor(stopped).map(message => [message.id.startsWith("call:"), message.tool?.status])).toEqual([
			[false, "cancelled"],
		]);
	}, 30_000);
});

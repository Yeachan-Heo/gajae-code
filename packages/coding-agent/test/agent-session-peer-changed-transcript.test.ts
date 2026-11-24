import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";

type Script = "text" | "tool";

interface Harness {
	session: AgentSession;
	writerA: SessionManager;
	file: string;
	/** Second writer: a separate manager opened on the same managed transcript. */
	appendFromB(text: string): Promise<void>;
	setScript(script: Script): void;
	counts(): { modelCalls: number; toolRuns: number };
	onToolRun(hook: (() => Promise<void>) | undefined): void;
}

function describeMessage(role: string, content: unknown): string {
	if (typeof content === "string") return `${role}:${content}`;
	const first = (Array.isArray(content) ? content[0] : undefined) as
		| { type?: string; text?: string; name?: string }
		| undefined;
	return `${role}:${first?.type === "toolCall" ? `tool:${first.name}` : (first?.text ?? "")}`;
}

function transcriptMessages(text: string): string[] {
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.flatMap(line => {
			const entry = JSON.parse(line) as { type: string; message?: { role: string; content: unknown } };
			return entry.type === "message" && entry.message
				? [describeMessage(entry.message.role, entry.message.content)]
				: [];
		});
}

async function settle<T>(promise: Promise<T>): Promise<unknown> {
	return await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("AgentSession on a transcript another process changed", () => {
	let tempDir: TempDir | undefined;
	const cleanups: Array<() => Promise<unknown> | unknown> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function setup(): Promise<Harness> {
		tempDir = TempDir.createSync("@gjc-stuck-refusal-");
		const root = tempDir.path();
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		cleanups.push(() => auth.close());
		auth.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let script: Script = "text";
		let modelCalls = 0;
		let toolRuns = 0;
		let toolHook: (() => Promise<void>) | undefined;
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: () =>
				script === "tool"
					? { content: [{ type: "toolCall", name: "probe", arguments: {} }] }
					: { content: [`reply ${modelCalls}`] },
		});
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				script = "text";
				await toolHook?.();
				return { content: [{ type: "text", text: "tool ok" }] };
			},
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (...args) => {
				modelCalls++;
				return mock.stream(...args);
			},
			getApiKey: () => "test-key",
		});
		const destination = () => SessionManager.managedDestination(root, path.join(root, "agent"));
		const writerA = SessionManager.create(root, destination());
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: writerA,
			settings,
			modelRegistry: new ModelRegistry(auth),
		});
		cleanups.push(() => session.dispose());
		await session.prompt("first");
		await writerA.flush();
		const file = writerA.getSessionFile();
		if (!file) throw new Error("Expected a persisted transcript");
		return {
			session,
			writerA,
			file,
			appendFromB: async text => {
				const writerB = await SessionManager.open(file, destination());
				cleanups.push(() => writerB.close());
				writerB.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				await writerB.flush();
			},
			setScript: next => {
				script = next;
			},
			counts: () => ({ modelCalls, toolRuns }),
			onToolRun: hook => {
				toolHook = hook;
			},
		};
	}

	/** B appends, then A's next prompt hits the append fence and latches it. */
	async function latch(harness: Harness): Promise<ManagedAppendIdentityMismatchError> {
		await harness.appendFromB("from B");
		expect(await settle(harness.session.prompt("latches"))).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		const latched = harness.writerA.getAppendIdentityMismatch();
		if (!latched) throw new Error("Expected the append fence to latch");
		return latched;
	}

	it("recovers after /resume of the same session and keeps both writers' entries", async () => {
		const harness = await setup();
		await latch(harness);

		expect(await harness.session.switchSession(harness.file)).toBe(true);
		expect(harness.session.sessionManager.getAppendIdentityMismatch()).toBeUndefined();
		const callsBefore = harness.counts().modelCalls;
		await harness.session.prompt("after resume");

		expect(harness.counts().modelCalls).toBe(callsBefore + 1);
		const transcript = transcriptMessages(await Bun.file(harness.file).text());
		expect(transcript.slice(0, 3)).toEqual(["user:first", "assistant:reply 1", "user:from B"]);
		expect(transcript).toContain("user:after resume");
		expect(transcript).not.toContain("user:latches");
	});

	it("recovers through /fork into a new session without touching the changed transcript", async () => {
		const harness = await setup();
		await latch(harness);
		const peerTranscript = await Bun.file(harness.file).text();
		const assistantReply = harness.writerA
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		const firstUser = harness.writerA
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!assistantReply || !firstUser) throw new Error("Expected the first exchange");

		const forked = await harness.session.branch(firstUser.id);
		expect(forked.cancelled).toBe(false);
		const forkFile = harness.session.sessionManager.getSessionFile();
		if (!forkFile) throw new Error("Expected a fork transcript");
		expect(forkFile).not.toBe(harness.file);
		await harness.session.prompt("after fork");

		expect(await Bun.file(harness.file).text()).toBe(peerTranscript);
		expect(transcriptMessages(await Bun.file(forkFile).text())).toContain("user:after fork");
	});

	it("recovers through /new without touching the changed transcript", async () => {
		const harness = await setup();
		await latch(harness);
		const peerTranscript = await Bun.file(harness.file).text();

		expect(await harness.session.newSession()).toBe(true);
		await harness.session.prompt("after new");

		const newFile = harness.session.sessionManager.getSessionFile();
		if (!newFile) throw new Error("Expected a new transcript");
		expect(newFile).not.toBe(harness.file);
		expect(transcriptMessages(await Bun.file(newFile).text())).toContain("user:after new");
		expect(await Bun.file(harness.file).text()).toBe(peerTranscript);
	});

	it("leaves a single writer's prompts, tool turns, /new and /resume unchanged", async () => {
		const harness = await setup();
		await harness.session.prompt("second");
		harness.setScript("tool");
		await harness.session.prompt("third");

		expect(harness.counts()).toEqual({ modelCalls: 4, toolRuns: 1 });
		expect(transcriptMessages(await Bun.file(harness.file).text())).toEqual([
			"user:first",
			"assistant:reply 1",
			"user:second",
			"assistant:reply 2",
			"user:third",
			"assistant:tool:probe",
			"toolResult:tool ok",
			"assistant:reply 4",
		]);
		expect(await harness.session.newSession()).toBe(true);
		expect(await harness.session.switchSession(harness.file)).toBe(true);
		await harness.session.prompt("after resume");
		expect(transcriptMessages(await Bun.file(harness.file).text()).slice(-2)).toEqual([
			"user:after resume",
			"assistant:reply 5",
		]);
	});
});

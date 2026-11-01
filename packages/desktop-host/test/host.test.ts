import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai/core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { isolateEnvironment } from "../src/environment-policy";
import {
	DesktopHost,
	desktopSettings,
	requiredString,
	validateDesktopSetting,
	validateQuestionAnswer,
} from "../src/host";
import { projectHistoryPage, projectMessages } from "../src/message-projection";
import type {
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopProject,
	DesktopQuestion,
	DesktopRequest,
	DesktopSession,
	DesktopSnapshot,
} from "../src/protocol";
import { MAX_FRAME_BYTES, parseRequest } from "../src/protocol";
import type { ProtocolHost } from "../src/transport";
import { serveProtocol } from "../src/transport";

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const request = (id: string, method: DesktopRequest["method"]): DesktopRequest => ({ id, method, params: {} });

describe("desktop protocol validation", () => {
	test("keeps OS launch essentials without inherited provider credentials or routing", () => {
		const environment: Record<string, string | undefined> = {
			PATH: "/usr/bin",
			LANG: "ko_KR.UTF-8",
			LC_ALL: "ko_KR.UTF-8",
			GJC_DESKTOP_DATA_DIR: "/tmp/app",
			GH_TOKEN: "github-secret",
			HF_TOKEN: "hf-secret",
			AWS_BEARER_TOKEN_KIRO: "kiro-secret",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_OAUTH_TOKEN: "oauth-secret",
			OPENAI_BASE_URL: "https://inherited.example",
			HTTPS_PROXY: "http://inherited.example",
			GJC_AUTH_BROKER_URL: "http://localhost:1234",
			GJC_AUTH_BROKER_TOKEN: "broker-secret",
			GJC_CONFIG_DIR: "/user/cli-config",
			AWS_SHARED_CREDENTIALS_FILE: "/user/credentials",
		};
		isolateEnvironment(environment);
		expect(environment).toEqual({
			PATH: "/usr/bin",
			LANG: "ko_KR.UTF-8",
			LC_ALL: "ko_KR.UTF-8",
			GJC_DESKTOP_DATA_DIR: "/tmp/app",
		});
	});
	test("question ownership and value validation preserve cancellation semantics", () => {
		const sessionId = "00000000-0000-4000-8000-000000000001";
		const question: DesktopQuestion = {
			id: "00000000-0000-4000-8000-000000000002",
			sessionId,
			kind: "select",
			title: "Choose",
			options: ["one", "two"],
		};
		expect(validateQuestionAnswer(question, { sessionId, value: "two" })).toBe("two");
		expect(validateQuestionAnswer(question, { sessionId, value: null })).toBeNull();
		expect(() =>
			validateQuestionAnswer(question, { sessionId: "00000000-0000-4000-8000-000000000003", value: "one" }),
		).toThrow("Question does not belong to session");
		expect(() => validateQuestionAnswer(question, { sessionId, value: "three" })).toThrow("Invalid question option");
		expect(() => validateQuestionAnswer({ ...question, kind: "confirm" }, { sessionId, value: "true" })).toThrow(
			"Invalid question answer",
		);
		expect(validateQuestionAnswer({ ...question, kind: "confirm" }, { sessionId, value: false })).toBe(false);
	});
	test("rejects malformed envelopes, arrays and oversized requests", () => {
		for (const input of [
			"null",
			"[]",
			"{",
			JSON.stringify({ id: 7, method: "bootstrap", params: {} }),
			JSON.stringify({ id: "x", method: "bootstrap", params: [] }),
		]) {
			expect(() => parseRequest(input)).toThrow();
		}
		expect(() => parseRequest(" ".repeat(MAX_FRAME_BYTES + 1))).toThrow("Request exceeds frame limit");
	});
	test("rejects empty, null-byte and overlong command values", () => {
		for (const value of [null, true, "", "  ", "a\0b", "12345"])
			expect(() => requiredString({ text: value }, "text", 4)).toThrow("Invalid text");
		expect(requiredString({ text: "test" }, "text", 4)).toBe("test");
	});
	test("projects thinking and visible text without credentials or tool arguments", () => {
		const messages = projectMessages([
			{ role: "system", content: "private instructions" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "secret" },
					{ type: "toolCall", arguments: { key: "secret" } },
					{ type: "text", text: "Visible" },
				],
				headers: { Authorization: "secret" },
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "result" }], isError: true },
		]);
		expect(messages.map(message => [message.role, message.text])).toEqual([
			["assistant", "Visible"],
			["tool", "result"],
		]);
		expect(messages[1]?.isError).toBe(true);
		expect(JSON.stringify(messages)).not.toContain("secret");
		expect(messages[0]?.blocks).toEqual([
			{ type: "thinking", text: "visible reasoning" },
			{ type: "text", text: "Visible" },
		]);
	});
	test("bounds history and message text", () => {
		const projected = projectMessages(
			Array.from({ length: 200 }, (_, index) => ({ role: "user", content: `${index}:${"x".repeat(20_000)}` })),
		);
		expect(projected).toHaveLength(160);
		expect(projected.every(message => message.text.length <= 8000)).toBe(true);
		expect(projected.every(message => message.truncated === true)).toBe(true);
	});
	test("the explicit history page keeps every message with a larger per-message bound", () => {
		const messages = Array.from({ length: 400 }, (_, index) => ({
			role: "user" as const,
			content: `${index}:${"y".repeat(1_000)}`,
		}));
		expect(projectMessages(messages)).toHaveLength(160);
		const first = projectHistoryPage(messages, 0, 500);
		expect(first.total).toBe(400);
		expect(first.page).toHaveLength(400);
		expect(first.truncated).toBe(false);
		expect(first.page.every(message => message.text.length <= 32_000)).toBe(true);
		// Projection keeps the tail of long text but preserves message order.
		expect(first.page[0]?.id.startsWith("0:")).toBe(true);
		expect(first.page[399]?.id.startsWith("399:")).toBe(true);
		// A later page must be addressable, not empty.
		const second = projectHistoryPage(messages, 380, 50);
		expect(second.page).toHaveLength(20);
		expect(second.page[0]?.id.startsWith("380:")).toBe(true);

		// Visible indexes drive paging: hidden entries (bash, compaction summaries)
		// must not shift the offset or inflate the count.
		const interleaved = Array.from({ length: 30 }, (_, index) =>
			index % 3 === 1
				? { role: "custom", customType: "hook", content: "hidden" }
				: { role: index % 3 === 2 ? "toolResult" : "user", content: `m${index}` },
		);
		const firstPage = projectHistoryPage(interleaved, 0, 10);
		expect(firstPage.total).toBe(20);
		expect(firstPage.page.map(message => message.id)).toEqual(
			[0, 2, 3, 5, 6, 8, 9, 11, 12, 14].map(index => `${index}:`),
		);
		const nextPage = projectHistoryPage(interleaved, 10, 10);
		expect(nextPage.page.map(message => message.id)).toEqual(
			[15, 17, 18, 20, 21, 23, 24, 26, 27, 29].map(index => `${index}:`),
		);
		expect(nextPage.truncated).toBe(false);
		expect(new Set([...firstPage.page, ...nextPage.page].map(message => message.id)).size).toBe(20);
		expect(second.page[19]?.id.startsWith("399:")).toBe(true);
		// The byte budget stops a page early instead of exceeding the frame limit.
		const huge = projectHistoryPage(
			Array.from({ length: 200 }, () => ({ role: "assistant" as const, content: "z".repeat(32_000) })),
			0,
			200,
		);
		expect(huge.page.length).toBeLessThan(200);
		expect(huge.truncated).toBe(true);
		expect(huge.page.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(2_000_000);
	});

	test("projects a failed assistant turn as a visible error, not an empty bubble", () => {
		const page = projectHistoryPage(
			[
				{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "401 The requested model does not exist or you do not have access to it.",
					timestamp: 2,
				},
			],
			0,
			10,
		);
		const failure = page.page[1];
		expect(failure?.isError).toBe(true);
		expect(failure?.text).toContain("you do not have access");
		expect(failure?.text).not.toBe("");
	});
});

describe("catalog-owned selected-entry forks with the real SDK", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	const releases: Array<() => void> = [];
	const spies: Array<{ mockRestore: () => void }> = [];
	async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2_000);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
	function heldRelease() {
		const release = Promise.withResolvers<void>();
		releases.push(() => release.resolve());
		return release;
	}
	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		spies.push(vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined));
	});
	afterEach(async () => {
		const failures: unknown[] = [];
		try {
			while (releases.length) {
				try {
					releases.pop()!();
				} catch (error) {
					failures.push(error);
				}
			}
			while (cleanups.length) {
				try {
					await cleanups.pop()!();
				} catch (error) {
					failures.push(error);
				}
			}
		} finally {
			while (spies.length) {
				try {
					spies.pop()!.mockRestore();
				} catch (error) {
					failures.push(error);
				}
			}
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
		if (failures.length) throw new AggregateError(failures, "Fork fixture cleanup failed");
	});
	async function launch(
		options: {
			beforeBranch?: () => Promise<{ cancel?: boolean }>;
			profileFailureSecret?: string;
			observeFrame?: (frame: DesktopFrame) => void;
			configureCandidate?: (
				result: CreateAgentSessionResult,
				dependencies: { settings: Settings; registry: ModelRegistry },
			) => void;
		} = {},
	) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-fork-"));
		const dataDir = path.join(directory, "app");
		const projectDir = path.join(directory, "project");
		await fs.mkdir(projectDir);
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const frames: DesktopFrame[] = [];
		const sessions: CreateAgentSessionResult[] = [];
		const dependencies: Array<{ settings: Settings; registry: ModelRegistry }> = [];
		const uiBindings: string[] = [];
		const entryIds: string[] = [];
		let assistantId = "";
		const texts = ["same source", "selected source\ntrailing spaces kept  ", "same source"];
		const createHost = () =>
			new DesktopHost({
				dataDir,
				emit: frame => {
					options.observeFrame?.(frame);
					frames.push(frame);
				},
				createSession: async factoryOptions => {
					const manager = factoryOptions.sessionManager;
					if (!manager) throw new Error("Expected host-owned session manager");
					const candidate = sessions.length > 0;
					if (!candidate) {
						for (const [index, text] of texts.entries()) {
							entryIds.push(manager.appendMessage({ role: "user", content: text, timestamp: index + 1 }));
							if (index === 0) {
								const assistant: AssistantMessage = {
									role: "assistant",
									content: [{ type: "text", text: "first response" }],
									api: "openai-completions",
									provider: "fixture",
									model: "fixture",
									stopReason: "stop",
									timestamp: 10,
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
								};
								assistantId = manager.appendMessage(assistant);
							}
						}
					}
					const result = await createAgentSession({
						...factoryOptions,
						extensions:
							candidate && options.beforeBranch
								? [
										extension => {
											extension.on("session_before_branch", () => options.beforeBranch!());
										},
									]
								: [],
					});
					sessions.push(result);
					if (!candidate && options.profileFailureSecret) {
						result.session.settings.set("modelProfile.default", options.profileFailureSecret);
						result.session.activateModelProfileForControl = async () => {
							throw new Error(`profile failure ${options.profileFailureSecret}`);
						};
					}
					const ownedDependencies = { settings: result.session.settings, registry: factoryOptions.modelRegistry! };
					dependencies.push(ownedDependencies);
					if (candidate) options.configureCandidate?.(result, ownedDependencies);
					// Keep lazy lifecycle-bound getters (jobObservation/MCP) on the factory.
					const setToolUIContext = result.setToolUIContext.bind(result);
					result.setToolUIContext = (context, interactive) => {
						uiBindings.push(result.session.sessionId);
						setToolUIContext(context, interactive);
					};
					return result;
				},
			});
		let host = createHost();
		const requests = new Set<Promise<unknown>>();
		const track = <T>(pending: Promise<T>): Promise<T> => {
			requests.add(pending);
			void pending.then(
				() => requests.delete(pending),
				() => requests.delete(pending),
			);
			return pending;
		};
		let closeObserved = false;
		const close = async () => {
			const closing = host.close();
			void closing.then(
				() => {
					closeObserved = true;
				},
				() => {
					closeObserved = true;
				},
			);
			await bounded(closing, `host close (${directory})`);
		};
		cleanups.push(async () => {
			const failures: unknown[] = [];
			let closeSettled = false;
			let joined = false;
			try {
				await bounded(
					host.close().then(
						() => {
							closeSettled = true;
						},
						error => {
							closeSettled = true;
							throw error;
						},
					),
					`host cleanup (${directory})`,
				);
			} catch (error) {
				if (!closeObserved || !closeSettled) failures.push(error);
			}
			try {
				await bounded(
					Promise.all([
						Promise.allSettled([...requests]),
						Promise.all(sessions.map(result => result.session.awaitDisposeCompletion())),
					]),
					`actual session cleanup (${directory})`,
				);
				joined = true;
			} catch (error) {
				failures.push(error);
			}
			if (joined && closeSettled)
				await bounded(fs.rm(directory, { recursive: true, force: true }), `fixture removal (${directory})`);
			else failures.push(new Error(`Unproven teardown; fixture retained at ${directory}`));
			if (failures.length) throw new AggregateError(failures, `Fixture cleanup failed (${directory})`);
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
			const id = crypto.randomUUID();
			const handling = track(host.handle(parseRequest(JSON.stringify({ id, method, params }))));
			await bounded(handling, `request ${method}`);
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const restart = async () => {
			if (!closeObserved) throw new Error("Previous host close has not settled");
			await bounded(
				Promise.all(sessions.map(result => result.session.awaitDisposeCompletion())),
				"pre-restart actual teardown",
			);
			host = createHost();
			closeObserved = false;
			return call<DesktopSnapshot>("bootstrap");
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		if (options.profileFailureSecret)
			await expect(
				call("auth.setKey", { provider: "unknown-provider", key: options.profileFailureSecret }),
			).rejects.toThrow();
		const source = await call<DesktopSession>("session.create", { projectId: project.id });
		const sdk = sessions[0]!.session;
		const sourceFile = sdk.sessionFile!;
		const sourceBytes = await Bun.file(sourceFile).text();
		const transcriptFiles = async () =>
			(await fs.readdir(path.dirname(sourceFile))).filter(file => file.endsWith(".jsonl")).sort();
		return {
			host,
			close,
			call,
			restart,
			track,
			source,
			sdk,
			sourceFile,
			sourceBytes,
			texts,
			entryIds,
			assistantId,
			sessions,
			dependencies,
			uiBindings,
			frames,
			transcriptFiles,
			dataDir,
		};
	}

	test("redacts thinking and withholds secret-bearing previews across DTOs and emitted frames", async () => {
		const h = await launch();
		await expect(h.call("auth.setKey", { provider: "unknown-provider", key: "QUFB" })).rejects.toThrow();
		const existing = h.sdk.messages.find(message => message.role === "assistant") as AssistantMessage;
		h.sdk.agent.state.messages.push({
			...existing,
			content: [
				{ type: "thinking", thinking: "secret QUFB", thinkingSignature: "signature-secret" },
				{ type: "image", mimeType: "image/png", data: "QUFB" },
				{ type: "image", mimeType: "image/png", data: "QkJC" },
			],
		} as unknown as AssistantMessage);
		const snapshot = h.host.snapshot();
		const history = await h.call<DesktopHistory>("history.get", { sessionId: h.source.id });
		for (const message of [
			snapshot.sessions.find(session => session.id === h.source.id)!.messages.at(-1)!,
			history.messages.at(-1)!,
		]) {
			expect(message.blocks).toEqual([
				{ type: "thinking", text: "secret [redacted]" },
				{ type: "image-unavailable", reason: "Image preview is unavailable for security reasons." },
				{ type: "image", mimeType: "image/png", data: "QkJC" },
			]);
			expect(JSON.stringify(message)).not.toContain("signature-secret");
		}
		const frame = h.frames.findLast(
			frame =>
				frame.type === "response" &&
				frame.ok &&
				!!frame.result &&
				typeof frame.result === "object" &&
				"messages" in frame.result,
		);
		expect(frame).toBeDefined();
		expect(JSON.stringify(frame)).not.toContain("QUFB");
		expect(JSON.stringify(frame)).toContain("QkJC");
		await h.call("bootstrap");
		const snapshotFrame = h.frames.findLast(frame => frame.type === "snapshot");
		expect(snapshotFrame).toBeDefined();
		expect(JSON.stringify(snapshotFrame)).not.toContain("QUFB");
		expect(JSON.stringify(snapshotFrame)).toContain("QkJC");
	});

	test("redacts default profile candidate failure notices in direct snapshots", async () => {
		const secret = "profile-credential-unique";
		const h = await launch({ profileFailureSecret: secret });
		const snapshot = h.host.snapshot();
		const notice = snapshot.sessions
			.find(session => session.id === h.source.id)!
			.messages.find(message => message.id.startsWith("profile:"));
		expect(notice?.text).toContain("[redacted]");
		expect(notice?.text).not.toContain(secret);
		expect(JSON.stringify(h.frames)).not.toContain(secret);
	});

	test.each([0, 1, 2])("branches before persisted user entry %s without rotating the source", async index => {
		const h = await launch();
		const sourceIdentity = h.sdk.sessionId;
		const sourceGeneration = h.sdk.sessionLifecycle.generation;
		const history = await h.call<DesktopHistory>("history.get", { sessionId: h.source.id });
		const users = history.messages.filter(message => message.role === "user");
		expect(users.map(message => message.entryId)).toEqual(h.entryIds);
		expect(users[index]?.id).not.toBe(h.entryIds[index]);
		expect(history.messages.find(message => message.role === "assistant")?.entryId).toBeUndefined();
		expect(projectMessages([{ role: "user", content: "synthetic", timestamp: 1 }])[0]?.entryId).toBeUndefined();
		const fork = await h.call<DesktopForkResult>("session.fork", {
			sessionId: h.source.id,
			entryId: users[index]!.entryId,
		});
		if (fork.cancelled) throw new Error("Unexpected cancellation");
		expect(fork.selectedText).toBe(h.texts[index]!);
		expect(fork.session.id).not.toBe(h.source.id);
		const child = h.sessions[1]!.session;
		expect(child).not.toBe(h.sdk);
		expect(child.sessionId).not.toBe(sourceIdentity);
		expect(child.sessionFile).not.toBe(h.sourceFile);
		expect(child.sessionLifecycle.generation).toBeGreaterThan(0);
		expect(h.sdk.sessionId).toBe(sourceIdentity);
		expect(h.sdk.sessionFile).toBe(h.sourceFile);
		expect(h.sdk.sessionLifecycle.generation).toBe(sourceGeneration);
		expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
		const copied = await h.call<DesktopHistory>("history.get", { sessionId: fork.session.id });
		const expected = history.messages.slice(
			0,
			history.messages.findIndex(message => message.entryId === h.entryIds[index]),
		);
		expect(copied.messages.map(message => [message.role, message.text])).toEqual(
			expected.map(message => [message.role, message.text]),
		);
		expect(copied.messages.some(message => message.entryId === h.entryIds[index])).toBe(false);
		const header: { parentSession: string } = JSON.parse((await Bun.file(child.sessionFile!).text()).split("\n")[0]!);
		expect(header.parentSession).not.toBe(h.sourceFile);
		expect(await Bun.file(header.parentSession).exists()).toBe(true);
		expect(await h.transcriptFiles()).toHaveLength(3);
		const snapshot = await h.call<DesktopSnapshot>("bootstrap");
		expect(snapshot.sessions.map(session => session.id).sort()).toEqual([h.source.id, fork.session.id].sort());
		expect(h.uiBindings).toEqual([sourceIdentity, child.sessionId]);
		expect((await h.call<DesktopSession>("session.select", { sessionId: h.source.id })).messages).toEqual(
			history.messages,
		);
	});

	test("successful fork does not run a fallible source finalizer after committing the child", async () => {
		const h = await launch();
		const flush = h.sdk.sessionManager.flush.bind(h.sdk.sessionManager);
		let sourceFlushes = 0;
		const sourceFlush = vi.spyOn(h.sdk.sessionManager, "flush").mockImplementation(async () => {
			if (++sourceFlushes > 1) throw new Error("unexpected post-commit source flush");
			await flush();
		});
		spies.push(sourceFlush);
		try {
			const fork = await h.call<DesktopForkResult>("session.fork", {
				sessionId: h.source.id,
				entryId: h.entryIds[1],
			});
			if (fork.cancelled) throw new Error("Unexpected cancellation");
			expect(fork.selectedText).toBe(h.texts[1]!);
			expect(sourceFlushes).toBe(1);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id).sort()).toEqual(
				[h.source.id, fork.session.id].sort(),
			);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
		} finally {
			sourceFlush.mockRestore();
		}
	});

	test("explicit whole-copy fork returns the same DTO without calling branch", async () => {
		const h = await launch({
			configureCandidate: result => {
				spies.push(vi.spyOn(result.session, "branch"));
			},
		});
		const fork = await h.call<DesktopForkResult>("session.fork", { sessionId: h.source.id });
		if (fork.cancelled) throw new Error("Unexpected cancellation");
		expect(fork.selectedText).toBe("");
		expect(h.sessions[1]!.session.branch).not.toHaveBeenCalled();
		expect(fork.session.messages.map(message => message.text)).toEqual(
			h.source.messages.map(message => message.text),
		);
		expect(await h.transcriptFiles()).toHaveLength(2);
		expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
	});

	test("rejects display, malformed, unknown and non-user IDs before constructing any candidate", async () => {
		const h = await launch();
		const files = await h.transcriptFiles();
		for (const entryId of [null, "", "0:1", "unknown", h.assistantId, 123]) {
			await expect(h.call("session.fork", { sessionId: h.source.id, entryId })).rejects.toThrow();
			expect(h.sessions).toHaveLength(1);
			expect(await h.transcriptFiles()).toEqual(files);
		}
		expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
	});

	test("hook cancellation publishes nothing and awaits private-candidate disposal", async () => {
		const entered = Promise.withResolvers<void>();
		const releaseBranch = heldRelease();
		const disposing = Promise.withResolvers<void>();
		const releaseDisposal = heldRelease();
		const h = await launch({
			beforeBranch: async () => {
				entered.resolve();
				await releaseBranch.promise;
				return { cancel: true };
			},
			configureCandidate: result => {
				result.session.registerToolSessionCleanup(async () => {
					disposing.resolve();
					await releaseDisposal.promise;
				});
			},
		});
		const files = await h.transcriptFiles();
		let settled = false;
		const pending = h
			.call<DesktopForkResult>("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] })
			.finally(() => {
				settled = true;
			});
		void pending.catch(() => {});
		try {
			await bounded(entered.promise, "branch hook entry");
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
			expect(h.uiBindings).toHaveLength(1);
			await expect(h.call("prompt", { sessionId: h.source.id, text: "must not queue" })).rejects.toThrow(
				"session change",
			);
			releaseBranch.resolve();
			await bounded(disposing.promise, "candidate disposal entry");
			expect(settled).toBe(false);
			releaseDisposal.resolve();
			expect(await pending).toEqual({ cancelled: true });
			expect(await h.transcriptFiles()).toEqual(files);
			expect(h.sessions[1]!.session.sessionLifecycle.disposed).toBe(true);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			expect(h.frames.some(frame => frame.type === "session" && frame.session.id !== h.source.id)).toBe(false);
		} finally {
			releaseBranch.resolve();
			releaseDisposal.resolve();
			await pending;
		}
	});

	test("rejects publication if the source SDK identity changes while a candidate hook awaits", async () => {
		const entered = Promise.withResolvers<void>();
		const release = heldRelease();
		const h = await launch({
			beforeBranch: async () => {
				entered.resolve();
				await release.promise;
				return {};
			},
		});
		const pending = h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] });
		const outcome = pending.then(
			value => ({ value, error: undefined }),
			error => ({ value: undefined, error }),
		);
		let identityChange: Promise<boolean> | undefined;
		try {
			await bounded(entered.promise, "branch hook entry");
			const previousIdentity = h.sdk.sessionId;
			identityChange = h.track(h.sdk.newSession());
			expect(await bounded(identityChange, "source identity change")).toBe(true);
			expect(h.sdk.sessionId).not.toBe(previousIdentity);
			release.resolve();
			expect(String((await outcome).error)).toContain("Source session changed while forking");
			expect(h.sessions[1]!.session.sessionLifecycle.disposed).toBe(true);
			expect(await Bun.file(h.sessions[1]!.session.sessionFile!).exists()).toBe(false);
			expect(h.uiBindings).toEqual([previousIdentity, h.sdk.sessionId]);
			expect(h.uiBindings).not.toContain(h.sessions[1]!.session.sessionId);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
		} finally {
			release.resolve();
			await bounded(
				Promise.allSettled([pending, ...(identityChange ? [identityChange] : [])]),
				"identity race completion",
			);
		}
	});

	test("uncertain candidate disposal reports failure and retains its owned transcript", async () => {
		let restoreDisposal: (() => void) | undefined;
		const h = await launch({
			beforeBranch: async () => ({ cancel: true }),
			configureCandidate: (result, owned) => {
				spies.push(vi.spyOn(owned.registry, "dispose"), vi.spyOn(owned.settings, "close"));
				const unavailable = new Error("disposal unavailable");
				const disposal = vi.spyOn(result.session, "dispose").mockRejectedValue(unavailable);
				const completion = vi.spyOn(result.session, "awaitDisposeCompletion").mockRejectedValue(unavailable);
				restoreDisposal = () => {
					disposal.mockRestore();
					completion.mockRestore();
				};
				spies.push(disposal, completion);
				releases.push(restoreDisposal);
			},
		});
		try {
			await expect(h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] })).rejects.toThrow(
				"Session fork and owned cleanup failed",
			);
			expect(await Bun.file(h.sessions[1]!.session.sessionFile!).exists()).toBe(true);
			expect(h.uiBindings).toHaveLength(1);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			expect(h.dependencies[1]!.registry.dispose).not.toHaveBeenCalled();
			expect(h.dependencies[1]!.settings.close).not.toHaveBeenCalled();
		} finally {
			restoreDisposal?.();
		}
		await h.close();
		expect(h.dependencies[1]!.registry.dispose).toHaveBeenCalledTimes(1);
		expect(h.dependencies[1]!.settings.close).toHaveBeenCalledTimes(1);
	});

	test.each([
		"unpublished",
		"rolled-back publication",
		"failed session load",
	] as const)("%s retains dependencies and shutdown ownership past the SDK disposal deadline", async ownership => {
		const disposing = Promise.withResolvers<void>();
		const closingStarted = Promise.withResolvers<void>();
		const release = heldRelease();
		const ownedFiles = new Set<string>();
		const h = await launch({
			beforeBranch: ownership === "unpublished" ? async () => ({ cancel: true }) : undefined,
			configureCandidate: (result, owned) => {
				ownedFiles.add(result.session.sessionFile!);
				result.session.subscribeSessionIdentityChanges(() => {
					ownedFiles.add(result.session.sessionFile!);
				});
				spies.push(vi.spyOn(owned.registry, "dispose"), vi.spyOn(owned.settings, "close"));
				result.session.setDisposeTimeoutForTests(10);
				result.session.registerToolSessionCleanup(async () => {
					disposing.resolve();
					await release.promise;
				});
				const dispose = result.session.dispose.bind(result.session);
				let calls = 0;
				spies.push(
					vi.spyOn(result.session, "dispose").mockImplementation(() => {
						if (++calls === (ownership === "unpublished" ? 3 : 2)) closingStarted.resolve();
						return dispose();
					}),
				);
				if (ownership !== "unpublished") {
					spies.push(
						vi.spyOn(result, "setToolUIContext").mockImplementation(() => {
							throw new Error("UI binding failed");
						}),
					);
				}
			},
		});
		const pending =
			ownership === "failed session load"
				? h.call("session.create", { projectId: h.source.projectId })
				: h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] });
		const outcome = pending.then(
			value => ({ value, error: undefined }),
			error => ({ value: undefined, error }),
		);
		let close: Promise<void> | undefined;
		try {
			await bounded(disposing.promise, "candidate disposal entry");
			expect(String((await outcome).error)).toContain(
				ownership === "failed session load"
					? "Session publication and owned cleanup failed"
					: "Session fork and owned cleanup failed",
			);
			expect(h.dependencies[1]!.registry.dispose).not.toHaveBeenCalled();
			expect(h.dependencies[1]!.settings.close).not.toHaveBeenCalled();
			for (const file of ownedFiles) expect(await Bun.file(file).exists()).toBe(true);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			let settled = false;
			close = h.close().finally(() => {
				settled = true;
			});
			const closed = close.then(
				() => undefined,
				error => error,
			);
			await bounded(closingStarted.promise, "shutdown disposal entry");
			expect(settled).toBe(false);
			expect(h.dependencies[1]!.registry.dispose).not.toHaveBeenCalled();
			expect(h.dependencies[1]!.settings.close).not.toHaveBeenCalled();
			release.resolve();
			expect(String(await closed)).toContain("Desktop shutdown failed");
			await bounded(h.sessions[1]!.session.awaitDisposeCompletion(), "candidate actual disposal");
			expect(h.dependencies[1]!.registry.dispose).toHaveBeenCalledTimes(1);
			expect(h.dependencies[1]!.settings.close).toHaveBeenCalledTimes(1);
			for (const file of ownedFiles) expect(await Bun.file(file).exists()).toBe(true);
		} finally {
			release.resolve();
			await bounded(Promise.allSettled([pending, ...(close ? [close] : [])]), "held disposal request completion");
			await bounded(h.sessions[1]!.session.awaitDisposeCompletion(), "candidate actual disposal");
		}
	});

	test("failed durable catalog rollback preserves both fork identities referenced by the last saved catalog", async () => {
		const h = await launch({
			configureCandidate: result => {
				spies.push(
					vi.spyOn(result, "setToolUIContext").mockImplementation(() => {
						throw new Error("UI binding failed");
					}),
				);
			},
		});
		const catalogPath = path.join(h.dataDir, "catalog.json");
		const rename = fs.rename;
		let catalogWrites = 0;
		const save = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === catalogPath && ++catalogWrites === 2) throw new Error("catalog rollback failed");
			return rename(from, to);
		});
		spies.push(save);
		try {
			await expect(h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] })).rejects.toThrow(
				"Session fork and owned cleanup failed",
			);
			expect(catalogWrites).toBe(2);
			await bounded(h.sessions[1]!.session.awaitDisposeCompletion(), "candidate actual disposal");
			const catalog: { sessions: Array<{ id: string; file: string }> } = await Bun.file(catalogPath).json();
			expect(catalog.sessions).toHaveLength(2);
			const successor = catalog.sessions.find(session => session.id !== h.source.id)!;
			const successorFile = path.join(h.dataDir, "sessions", successor.file);
			expect(successorFile).toBe(h.sessions[1]!.session.sessionFile!);
			expect(await Bun.file(successorFile).exists()).toBe(true);
			const header: { parentSession: string } = JSON.parse((await Bun.file(successorFile).text()).split("\n")[0]!);
			expect(await Bun.file(header.parentSession).exists()).toBe(true);
			expect(await h.transcriptFiles()).toHaveLength(3);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
		} finally {
			save.mockRestore();
		}
		await expect(h.close()).rejects.toThrow("Desktop shutdown failed");
	});

	test("failed deletion catalog save preserves the transcript and supports restart recovery", async () => {
		const h = await launch();
		const catalogPath = path.join(h.dataDir, "catalog.json");
		const before = await Bun.file(catalogPath).text();
		const rename = fs.rename;
		let catalogWrites = 0;
		const save = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === catalogPath) {
				catalogWrites++;
				throw new Error("deletion catalog save failed");
			}
			return rename(from, to);
		});
		spies.push(save);
		try {
			await expect(h.call("session.delete", { sessionId: h.source.id })).rejects.toThrow(
				"deletion catalog save failed",
			);
			expect(catalogWrites).toBe(1);
			expect(h.sdk.sessionLifecycle.disposed).toBe(true);
			await bounded(h.sdk.awaitDisposeCompletion(), "deleted session actual disposal");
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			expect(await Bun.file(catalogPath).text()).toBe(before);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
		} finally {
			save.mockRestore();
		}
		await expect(h.close()).rejects.toThrow("Desktop shutdown failed");
		expect((await h.restart()).sessions.map(session => session.id)).toEqual([h.source.id]);
		const recovered = await h.call<DesktopSession>("session.select", { sessionId: h.source.id });
		expect(recovered.messages).toEqual(h.source.messages);
		await h.call("session.delete", { sessionId: h.source.id });
		expect(await Bun.file(h.sourceFile).exists()).toBe(false);
		expect((await Bun.file(catalogPath).json()).sessions).toEqual([]);
	});

	test("artifact deletion failure does not resurrect a durably removed catalog entry", async () => {
		const h = await launch();
		const remove = vi
			.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts")
			.mockRejectedValue(new Error("artifact cleanup failed"));
		spies.push(remove);
		try {
			await expect(h.call("session.delete", { sessionId: h.source.id })).rejects.toThrow("artifact cleanup failed");
			expect(remove).toHaveBeenCalledTimes(1);
			expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
			expect((await Bun.file(path.join(h.dataDir, "catalog.json")).json()).sessions).toEqual([]);
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions).toEqual([]);
		} finally {
			remove.mockRestore();
		}
		await h.close();
		expect((await h.restart()).sessions).toEqual([]);
	});

	test.each([
		"snapshot",
		"session",
	] as const)("%s publication transport failure retains the committed fork and its live owner", async failedFrameType => {
		let publishedChild = false;
		let failed = false;
		const h = await launch({
			observeFrame: frame => {
				if (frame.type === "snapshot" && frame.snapshot.sessions.length === 2) publishedChild = true;
				if (publishedChild && !failed && frame.type === failedFrameType) {
					failed = true;
					throw new Error("transport unavailable after fork commit");
				}
			},
		});
		await expect(h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] })).rejects.toThrow(
			"transport unavailable after fork commit",
		);
		expect(failed).toBe(true);
		const catalog: { sessions: Array<{ id: string }> } = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
		expect(catalog.sessions).toHaveLength(2);
		expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id).sort()).toEqual(
			catalog.sessions.map(session => session.id).sort(),
		);
		expect(await h.transcriptFiles()).toHaveLength(3);
		expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
		expect(h.sessions[1]!.session.sessionLifecycle.disposed).toBe(false);
		const childId = catalog.sessions.find(session => session.id !== h.source.id)!.id;
		expect((await h.call<DesktopSession>("session.select", { sessionId: childId })).id).toBe(childId);
		expect(h.sessions).toHaveLength(2);
		await h.close();
		expect((await h.restart()).sessions.map(session => session.id).sort()).toEqual(
			catalog.sessions.map(session => session.id).sort(),
		);
	});

	test("reserves a private fork's opening owner while durable publication is held", async () => {
		const h = await launch();
		const saving = Promise.withResolvers<string>();
		const release = heldRelease();
		const rename = fs.rename;
		const catalogPath = path.join(h.dataDir, "catalog.json");
		let held = false;
		spies.push(
			vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (String(to) === catalogPath && !held) {
					held = true;
					const catalog: { sessions: Array<{ id: string }> } = await Bun.file(String(from)).json();
					saving.resolve(catalog.sessions.find(session => session.id !== h.source.id)!.id);
					await release.promise;
				}
				return rename(from, to);
			}),
		);
		const pending = h.call<DesktopForkResult>("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] });
		void pending.catch(() => {});
		let selection: Promise<DesktopSession> | undefined;
		try {
			const forkId = await bounded(saving.promise, "fork catalog save entry");
			expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([
				h.source.id,
			]);
			selection = h.call<DesktopSession>("session.select", { sessionId: forkId });
			void selection.catch(() => {});
			release.resolve();
			const fork = await pending;
			if (fork.cancelled) throw new Error("Unexpected cancellation");
			expect((await selection).id).toBe(fork.session.id);
			expect(h.sessions).toHaveLength(2);
			expect(h.uiBindings).toEqual([h.sdk.sessionId, h.sessions[1]!.session.sessionId]);
		} finally {
			release.resolve();
			await bounded(
				Promise.allSettled([pending, ...(selection ? [selection] : [])]),
				"publication selection completion",
			);
		}
	});

	test("a real post-commit SDK branch failure disposes and removes both private identities", async () => {
		let candidateId = "";
		let successorFile = "";
		const h = await launch({
			configureCandidate: result => {
				candidateId = result.session.sessionId;
				result.session.subscribeSessionIdentityChanges(() => {
					successorFile = result.session.sessionFile!;
				});
				let attempts = 0;
				result.session.registerToolSessionTransitionCleanup(() => {
					if (attempts++ === 0) throw new Error("branch cleanup failed");
				});
			},
		});
		const files = await h.transcriptFiles();
		await expect(h.call("session.fork", { sessionId: h.source.id, entryId: h.entryIds[1] })).rejects.toThrow();
		expect(h.sessions[1]!.session.sessionId).not.toBe(candidateId);
		expect(successorFile).not.toBe("");
		expect(await Bun.file(successorFile).exists()).toBe(false);
		expect(await h.transcriptFiles()).toEqual(files);
		expect(h.uiBindings).toHaveLength(1);
		expect((await h.call<DesktopSnapshot>("bootstrap")).sessions.map(session => session.id)).toEqual([h.source.id]);
		expect(await Bun.file(h.sourceFile).text()).toBe(h.sourceBytes);
	});
});

describe("desktop settings surface", () => {
	const settings = () => Settings.isolated({ "compaction.enabled": true, "retry.maxRetries": 3 });
	test("exposes schema scalars while withholding free-form, structured and secret paths", () => {
		const items = desktopSettings(settings());
		expect(items.length).toBeGreaterThan(2);
		const paths = new Set(items.map(item => item.path));
		expect(paths.has("compaction.enabled")).toBe(true);
		expect(paths.has("retry.maxRetries")).toBe(true);
		expect(items.some(item => item.path === "theme.dark")).toBe(false);
		expect(items.some(item => /token|secret|password|credential/i.test(item.path))).toBe(false);
		expect(items.every(item => ["boolean", "number", "enum"].includes(item.type))).toBe(true);
		// Notification delivery is terminal/host-owned: a headless desktop host cannot
		// deliver bells or Telegram messages, so those settings must be refused. Assert
		// through validation: isolated settings cannot persist anywhere, which would
		// make a `writable === false` check pass for every path.
		expect(() => validateDesktopSetting("notifications.terminalBell", true)).toThrow("terminal UI");
		expect(() => validateDesktopSetting("notifications.enabled", true)).toThrow("terminal UI");
		// Terminal-only settings stay visible but are not writable from the desktop.
		const uiLanguage = items.find(item => item.path === "ui.language");
		if (uiLanguage) expect(uiLanguage.writable).toBe(false);
	});
	test("validates writes against the schema instead of accepting arbitrary values", () => {
		expect(validateDesktopSetting("compaction.enabled", false)).toBe("compaction.enabled");
		expect(validateDesktopSetting("retry.maxRetries", 2)).toBe("retry.maxRetries");
		expect(() => validateDesktopSetting("compaction.enabled", "yes")).toThrow("Setting requires a boolean");
		expect(() => validateDesktopSetting("retry.maxRetries", Number.NaN)).toThrow("Setting requires a number");
		expect(() => validateDesktopSetting("theme.dark", "red-claw")).toThrow(
			"Setting is not editable from the desktop host",
		);
		expect(() => validateDesktopSetting("not.a.path", true)).toThrow("Unknown setting path");
		expect(() => validateDesktopSetting("ui.language", "xx")).toThrow(
			"Setting only affects the terminal UI and cannot be changed from the desktop host",
		);
		// Enum validation still rejects an unknown choice for an app-effective enum.
		expect(() => validateDesktopSetting("compaction.strategy", "nonsense")).toThrow(
			"Setting value is not a valid choice",
		);
		expect(validateDesktopSetting("compaction.strategy", "off")).toBe("compaction.strategy");
	});
});

describe("concurrent JSONL transport", () => {
	test.each([
		"abort",
		"operator.abort",
		"operator.fold",
		"btw.cancel",
		"btw.close",
		"question.answer",
		"gate.presented",
		"gate.retired",
		"auth.answer",
		"auth.cancel",
		"shutdown",
	] as const)("admits %s when ordinary request capacity is exhausted", async method => {
		const blocked = Promise.withResolvers<void>();
		const calls: string[] = [];
		const frames: DesktopFrame[] = [];
		const host: ProtocolHost = {
			async handle(command) {
				calls.push(command.method);
				if (command.method === "prompt") await blocked.promise;
			},
			async close() {
				calls.push("close");
				blocked.resolve();
			},
		};
		async function* input() {
			for (let index = 0; index < 128; index++) yield encode(request(`prompt-${index}`, "prompt"));
			yield encode(request("overflow", "bootstrap"));
			yield encode(request("control", method));
		}
		await serveProtocol(input(), host, frame => frames.push(frame));
		expect(calls).toEqual([...Array.from({ length: 128 }, () => "prompt"), method, "close"]);
		expect(frames).toEqual([{ type: "response", id: "overflow", ok: false, error: "Too many concurrent requests" }]);
	});
	test("delivers question answers and abort while prompt is unresolved", async () => {
		const prompt = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const calls: string[] = [];
		const host: ProtocolHost = {
			async handle(command) {
				calls.push(command.method);
				if (command.method === "prompt") await prompt.promise;
				if (command.method === "question.answer") answered.resolve();
				if (command.method === "abort") {
					prompt.resolve();
					aborted.resolve();
				}
			},
			async close() {
				calls.push("close");
				prompt.resolve();
			},
		};
		async function* input() {
			yield encode(request("p", "prompt"));
			yield encode(request("q", "question.answer"));
			await answered.promise;
			yield encode(request("a", "abort"));
			await aborted.promise;
		}
		await serveProtocol(input(), host, () => {});
		expect(calls).toEqual(["prompt", "question.answer", "abort", "close"]);
	});
	test("EOF closes before joining pending prompt so cancellation cannot deadlock", async () => {
		const pending = Promise.withResolvers<void>();
		let cancelled = false;
		const host: ProtocolHost = {
			async handle() {
				await pending.promise;
			},
			async close() {
				cancelled = true;
				pending.resolve();
			},
		};
		async function* input() {
			yield encode(request("p", "prompt"));
		}
		await serveProtocol(input(), host, () => {});
		expect(cancelled).toBe(true);
	});
	test("rejects duplicate in-flight IDs without invoking the command twice", async () => {
		const pending = Promise.withResolvers<void>();
		const frames: DesktopFrame[] = [];
		let count = 0;
		const host: ProtocolHost = {
			async handle() {
				count++;
				await pending.promise;
			},
			async close() {
				pending.resolve();
			},
		};
		async function* input() {
			yield encode(request("same", "prompt"));
			yield encode(request("same", "prompt"));
		}
		await serveProtocol(input(), host, frame => frames.push(frame));
		expect(count).toBe(1);
		expect(frames).toEqual([{ type: "response", id: "same", ok: false, error: "Request ID already in flight" }]);
	});
	test("handles split UTF-8, malformed lines and a final line without newline", async () => {
		const frames: DesktopFrame[] = [];
		const commands: DesktopRequest[] = [];
		const host: ProtocolHost = {
			async handle(command) {
				commands.push(command);
			},
			async close() {},
		};
		const bytes = new TextEncoder().encode(
			`null\n${JSON.stringify({ id: "utf8", method: "prompt", params: { text: "🦀" } })}`,
		);
		async function* input() {
			for (const byte of bytes) yield Uint8Array.of(byte);
		}
		await serveProtocol(input(), host, frame => frames.push(frame));
		expect(frames).toEqual([{ type: "fatal", error: "Invalid protocol request" }]);
		expect(commands[0]?.params.text).toBe("🦀");
	});
});

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import * as titleGenerator from "@gajae-code/coding-agent/utils/title-generator";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";

describe("desktop automatic session titles", () => {
	let environment: NodeJS.ProcessEnv;
	let agentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	const spies: Array<{ mockRestore(): void }> = [];
	const releases: Array<() => void> = [];

	beforeEach(() => {
		environment = { ...process.env };
		agentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		spies.push(vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined));
	});
	afterEach(async () => {
		try {
			for (const release of releases.splice(0)) release();
			for (const cleanup of cleanups.splice(0)) await cleanup();
		} finally {
			for (const spy of spies.splice(0)) spy.mockRestore();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(agentDir);
		}
	});

	async function fixture(inputHandler?: (text: string) => { handled?: boolean; text?: string }) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-title-"));
		const dataDir = path.join(directory, "app");
		const projectDir = path.join(directory, "project");
		await fs.mkdir(projectDir);
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const frames: DesktopFrame[] = [];
		const titlePublished = Promise.withResolvers<void>();
		const sessions: CreateAgentSessionResult[] = [];
		let host: DesktopHost;
		const createHost = () =>
			new DesktopHost({
				dataDir,
				emit: frame => {
					frames.push(frame);
					if (frame.type === "session" && frame.session.title === "Generated title") titlePublished.resolve();
				},
				createSession: async options => {
					const result = await createAgentSession({
						...options,
						extensions: inputHandler
							? [
									extension => {
										extension.on("input", event => inputHandler(event.text));
									},
								]
							: [],
					});
					sessions.push(result);
					return result;
				},
			});
		host = createHost();
		cleanups.push(async () => {
			await host.close();
			await Promise.all(sessions.map(result => result.session.awaitDisposeCompletion()));
			await fs.rm(directory, { recursive: true, force: true });
		});
		const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}) => {
			const id = crypto.randomUUID();
			await host.handle({ id, method, params } as DesktopRequest);
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		};
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const session = await call<DesktopSession>("session.create", { projectId: project.id });
		const sdk = sessions[0]!.session;
		const restart = async () => {
			await host.close();
			await Promise.all(sessions.map(result => result.session.awaitDisposeCompletion()));
			host = createHost();
			await call("session.select", { sessionId: session.id });
		};
		return {
			call,
			project,
			session,
			sdk,
			sessions,
			frames,
			dataDir,
			restart,
			titlePublished: titlePublished.promise,
			snapshot: () => host.snapshot(),
		};
	}

	function mockPrompt(sdk: CreateAgentSessionResult["session"], refused = false) {
		const spy = vi.spyOn(sdk, "prompt").mockImplementation(async (_text, options) => {
			if (refused) throw new Error("refused");
			await options?.onPreflightAcceptCommit?.();
		});
		spies.push(spy);
	}

	test("keeps placeholder out of transcript and persists and reopens the committed auto title", async () => {
		const h = await fixture();
		expect(h.sdk.sessionManager.getSessionName()).toBeUndefined();
		const published = Promise.withResolvers<void>();
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockImplementation(async (text, options) => {
			expect(text).toBe("first text");
			expect(options?.signal?.aborted).toBe(false);
			await h.sdk.setSessionName("Generated title", "auto");
			published.resolve();
			return { kind: "applied", title: "Generated title" };
		});
		spies.push(title);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		await published.promise;
		await h.titlePublished;
		await h.call("session.star", { sessionId: h.session.id, starred: true });
		expect(title).toHaveBeenCalledTimes(1);
		expect(h.snapshot().sessions[0]?.title).toBe("Generated title");
		expect(h.frames.some(frame => frame.type === "session" && frame.session.title === "Generated title")).toBe(true);
		expect(
			h.frames.some(frame => frame.type === "snapshot" && frame.snapshot.sessions[0]?.title === "Generated title"),
		).toBe(true);
		expect(await Bun.file(h.sdk.sessionFile!).text()).toContain('"titleSource":"auto"');
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("Generated title");
	});

	test("real SDK generation is consumed before prompt recording and commits an auto title", async () => {
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		const h = await fixture();
		const pending = Promise.withResolvers<string | null>();
		releases.push(() => pending.resolve(null));
		const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(pending.promise);
		const operation = vi.spyOn(h.sdk, "generateAutoSessionTitle");
		spies.push(generator, operation);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		expect(operation).toHaveBeenCalledTimes(1);
		expect(generator).toHaveBeenCalledTimes(1);
		expect(generator.mock.calls[0]?.[0]).toBe("first text");
		expect(h.sdk.sessionManager.getSessionName()).toBeUndefined();
		pending.resolve("Generated title");
		await h.titlePublished;
		expect(h.sdk.sessionManager.getSessionName()).toBe("Generated title");
		expect(h.sdk.sessionManager.titleSource).toBe("auto");
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("Generated title");
	});

	test("old real SDK generation after host replacement cannot rename the reopened owner", async () => {
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		const h = await fixture();
		const pending = Promise.withResolvers<string | null>();
		releases.push(() => pending.resolve(null));
		const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(pending.promise);
		const operation = vi.spyOn(h.sdk, "generateAutoSessionTitle");
		spies.push(generator, operation);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		const signal = operation.mock.calls[0]?.[1]?.signal;
		const completion = operation.mock.results[0]!.value;
		await h.restart();
		expect(signal?.aborted).toBe(true);
		const framesBefore = h.frames.length;
		pending.resolve("Late old title");
		expect(await completion).toEqual({ kind: "skipped", reason: "stale" });
		await Promise.resolve();
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
		expect(JSON.stringify(h.frames.slice(framesBefore))).not.toContain("Late old title");
		const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
		expect(catalog.sessions[0].title).toBe("New session");
	});

	test("reopening reconciles a committed transcript title even when the catalog was never updated", async () => {
		const h = await fixture();
		await h.sdk.setSessionName("Recovered title", "auto");
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("Recovered title");
		const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
		expect(catalog.sessions[0].title).toBe("Recovered title");
	});

	test("title completion while a prompt is held does not enqueue catalog I/O or affect delivery", async () => {
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		const h = await fixture();
		const generated = Promise.withResolvers<string | null>();
		const admitted = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		releases.push(
			() => generated.resolve(null),
			() => releasePrompt.resolve(),
		);
		const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(generated.promise);
		const prompt = vi.spyOn(h.sdk, "prompt").mockImplementation(async (_text, options) => {
			await options?.onPreflightAcceptCommit?.();
			admitted.resolve();
			await releasePrompt.promise;
		});
		const catalogPath = path.join(h.dataDir, "catalog.json");
		const originalRename = fs.rename;
		let allowMainSave = false;
		let unexpectedWrites = 0;
		let mainWrites = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === catalogPath) {
				if (!allowMainSave) {
					unexpectedWrites++;
					throw new Error("unexpected optional title catalog write");
				}
				mainWrites++;
			}
			return originalRename(from, to);
		});
		spies.push(generator, prompt, rename);
		const handling = h.call("prompt", { sessionId: h.session.id, text: "first text" });
		await admitted.promise;
		const before = h.snapshot();
		expect(before.sessions[0]?.status).toBe("running");
		expect(before.sessions[0]?.title).toBe("New session");
		generated.resolve("Generated title");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				h.titlePublished,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Title publication blocked by catalog I/O")), 2_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		expect(h.sdk.sessionManager.getSessionName()).toBe("Generated title");
		expect(h.sdk.sessionManager.titleSource).toBe("auto");
		expect(h.snapshot().sessions[0]?.status).toBe("running");
		expect(h.snapshot().deliveries).toEqual(before.deliveries);
		expect(unexpectedWrites).toBe(0);
		allowMainSave = true;
		releasePrompt.resolve();
		await handling;
		expect(mainWrites).toBe(1);
		expect(h.snapshot().sessions[0]?.status).toBe("idle");
		expect(h.snapshot().deliveries.at(-1)?.disposition).toBe("unknown");
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("Generated title");
	});

	test("title completed after the prompt leaves a stale catalog that immediate reopen reconciles", async () => {
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		const h = await fixture();
		const generated = Promise.withResolvers<string | null>();
		releases.push(() => generated.resolve(null));
		const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(generated.promise);
		spies.push(generator);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		const deliveries = h.snapshot().deliveries;
		const catalogPath = path.join(h.dataDir, "catalog.json");
		const before = await Bun.file(catalogPath).text();
		const originalRename = fs.rename;
		let unexpectedWrites = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === catalogPath) {
				unexpectedWrites++;
				throw new Error("unexpected optional title catalog write");
			}
			return originalRename(from, to);
		});
		spies.push(rename);
		generated.resolve("Generated title");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				h.titlePublished,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Title publication blocked by catalog I/O")), 2_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		expect(unexpectedWrites).toBe(0);
		expect(h.sdk.sessionManager.titleSource).toBe("auto");
		expect(await Bun.file(h.sdk.sessionFile!).text()).toContain('"titleSource":"auto"');
		expect(h.snapshot().deliveries).toEqual(deliveries);
		expect(await Bun.file(catalogPath).text()).toBe(before);
		expect(JSON.parse(before).sessions[0].title).toBe("New session");
		rename.mockRestore();
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("Generated title");
		const reconciled = await Bun.file(catalogPath).json();
		expect(reconciled.sessions[0].title).toBe("Generated title");
	});

	test("command title synchronization cannot stall forwarded or unrelated delivery", async () => {
		process.env.GJC_NO_TITLE = "1";
		const h = await fixture();
		const second = await h.call<DesktopSession>("session.create", { projectId: h.project.id });
		const secondSdk = h.sessions[1]!.session;
		await h.sdk.setSessionName("Manual SDK title", "user");
		expect(h.sdk.sessionManager.titleSource).toBe("user");
		const catalogPath = path.join(h.dataDir, "catalog.json");
		const stale = await Bun.file(catalogPath).json();
		expect(stale.sessions.find((item: { id: string }) => item.id === h.session.id).title).toBe("New session");
		const forwarded = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const forbiddenWrite = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		releases.push(
			() => releasePrompt.resolve(),
			() => releaseWrite.resolve(),
		);
		const prompt = vi.spyOn(h.sdk, "prompt").mockImplementation(async (_text, options) => {
			await options?.onPreflightAcceptCommit?.();
			forwarded.resolve();
			await releasePrompt.promise;
		});
		mockPrompt(secondSdk);
		const originalRename = fs.rename;
		let armed = true;
		let optionalWrites = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (armed && String(to) === catalogPath) {
				optionalWrites++;
				forbiddenWrite.resolve();
				await releaseWrite.promise;
			}
			return originalRename(from, to);
		});
		spies.push(prompt, rename);
		const command = h.call("command.run", { sessionId: h.session.id, text: "forward this text" });
		void command.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = await Promise.race([
				forwarded.promise.then(() => "forwarded"),
				forbiddenWrite.promise.then(() => "optional write"),
				command.then(
					() => "command completed",
					() => "command failed",
				),
				new Promise<string>(resolve => {
					timer = setTimeout(() => resolve("timeout"), 2_000);
				}),
			]);
			expect(outcome).toBe("forwarded");
			expect(optionalWrites).toBe(0);
			expect(h.snapshot().sessions.find(item => item.id === h.session.id)?.title).toBe("Manual SDK title");
		} finally {
			if (timer) clearTimeout(timer);
			armed = false;
			releaseWrite.resolve();
			releasePrompt.resolve();
		}
		await command;
		await h.call("prompt", { sessionId: second.id, text: "unrelated prompt" });
		expect(h.snapshot().deliveries.at(-1)?.disposition).toBe("unknown");
		expect(optionalWrites).toBe(0);
		await h.sdk.setSessionName("Reopened SDK title", "user");
		const beforeRestart = await Bun.file(catalogPath).json();
		expect(beforeRestart.sessions.find((item: { id: string }) => item.id === h.session.id).title).toBe(
			"Manual SDK title",
		);
		await h.restart();
		expect(h.snapshot().sessions.find(item => item.id === h.session.id)?.title).toBe("Reopened SDK title");
	});

	test("manual title wins when auto completion returns stale data, including literal placeholder", async () => {
		const h = await fixture();
		const gate = Promise.withResolvers<void>();
		releases.push(() => gate.resolve());
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockImplementation(async () => {
			await gate.promise;
			return { kind: "applied", title: "Old generated title" };
		});
		spies.push(title);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		await h.call("session.rename", { sessionId: h.session.id, title: "New session" });
		gate.resolve();
		await Promise.resolve();
		await h.restart();
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
	});

	test("deletion aborts the pending title synchronously and late completion cannot resurrect it", async () => {
		const h = await fixture();
		const gate = Promise.withResolvers<void>();
		releases.push(() => gate.resolve());
		let signal: AbortSignal | undefined;
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockImplementation(async (_text, options) => {
			signal = options?.signal;
			await gate.promise;
			return { kind: "applied", title: "Late title" };
		});
		spies.push(title);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		await h.call("session.delete", { sessionId: h.session.id });
		expect(signal?.aborted).toBe(true);
		gate.resolve();
		await Promise.resolve();
		expect(h.snapshot().sessions).toHaveLength(0);
	});

	test("handled input and refused preflight do not start generation", async () => {
		const h = await fixture(text => (text === "handled" ? { handled: true } : { text }));
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockResolvedValue({ kind: "failed" });
		spies.push(title);
		mockPrompt(h.sdk, true);
		await h.call("prompt", { sessionId: h.session.id, text: "handled" });
		await expect(h.call("prompt", { sessionId: h.session.id, text: "refused" })).rejects.toThrow();
		expect(title).not.toHaveBeenCalled();
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
	});

	test("local slash input does not start automatic naming", async () => {
		const h = await fixture();
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockResolvedValue({ kind: "failed" });
		const local = vi.spyOn(h.sdk, "isLocallyHandledSlashCommand").mockReturnValue(true);
		spies.push(title, local);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "/help" });
		expect(title).not.toHaveBeenCalled();
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
	});

	test("a local slash does not consume the first genuinely eligible text", async () => {
		delete process.env.GJC_NO_TITLE;
		delete process.env.PI_NO_TITLE;
		const h = await fixture();
		const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockResolvedValue("Generated title");
		const operation = vi.spyOn(h.sdk, "generateAutoSessionTitle");
		const local = vi.spyOn(h.sdk, "isLocallyHandledSlashCommand").mockImplementation(text => text === "/help");
		spies.push(generator, operation, local);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "/help" });
		expect(operation).not.toHaveBeenCalled();
		await h.call("prompt", { sessionId: h.session.id, text: "first real text" });
		await h.titlePublished;
		expect(operation).toHaveBeenCalledTimes(1);
		expect(generator.mock.calls[0]?.[0]).toBe("first real text");
	});

	test("a disabled or already named first admission never triggers a later generator flight", async () => {
		for (const reason of ["disabled", "named"] as const) {
			const h = await fixture();
			if (reason === "disabled") process.env.GJC_NO_TITLE = "1";
			else {
				delete process.env.GJC_NO_TITLE;
				await h.sdk.setSessionName("Manual", "user");
			}
			const generator = vi.spyOn(titleGenerator, "generateSessionTitle").mockResolvedValue("Unexpected");
			const operation = vi.spyOn(h.sdk, "generateAutoSessionTitle");
			spies.push(generator, operation);
			mockPrompt(h.sdk);
			await h.call("prompt", { sessionId: h.session.id, text: "first" });
			expect(await operation.mock.results[0]!.value).toEqual({ kind: "skipped", reason });
			delete process.env.GJC_NO_TITLE;
			await h.call("prompt", { sessionId: h.session.id, text: "second" });
			expect(operation).toHaveBeenCalledTimes(1);
			expect(generator).not.toHaveBeenCalled();
			generator.mockRestore();
			operation.mockRestore();
		}
	});

	test("title exceptions are isolated and do not expose their raw text", async () => {
		const h = await fixture();
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockRejectedValue(new Error("secret-provider-token"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		spies.push(title, error);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "first text" });
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
		expect(JSON.stringify(error.mock.calls)).not.toContain("secret-provider-token");
		expect(h.snapshot().deliveries.at(-1)?.disposition).toBe("unknown");
	});

	test("transformed input reaches the SDK and a failed title leaves delivery unchanged", async () => {
		const h = await fixture(() => ({ text: "transformed" }));
		const title = vi.spyOn(h.sdk, "generateAutoSessionTitle").mockResolvedValue({ kind: "failed" });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		spies.push(title, error);
		mockPrompt(h.sdk);
		await h.call("prompt", { sessionId: h.session.id, text: "original" });
		expect(title).toHaveBeenCalledTimes(1);
		expect(title.mock.calls[0]?.[0]).toBe("transformed");
		expect(h.snapshot().sessions[0]?.title).toBe("New session");
		expect(h.snapshot().deliveries.at(-1)?.disposition).toBe("unknown");
		expect(error).toHaveBeenCalledWith("Desktop automatic session title generation failed");
	});
});

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareDesktopEnvironment } from "../../desktop-host/src/environment-policy";
import type {
	DesktopAuthProvider,
	DesktopCommand,
	DesktopCommandResult,
	DesktopDiff,
	DesktopFrame,
	DesktopHistory,
	DesktopMethod,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
} from "../../desktop-host/src/protocol";

test("shared policy preserves installation roots across entrypoint and host initialization", () => {
	const home = path.join(os.tmpdir(), "desktop-policy-terminal");
	const agent = path.join(home, "selected-agent");
	const dataDir = path.join(os.tmpdir(), "desktop-policy-app");
	const environment: Record<string, string | undefined> = {
		HOME: home,
		GJC_DESKTOP_AGENT_DIR: agent,
		GJC_CODING_AGENT_DIR: path.join(home, "inherited-agent"),
		GJC_CONFIG_DIR: ".custom-gjc",
		XDG_CONFIG_HOME: path.join(home, "xdg-config"),
		OPENAI_API_KEY: "inherited-secret",
		GJC_AUTH_BROKER_TOKEN: "inherited-broker",
		GJC_DESKTOP_TRACE: "1",
	};
	expect(prepareDesktopEnvironment(environment, dataDir)).toBe(agent);
	expect(environment.HOME).toBe(home);
	expect(environment.GJC_CONFIG_DIR).toBe(".custom-gjc");
	expect(environment.XDG_CONFIG_HOME).toBe(path.join(home, "xdg-config"));
	expect(environment.GJC_DESKTOP_TRACE).toBe("1");
	expect(environment.OPENAI_API_KEY).toBeUndefined();
	expect(environment.GJC_AUTH_BROKER_TOKEN).toBeUndefined();
	const first = { ...environment };
	expect(prepareDesktopEnvironment(environment, dataDir)).toBe(agent);
	expect(environment).toEqual(first);
});

test("isolated policy rejects inherited installation roots and stays isolated on reuse", () => {
	const dataDir = path.join(os.tmpdir(), "desktop-policy-isolated");
	const environment: Record<string, string | undefined> = {
		HOME: path.join(os.tmpdir(), "terminal-home"),
		GJC_DESKTOP_ISOLATED: "1",
		GJC_DESKTOP_AGENT_DIR: path.join(os.tmpdir(), "terminal-agent"),
		GJC_CONFIG_DIR: ".terminal-config",
		OPENAI_API_KEY: "inherited-secret",
	};
	expect(prepareDesktopEnvironment(environment, dataDir)).toBe(path.join(dataDir, "agent"));
	expect(environment.HOME).toBe(path.join(dataDir, "home"));
	expect(environment.GJC_CONFIG_DIR).toBe(".gjc-desktop");
	expect(environment.XDG_CONFIG_HOME).toBe(path.join(dataDir, "config"));
	expect(environment.GJC_DESKTOP_ISOLATED).toBe("1");
	expect(environment.OPENAI_API_KEY).toBeUndefined();
	const first = { ...environment };
	prepareDesktopEnvironment(environment, dataDir);
	expect(environment).toEqual(first);
});

for (const isolated of [true, false]) {
	test(`real ${isolated ? "isolated" : "shared"} host creates, persists and resumes sessions without provider calls`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-test-"));
		const project = path.join(directory, "project");
		await fs.mkdir(project);
		const terminalHome = path.join(directory, "terminal-home");
		await fs.mkdir(terminalHome);
		const dataAlias = path.join(directory, isolated ? "app-link" : "fresh-app");
		if (isolated) {
			await fs.mkdir(path.join(directory, "app"));
			await fs.symlink(path.join(directory, "app"), dataAlias, process.platform === "win32" ? "junction" : "dir");
		}
		const git = Bun.spawn(["git", "init", "--quiet", project], { stdout: "ignore", stderr: "pipe" });
		expect(await git.exited).toBe(0);
		await Bun.write(path.join(project, "review.txt"), "실제 변경 내용\n");
		const launch = () => {
			const binary = process.env.GJC_DESKTOP_TEST_BINARY;
			const child = Bun.spawn(
				binary ? [binary] : [process.execPath, path.resolve(import.meta.dir, "../../desktop-host/src/index.ts")],
				{
					cwd: directory,
					env: {
						...Bun.env,
						...(binary ? { PATH: "/usr/bin:/bin" } : {}),
						HOME: terminalHome,
						USERPROFILE: terminalHome,
						GJC_DESKTOP_DATA_DIR: dataAlias,
						GJC_DESKTOP_ISOLATED: isolated ? "1" : "0",
						GJC_DESKTOP_AGENT_DIR: path.join(terminalHome, ".gjc", "agent"),
						GJC_CODING_AGENT_DIR: path.join(terminalHome, ".gjc", "agent"),
						PI_CODING_AGENT_DIR: path.join(terminalHome, ".gjc", "agent"),
						GJC_CONFIG_DIR: ".gjc",
						PI_CONFIG_DIR: ".gjc",
						GH_TOKEN: "desktop-isolation-sentinel",
						HF_TOKEN: "desktop-isolation-sentinel",
						AWS_BEARER_TOKEN_KIRO: "desktop-isolation-sentinel",
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
			const stderr = new Response(child.stderr).text();
			const reader = (async () => {
				let buffer = "";
				const decoder = new TextDecoder();
				for await (const chunk of child.stdout) {
					buffer += decoder.decode(chunk, { stream: true });
					while (true) {
						const newline = buffer.indexOf("\n");
						if (newline < 0) break;
						const frame = JSON.parse(buffer.slice(0, newline)) as DesktopFrame;
						buffer = buffer.slice(newline + 1);
						if (frame.type === "response") {
							const pending = waiting.get(frame.id);
							waiting.delete(frame.id);
							if (frame.ok) pending?.resolve(frame.result);
							else pending?.reject(new Error(frame.error));
						}
					}
				}
			})().finally(() => {
				for (const deferred of waiting.values()) deferred.reject(new Error("Host exited before response"));
				waiting.clear();
			});
			const request = async <T>(method: DesktopMethod, params: Record<string, unknown> = {}): Promise<T> => {
				const id = crypto.randomUUID();
				const result = Promise.withResolvers<unknown>();
				waiting.set(id, result);
				child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
				await child.stdin.flush();
				return (await result.promise) as T;
			};
			return { child, reader, stderr, request };
		};
		let host = launch();
		try {
			const initial = await host.request<DesktopSnapshot>("bootstrap");
			expect(initial.sessions).toEqual([]);
			expect(initial.projects).toEqual([]);

			const providers = await host.request<DesktopAuthProvider[]>("auth.providers");
			expect(providers.some(provider => provider.id === "openai-codex")).toBe(true);
			expect(providers.find(provider => provider.id === "github-copilot")?.configured).toBe(false);
			expect(providers.find(provider => provider.id === "kiro")?.configured).toBe(false);
			expect(await host.request("auth.state")).toBeNull();
			await expect(host.request("auth.login", { provider: "not-a-provider" })).rejects.toThrow(
				"Unknown authorization provider",
			);
			await host.request("project.open", { path: project });
			const snapshot = await host.request<DesktopSnapshot>("bootstrap");
			expect(snapshot.projects[0]?.path).toBe(await fs.realpath(project));
			const session = await host.request<DesktopSession>("session.create", { projectId: snapshot.projects[0]!.id });
			expect(session.status).toBe("idle");
			// The app palette is driven by the SDK's own advertised builtin commands.
			const commands = await host.request<DesktopCommand[]>("command.list");
			expect(commands.some(command => command.name === "tools")).toBe(true);
			expect(commands.some(command => command.name === "help")).toBe(false);
			// A headless builtin runs in-process and never reaches a provider.
			const tools = await host.request<DesktopCommandResult>("command.run", {
				sessionId: session.id,
				text: "/tools",
			});
			expect(tools.consumed).toBe(true);
			expect(tools.output).toContain("read");
			expect(tools.prompt).toBeUndefined();
			// Job observation reaches the app through the same dispatcher.
			const jobs = await host.request<DesktopCommandResult>("command.run", { sessionId: session.id, text: "/jobs" });
			expect(jobs.consumed).toBe(true);
			expect(jobs.output).toContain("No background jobs running");
			// Session lifecycle is catalog-owned: these commands refuse instead of
			// half-applying and leaving an unreopenable transcript.
			for (const text of ["/move /tmp", "/session delete", "/handoff", "/rename x", "/star"]) {
				const refused = await host.request<DesktopCommandResult>("command.run", { sessionId: session.id, text });
				expect(refused.refused).toBe(true);
				expect(refused.consumed).toBe(false);
				expect(refused.output).not.toBe("");
			}
			// Refusal copy is per command: it names the control that actually exists.
			const renameRefusal = await host.request<DesktopCommandResult>("command.run", {
				sessionId: session.id,
				text: "/rename 제목",
			});
			expect(renameRefusal.output).toContain("이름 변경");
			// Refusal copy must not point at a menu the app does not have.
			for (const text of ["/move /tmp", "/session delete", "/rename x"]) {
				const refused = await host.request<DesktopCommandResult>("command.run", { sessionId: session.id, text });
				expect(refused.output).not.toContain("대화 메뉴");
			}
			// The palette can only offer commands the host will actually run.
			const catalog = await host.request<{ name: string }[]>("command.list");
			for (const name of ["move", "session", "handoff", "rename"]) {
				expect(catalog.some(command => command.name === name)).toBe(false);
			}
			// Unknown slash text is refused, never sent to a provider as a prompt.
			const unknown = await host.request<DesktopCommandResult>("command.run", {
				sessionId: session.id,
				text: "/not-a-real-command",
			});
			expect(unknown.consumed).toBe(false);
			expect(unknown.refused).toBe(true);
			expect(unknown.prompt).toBeUndefined();
			expect(unknown.output).toContain("사용할 수 없습니다");
			// Queue cancellation is only valid for an input this session still owns.
			await expect(
				host.request("queue.cancel", { sessionId: session.id, queueId: "queued-missing" }),
			).rejects.toThrow("Queued input not found");
			const history = await host.request<DesktopHistory>("history.get", { sessionId: session.id, limit: 50 });
			expect(history.sessionId).toBe(session.id);
			expect(history.total).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(history.messages)).toBe(true);
			const settings = await host.request<DesktopSetting[]>("settings.get", { sessionId: session.id });
			expect(settings.length).toBeGreaterThan(2);
			expect(settings.some(item => item.path === "compaction.enabled")).toBe(true);
			expect(settings.every(item => ["boolean", "number", "enum"].includes(item.type))).toBe(true);
			await expect(
				host.request("settings.set", { path: "theme.dark", value: "red-claw", sessionId: session.id }),
			).rejects.toThrow("Setting is not editable from the desktop host");
			await host.request("settings.set", { path: "retry.maxRetries", value: 2, sessionId: session.id });
			const updated = await host.request<DesktopSetting[]>("settings.get", { sessionId: session.id });
			expect(updated.find(item => item.path === "retry.maxRetries")?.value).toBe(2);
			// A durable host can persist app-effective settings...
			expect(updated.find(item => item.path === "retry.maxRetries")?.writable).toBe(true);
			// ...but notification delivery is terminal/host-owned, so it stays read-only.
			const notificationSettings = updated.filter(item => item.path.startsWith("notification"));
			expect(notificationSettings.length).toBeGreaterThan(0);
			expect(notificationSettings.every(item => item.writable === false)).toBe(true);
			const deferred = await host.request<DesktopSetting[]>("settings.get", {});
			expect(deferred.find(item => item.path === "retry.maxRetries")?.writable).toBe(true);
			const diff = await host.request<DesktopDiff[]>("diff.get", { sessionId: session.id });
			expect(diff.find(file => file.path === "review.txt")?.patch).toContain("+실제 변경 내용");
			await host.request("session.rename", { sessionId: session.id, title: "한국어 작업" });
			await host.request("session.star", { sessionId: session.id, starred: true });
			await expect(
				host.request("question.answer", { sessionId: session.id, questionId: crypto.randomUUID(), value: true }),
			).rejects.toThrow();
			await host.request("shutdown");
			expect(await host.child.exited).toBe(0);
			await host.reader;
			host = launch();
			const restored = await host.request<DesktopSnapshot>("bootstrap");
			expect(restored.sessions[0]?.title).toBe("한국어 작업");
			expect(restored.sessions[0]?.starred).toBe(true);
			const resumed = await host.request<DesktopSession>("session.select", { sessionId: session.id });
			expect(resumed.id).toBe(session.id);
			const persistedCatalog: { sessions: { id: string; file: string }[] } = await Bun.file(
				path.join(dataAlias, "catalog.json"),
			).json();
			const saved = persistedCatalog.sessions.find(item => item.id === session.id);
			if (!saved) throw new Error("Session missing from persisted catalog");
			const transcript = path.join(await fs.realpath(dataAlias), "sessions", saved.file);
			const artifacts = transcript.slice(0, -6);
			const sidecar = `${transcript}.spill.capture-test`;
			const unrelated = path.join(path.dirname(transcript), "unrelated.keep");
			await Bun.write(path.join(artifacts, "owned.txt"), "session artifact");
			await Bun.write(sidecar, "derived capture");
			await Bun.write(unrelated, "keep");
			await host.request("session.delete", { sessionId: session.id });
			expect(await Bun.file(transcript).exists()).toBe(false);
			expect(await Bun.file(path.join(artifacts, "owned.txt")).exists()).toBe(false);
			expect(await Bun.file(sidecar).exists()).toBe(false);
			expect(await Bun.file(unrelated).text()).toBe("keep");
			expect((await host.request<DesktopSnapshot>("bootstrap")).sessions).toEqual([]);
			await host.request("shutdown");
			expect(await host.child.exited).toBe(0);
			await host.reader;
		} catch (error) {
			host.child.kill();
			await host.child.exited;
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await host.stderr}`);
		} finally {
			host.child.kill();
			await host.child.exited;
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 60_000);
}

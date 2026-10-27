import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

test("real isolated host creates, persists and resumes sessions without provider calls", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-test-"));
	const project = path.join(directory, "project");
	await fs.mkdir(project);
	await fs.mkdir(path.join(directory, "app"));
	const dataAlias = path.join(directory, "app-link");
	await fs.symlink(path.join(directory, "app"), dataAlias, process.platform === "win32" ? "junction" : "dir");
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
					GJC_DESKTOP_DATA_DIR: dataAlias,
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
		// Queue cancellation is only valid for an input this session still owns.
		await expect(host.request("queue.cancel", { sessionId: session.id, queueId: "queued-missing" })).rejects.toThrow(
			"Queued input not found",
		);
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

import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import * as utils from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { captureRepositoryBinding } from "../src/gjc-runtime/repository-binding";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { createAgentSession } from "../src/sdk";
import { ArtifactManager } from "../src/session/artifacts";
import { SessionManager } from "../src/session/session-manager";
import { AgentOutputManager, TaskTool } from "../src/task";
import type { ExecutorOptions } from "../src/task/executor";
import type { TaskScopeAuthority } from "../src/task/scope";
import type { SingleResult, TaskItem, TaskToolSchemaInstance } from "../src/task/types";
import type { Tool, ToolSession } from "../src/tools";
import { BUILTIN_TOOL_DESCRIPTORS, LazyAgentTool } from "../src/tools/descriptors";

const roots: string[] = [];
const managers: AsyncJobManager[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stdout}${stderr}`);
}

async function harness(isolated = false) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-scope-")));
	roots.push(root);
	const a = path.join(root, "workspace");
	const b = isolated ? path.join(root, "repo") : path.join(a, "repo");
	const home = path.join(root, "profile");
	await fs.mkdir(home);
	for (const [cwd, marker] of [
		[a, "A"],
		[b, "B"],
	]) {
		await fs.mkdir(path.join(cwd!, ".gjc", "agents"), { recursive: true });
		await Bun.write(path.join(cwd!, "marker.txt"), marker!);
		await Bun.write(path.join(cwd!, "AGENTS.md"), `Original ${marker} instructions`);
		await Bun.write(
			path.join(cwd!, ".gjc", "prompts", "scope-template.md"),
			`---\ndescription: ${marker} template\n---\nTemplate ${marker} instructions.`,
		);
		await Bun.write(
			path.join(cwd!, ".gjc", "skills", "scope-skill", "SKILL.md"),
			`---\nname: scope-skill\ndescription: ${marker} skill\n---\nSkill ${marker} instructions.`,
		);
		await Bun.write(path.join(cwd!, ".gjc", "config.yml"), "task:\n  maxConcurrency: 1\n");
		await Bun.write(
			path.join(cwd!, ".gjc", "agents", "scope-probe.md"),
			`---\nname: scope-probe\ndescription: ${marker} scope\n---\nUse ${marker} scope only.\n`,
		);
	}
	await git(b, ["init"]);
	await git(b, ["-c", "user.name=Task Scope", "-c", "user.email=scope@example.test", "add", "."]);
	await git(b, ["-c", "user.name=Task Scope", "-c", "user.email=scope@example.test", "commit", "-m", "fixture"]);
	if (isolated) {
		vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(root, "isolation", segment));
		await git(a, ["init"]);
		await Bun.write(path.join(a, ".gitignore"), "repo/\n");
		await git(a, ["add", "."]);
		await git(a, ["-c", "user.name=Task Scope", "-c", "user.email=scope@example.test", "commit", "-m", "fixture A"]);
	}
	const sourceSettings = await Settings.loadReadonly({ cwd: a, agentDir: home });
	const targetSettings = await Settings.loadReadonly({ cwd: b, agentDir: home });
	for (const settings of [sourceSettings, targetSettings]) {
		settings.override("task.isolation.mode", isolated ? "rcopy" : "none");
		settings.override("task.isolation.merge", "patch");
		settings.override("task.enableLsp", false);
		settings.override("irc.enabled", false);
	}
	const sessionManager = SessionManager.inMemory(a);
	const jobs = new AsyncJobManager({ onJobComplete: async () => {} });
	managers.push(jobs);
	const artifacts = new ArtifactManager(path.join(root, "outputs"));
	await fs.mkdir(artifacts.dir);
	const allocator = new AgentOutputManager(() => artifacts.dir, { getAuthorizedArtifactsDirs: () => [artifacts.dir] });
	let drift: string | undefined;
	const session: ToolSession & TaskScopeAuthority = {
		get cwd() {
			return drift ?? sessionManager.getCwd();
		},
		hasUI: false,
		home,
		settings: sourceSettings,
		contextFiles: [{ path: path.join(a, "AGENTS.md"), content: "Original A instructions" }],
		getTaskScopeIdentity: () => ({ cwd: sessionManager.getCwd(), generation: sessionManager.getCwdGeneration() }),
		runWithTaskAdmission: admit => sessionManager.runWithCwdReadLease(admit),
		getSessionFile: () => null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionSpawns: () => "*",
		getAgentId: () => "0-Main",
		getAsyncJobManager: () => jobs,
		getArtifactsDir: () => artifacts.dir,
		getAuthorizedArtifactsDirs: () => [artifacts.dir],
		getArtifactManager: () => artifacts,
		isArtifactManagerAuthorized: candidate => candidate === artifacts,
		agentOutputManager: allocator,
	};
	sessionManager.registerAfterMoveListener(() => {
		session.settings = targetSettings;
		session.contextFiles = [{ path: path.join(b, "AGENTS.md"), content: "Original B instructions" }];
	});
	return {
		root,
		a,
		b,
		home,
		session,
		sessionManager,
		jobs,
		artifacts,
		allocator,
		sourceSettings,
		targetSettings,
		setDrift: (cwd?: string) => {
			drift = cwd;
		},
	};
}

function task(id: string, extra: Partial<TaskItem> = {}): TaskItem {
	return { id, description: id, assignment: `Read the admitted marker for ${id}.`, ...extra };
}

async function complete(options: ExecutorOptions, extra: Partial<SingleResult> = {}): Promise<SingleResult> {
	const output = await Bun.file(path.join(options.cwd, "marker.txt")).text();
	if (options.artifactsDir) {
		const outputPath = path.join(options.artifactsDir, `${options.id}.md`);
		await Bun.write(outputPath, output);
		await Bun.write(
			`${outputPath}.meta.json`,
			JSON.stringify({
				id: options.id,
				kind: "agent-output",
				createdAt: new Date().toISOString(),
				sizeBytes: Buffer.byteLength(output),
				lineCount: 1,
				sha256: createHash("sha256").update(output).digest("hex"),
			}),
		);
	}
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		...extra,
	};
}

async function start(tool: Tool, tasks: TaskItem[], signal?: AbortSignal, isolated = false) {
	return tool.execute(
		"scope-admission",
		{ agent: "scope-probe", tasks, ...(isolated ? { isolated: true } : {}) },
		signal,
	);
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map(manager => manager.dispose({ timeoutMs: 100 })));
	InternalUrlRouter.resetForTests();
	await Promise.all(roots.splice(0).map(root => safeRm(root, { recursive: true, force: true })));
});

describe("task admission after trusted committed moves", () => {
	for (const state of ["eager", "unused-lazy", "discovery-only", "warmed"] as const) {
		it(`executes B using a ${state} task facade and preserves the output allocator`, async () => {
			const h = await harness();
			const seen: ExecutorOptions[] = [];
			const load = () =>
				TaskTool.create(h.session, {
					runSubprocess: async options => {
						seen.push(options);
						return complete(options);
					},
				});
			const tool =
				state === "eager"
					? await load()
					: new LazyAgentTool(BUILTIN_TOOL_DESCRIPTORS.task, undefined, load, h.session);
			if (state === "discovery-only") {
				expect(tool.description).toContain("Launches subagents");
				expect(tool.parameters).toBeDefined();
			}
			if (state === "warmed") {
				await start(tool, [task("Before")]);
				await h.jobs.waitForAll();
			}
			await h.sessionManager.moveTo(h.b);
			await start(tool, [task("After")]);
			await h.jobs.waitForAll();
			const last = seen.at(-1)!;
			expect(last.cwd).toBe(h.b);
			expect(last.agent.systemPrompt).toContain("Use B scope only");
			expect(last.contextFiles?.[0].content).toBe("Original B instructions");
			expect(last.settings?.getCwd()).toBe(h.b);
			expect(last.settings?.getAgentDir()).toBe(h.home);
			expect(last.parentArtifactManager).toBe(h.artifacts);
			expect(h.session.agentOutputManager).toBe(h.allocator);
			expect(last.id).toBe(state === "warmed" ? "1-After" : "0-After");
			expect(await Bun.file(path.join(h.artifacts.dir, `${last.id}.md`)).text()).toBe("B");
		});
	}

	it("updates an unused discovery facade without materializing it or changing parent settings", async () => {
		const h = await harness();
		h.targetSettings.override("task.simple", "independent");
		h.session.getTaskScopeSettings = () =>
			h.sessionManager.getCwdGeneration() === 0 ? h.sourceSettings : h.targetSettings;
		const load = vi.fn(() => TaskTool.create(h.session, { runSubprocess: complete }));
		const tool = new LazyAgentTool(BUILTIN_TOOL_DESCRIPTORS.task, undefined, load, h.session);
		await h.sessionManager.moveTo(h.b);
		h.session.settings = h.sourceSettings;
		expect(
			(tool.parameters as TaskToolSchemaInstance).safeParse({
				agent: "scope-probe",
				tasks: [task("Metadata", { inheritContext: "receipt" })],
			}).success,
		).toBe(false);
		expect(tool.description).toContain("independent mode cannot inherit");
		expect(load).not.toHaveBeenCalled();
		await start(tool, [task("LazyTarget")]);
		await h.jobs.waitForAll();
		expect(load).toHaveBeenCalledTimes(1);
		expect(h.jobs.getJob("0-LazyTarget")?.status).toBe("completed");
	});

	it("recovers target admission after a cached first worker fails", async () => {
		const h = await harness();
		const seen: ExecutorOptions[] = [];
		const tool = await TaskTool.create(h.session, {
			runSubprocess: async options => {
				seen.push(options);
				return complete(options, seen.length === 1 ? { exitCode: 1, error: "initial failure" } : {});
			},
		});
		const first = await start(tool, [task("Failed")]);
		await h.jobs.waitForAll();
		expect(h.jobs.getJob(first.details!.async!.jobId)?.status).toBe("failed");
		await h.sessionManager.moveTo(h.b);
		await start(tool, [task("Recovered")]);
		await h.jobs.waitForAll();
		expect(seen.map(options => options.cwd)).toEqual([h.a, h.b]);
		expect(seen.map(options => options.id)).toEqual(["0-Failed", "1-Recovered"]);
	});

	for (const commit of [true, false]) {
		it(`allocates nothing until a concurrent move ${commit ? "commits B" : "fails in A"}`, async () => {
			const h = await harness();
			const seen: ExecutorOptions[] = [];
			const tool = await TaskTool.create(h.session, {
				runSubprocess: async options => {
					seen.push(options);
					return complete(options);
				},
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const allocate = vi.spyOn(h.allocator, "allocateBatch");
			const move = h.sessionManager
				.runExclusiveCwdMoveTransition(async () => {
					entered.resolve();
					await release.promise;
					if (commit) await h.sessionManager.moveTo(h.b);
					else throw new Error("move preparation failed");
				})
				.catch(error => error as Error);
			await entered.promise;
			const pending = start(tool, [task("Waiting", { duplicate_policy: "supersede" })]);
			await Bun.sleep(10);
			expect(allocate).not.toHaveBeenCalled();
			expect(seen).toHaveLength(0);
			release.resolve();
			const outcome = await move;
			if (!commit)
				expect(outcome instanceof Error ? outcome.message : "unexpected commit").toBe("move preparation failed");
			await pending;
			await h.jobs.waitForAll();
			expect(seen[0]?.cwd).toBe(commit ? h.b : h.a);
			expect(seen[0]?.id).toBe("0-Waiting");
		});
	}

	it("rejects cancelled admission before allocation after the move writer drains", async () => {
		const h = await harness();
		const tool = await TaskTool.create(h.session, { runSubprocess: complete });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const move = h.sessionManager.runExclusiveCwdMoveTransition(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const allocate = vi.spyOn(h.allocator, "allocateBatch");
		const controller = new AbortController();
		const pending = start(tool, [task("Cancelled")], controller.signal);
		controller.abort(new Error("cancelled admission"));
		release.resolve();
		await move;
		await expect(pending).rejects.toThrow("cancelled admission");
		expect(allocate).not.toHaveBeenCalled();
		expect(h.jobs.getSubagentRecords()).toEqual([]);
	});

	it("retains running queued and resumed A work while B admits new work and refreshes agents", async () => {
		const h = await harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: ExecutorOptions[] = [];
		const tool = await TaskTool.create(h.session, {
			runSubprocess: async options => {
				seen.push(options);
				if (options.id === "0-Running" && !options.runMode) {
					entered.resolve();
					await release.promise;
					return complete(options, { paused: true });
				}
				return complete(options);
			},
		});
		await start(tool, [task("Running"), task("Queued")]);
		await entered.promise;
		h.sourceSettings.override("task.disabledAgents", ["scope-probe"]);
		h.session.contextFiles![0]!.content = "mutated parent A instructions";
		await Bun.write(
			path.join(h.a, ".gjc", "agents", "scope-probe.md"),
			"---\nname: scope-probe\ndescription: changed\n---\nMutated A agent.\n",
		);
		await h.sessionManager.moveTo(h.b);
		await start(tool, [task("New")]);
		release.resolve();
		await h.jobs.waitForAll();
		expect(h.jobs.resumeSubagent("0-Running", { ownerId: "0-Main" }, "continue A").ok).toBe(true);
		await h.jobs.waitForAll();
		for (const options of seen.filter(options => options.id === "1-Queued" || options.runMode === "message")) {
			expect(options.cwd).toBe(h.a);
			expect(options.agent.systemPrompt).toContain("Use A scope only");
			expect(options.contextFiles?.[0].content).toBe("Original A instructions");
			expect(options.settings?.get("task.disabledAgents")).not.toContain("scope-probe");
			expect(options.settings?.getCwd()).toBe(h.a);
			expect(options.parentArtifactManager).toBe(h.artifacts);
		}
		expect(seen.filter(options => options.id === "0-Running")).toHaveLength(2);
		expect(seen.find(options => options.id === "2-New")?.cwd).toBe(h.b);
		const output = await InternalUrlRouter.instance().resolve("agent://0-Running", {
			cwd: h.b,
			getArtifactsDir: () => h.artifacts.dir,
			getAuthorizedArtifactsDirs: () => [h.artifacts.dir],
		});
		expect(output.content).toBe("A");
		await Bun.write(
			path.join(h.b, ".gjc", "agents", "scope-probe.md"),
			"---\nname: scope-probe\ndescription: refreshed\n---\nRefreshed B agent.\n",
		);
		await start(tool, [task("Refresh")]);
		await h.jobs.waitForAll();
		expect(seen.at(-1)?.agent.systemPrompt).toContain("Refreshed B agent");
	});

	it("rejects arbitrary cwd drift and foreign payloads before ID or job allocation", async () => {
		const h = await harness();
		const tool = await TaskTool.create(h.session, { runSubprocess: complete });
		const allocate = vi.spyOn(h.allocator, "allocateBatch");
		const register = vi.spyOn(h.jobs, "register");
		h.setDrift(h.b);
		expect(text(await start(tool, [task("Drift")]))).toContain("binding rejected before task discovery");
		h.setDrift();
		const bindingA = await captureRepositoryBinding(h.a);
		await h.sessionManager.moveTo(h.b);
		expect(text(await start(tool, [task("Foreign", { repositoryBinding: bindingA })]))).toContain(
			"repository binding",
		);
		expect(allocate).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
		await start(tool, [task("Valid")]);
		await h.jobs.waitForAll();
		expect(allocate.mock.calls[0]?.[0]).toEqual(["Valid"]);
	});

	it("does not recapture authority for callers without trusted scope hooks", async () => {
		const h = await harness();
		delete h.session.getTaskScopeIdentity;
		delete h.session.runWithTaskAdmission;
		const tool = await TaskTool.create(h.session, { runSubprocess: complete });
		const allocate = vi.spyOn(h.allocator, "allocateBatch");
		await h.sessionManager.moveTo(h.b);
		expect(text(await start(tool, [task("Untrusted")]))).toContain("binding rejected before task discovery");
		expect(allocate).not.toHaveBeenCalled();
	});

	it("serializes lazy construction with an already admitted move", async () => {
		const h = await harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const move = h.sessionManager.runExclusiveCwdMoveTransition(async () => {
			entered.resolve();
			await release.promise;
			await h.sessionManager.moveTo(h.b);
		});
		await entered.promise;
		const seen: ExecutorOptions[] = [];
		const creating = TaskTool.create(h.session, {
			runSubprocess: async options => {
				seen.push(options);
				return complete(options);
			},
		});
		release.resolve();
		await move;
		const tool = await creating;
		await start(tool, [task("CreatedAfterMove")]);
		await h.jobs.waitForAll();
		expect(seen[0]?.cwd).toBe(h.b);
	});

	it("retains isolated A persistence after the parent moves to B", async () => {
		const h = await harness(true);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: ExecutorOptions[] = [];
		const tool = await TaskTool.create(h.session, {
			runSubprocess: async options => {
				seen.push(options);
				entered.resolve();
				await release.promise;
				if (!options.worktree) throw new Error("Expected rcopy isolation");
				await Bun.write(path.join(options.worktree, "isolated.txt"), "Admitted A change");
				return complete(options);
			},
		});
		await start(tool, [task("IsolatedA")], undefined, true);
		await entered.promise;
		await h.sessionManager.moveTo(h.b);
		release.resolve();
		await h.jobs.waitForAll();
		expect(seen[0]?.cwd).toBe(h.a);
		const job = h.jobs.getJob("0-IsolatedA");
		expect({ status: job?.status, result: job?.resultText, error: job?.errorText }).toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		expect(await Bun.file(path.join(h.a, "isolated.txt")).text()).toBe("Admitted A change");
		expect(await Bun.file(path.join(h.b, "isolated.txt")).exists()).toBe(false);
		expect(h.jobs.getJob("0-IsolatedA")?.status).toBe("completed");
	});

	it("rejects a resume after the admission's logical session is retired", async () => {
		const h = await harness();
		const worker = vi.fn(complete);
		const tool = await TaskTool.create(h.session, { runSubprocess: worker });
		await start(tool, [task("OldLogical")]);
		await h.jobs.waitForAll();
		const previousId = h.sessionManager.getSessionId();
		await h.sessionManager.newSession();
		expect(h.sessionManager.getSessionId()).not.toBe(previousId);
		expect(h.jobs.resumeSubagent("0-OldLogical", { ownerId: "0-Main" }, "retired").ok).toBe(true);
		await h.jobs.waitForAll();
		expect(worker).toHaveBeenCalledTimes(1);
		expect(h.jobs.getSubagentRecords().find(record => record.subagentId === "0-OldLogical")?.status).toBe("failed");
	});

	it("copies project, global and runtime settings without writes or mutable aliases", async () => {
		const h = await harness();
		h.sourceSettings.override("task.disabledAgents", ["before"]);
		const config = path.join(h.a, ".gjc", "config.yml");
		const before = await Bun.file(config).text();
		const snapshot = h.sourceSettings.snapshot();
		h.sourceSettings.override("task.disabledAgents", ["after"]);
		snapshot.override("task.maxConcurrency", 9);
		expect(snapshot.get("task.disabledAgents")).toEqual(["before"]);
		expect(h.sourceSettings.get("task.maxConcurrency")).toBe(1);
		expect(snapshot.getCwd()).toBe(h.a);
		expect(snapshot.getAgentDir()).toBe(h.home);
		expect(await Bun.file(config).text()).toBe(before);
	});

	for (const surface of ["agent", "SDK"] as const) {
		it(`wires eager task settings and resources through a real ${surface} move`, async () => {
			const h = await harness();
			const targetConfig = "task:\n  maxConcurrency: 2\n  simple: independent\nask:\n  timeout: 60000\n";
			await Bun.write(path.join(h.b, ".gjc", "config.yml"), targetConfig);
			const preview = await h.sourceSettings.snapshotForCwd(h.b);
			expect({
				mode: preview.get("task.simple"),
				concurrency: preview.get("task.maxConcurrency"),
				timeout: preview.get("ask.timeout"),
			}).toEqual({ mode: "independent", concurrency: 2, timeout: 60 });
			const seen: ExecutorOptions[] = [];
			const create = TaskTool.create;
			vi.spyOn(TaskTool, "create").mockImplementation((session, options) =>
				create(session, {
					...options,
					runSubprocess: async worker => {
						seen.push(worker);
						return complete(worker);
					},
				}),
			);
			const { session } = await createAgentSession({
				cwd: h.a,
				agentDir: h.home,
				sessionManager: h.sessionManager,
				settings: h.sourceSettings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				slashCommands: [],
				enableMCP: false,
				enableMcpAutoload: false,
				enableLsp: false,
				toolNames: ["task", "move_session", "read"],
			});
			try {
				const taskTool = session.getToolByName("task")!;
				expect(
					text(await taskTool.execute("warm-failure", { agent: "missing-scope-agent", tasks: [task("Warm")] })),
				).toContain("Unknown agent");
				const jobs = AsyncJobManager.instance();
				if (!jobs) throw new Error("Expected the SDK-owned async manager");
				await start(taskTool, [task("SDKSource")]);
				await jobs.waitForAll();
				expect(seen[0]?.cwd).toBe(h.a);
				if (surface === "agent") {
					expect(text(await session.getToolByName("move_session")!.execute("move", { path: "repo" }))).toContain(
						h.b,
					);
				} else {
					await h.sessionManager.moveTo(h.b);
				}
				expect(
					(taskTool.parameters as TaskToolSchemaInstance).safeParse({
						agent: "scope-probe",
						tasks: [task("Metadata", { inheritContext: "receipt" })],
					}).success,
				).toBe(false);
				const started = await start(taskTool, [task("SDKTarget")]);
				expect(text(started)).toContain("background task");
				await jobs.waitForAll();
				expect(seen[1]?.cwd).toBe(h.b);
				expect(seen[1]?.agent.systemPrompt).toContain("Use B scope only");
				expect(seen[1]?.contextFiles?.some(file => file.content.includes("Original B instructions"))).toBe(true);
				expect(seen[1]?.settings?.getCwd()).toBe(h.b);
				expect(seen[1]?.settings?.get("task.maxConcurrency")).toBe(2);
				expect(seen[1]?.settings?.get("ask.timeout")).toBe(60);
				expect(seen[1]?.promptTemplates?.find(template => template.name === "scope-template")?.content).toContain(
					"Template B",
				);
				expect(seen[1]?.skills?.find(skill => skill.name === "scope-skill")?.filePath).toContain(h.b);
				expect(h.sourceSettings.getCwd()).toBe(h.a);
				expect(await Bun.file(path.join(h.b, ".gjc", "config.yml")).text()).toBe(targetConfig);
				expect(seen.map(options => options.id)).toEqual(["0-SDKSource", "1-SDKTarget"]);
				const priorOutput = await session
					.getToolByName("read")!
					.execute("prior-output", { path: "agent://0-SDKSource" });
				expect(text(priorOutput)).toContain("A");
				const previousId = h.sessionManager.getSessionId();
				expect(await session.newSession()).toBe(true);
				expect(h.sessionManager.getSessionId()).not.toBe(previousId);
				await start(taskTool, [task("FreshLogicalSession")]);
				await jobs.waitForAll();
				expect(seen.at(-1)?.cwd).toBe(h.b);
				expect(seen.at(-1)?.id).toBe("2-FreshLogicalSession");
				expect(seen.at(-1)?.parentSessionId).toBe(h.sessionManager.getSessionId());
				expect(seen.at(-1)?.artifactsDir).not.toBe(seen[1]?.artifactsDir);
			} finally {
				await session.dispose();
			}
		}, 30_000);
	}
});

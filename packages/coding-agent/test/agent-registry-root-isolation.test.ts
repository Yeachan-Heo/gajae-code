import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	InternalUrlRouter,
	initializeLocalRoot,
	LocalProtocolHandler,
	type LocalProtocolOptions,
	resolveLocalRoot,
} from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession, planOccupiedAgentId } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { IrcTool } from "@gajae-code/coding-agent/tools/irc";
import { getAgentDir, getMemoriesDir, Snowflake, setAgentDir } from "@gajae-code/utils";
import fc from "fast-check";

const tempDirs: string[] = [];

function makePaths(): { cwd: string; agentDir: string } {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `sdk-root-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return { cwd, agentDir: path.join(tempDir, "agent") };
}

function stubReply(session: AgentSession, text: string): void {
	const target = session as unknown as {
		respondAsBackground: () => Promise<{ replyText: string | null }>;
	};
	target.respondAsBackground = async () => ({ replyText: text });
}

function ircFrom(registry: AgentRegistry, senderId: string): IrcTool {
	const toolSession: ToolSession = {
		cwd: makePaths().cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => senderId,
	};
	return new IrcTool(toolSession);
}

function memoryRootFor(agentDir: string, cwd: string): string {
	const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getMemoriesDir(agentDir), encoded);
}

function writeMemoryFile(agentDir: string, cwd: string, name: string, body: string): void {
	const root = memoryRootFor(agentDir, cwd);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, name), body);
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

/** The local:// root this session resolves inside. */
function localRootOf(session: AgentSession): string {
	return resolveLocalRoot({
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		isManagedDestination: () => session.sessionManager.isManagedDestination(),
		getSessionId: () => session.sessionManager.getSessionId(),
	});
}

function writeLocalFile(root: string, name: string, body: string): void {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, name), body);
}

function managedScratchOptions(sessionId: string): LocalProtocolOptions {
	return {
		getArtifactsDir: () => null,
		isManagedDestination: () => true,
		getSessionId: () => sessionId,
	};
}

async function runSessionTool(
	session: AgentSession,
	name: string,
	params: Record<string, unknown>,
): Promise<{ content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown }> {
	const tool = session.getToolByName(name);
	if (!tool) throw new Error(`${name} tool missing`);
	return tool.execute(`${name}-memory`, params) as Promise<{
		content: ReadonlyArray<{ type: string; text?: string }>;
		details?: unknown;
	}>;
}

async function openScopedRoot(cwd: string, agentDir: string) {
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const settings = await Settings.loadForScope({ cwd, agentDir });
	return createAgentSession({
		cwd,
		agentDir,
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
}

async function openRoot(extra: Record<string, unknown> = {}) {
	const paths = makePaths();
	const isolatedAgent = path.join(path.dirname(paths.cwd), "isolated-agent");
	fs.mkdirSync(isolatedAgent, { recursive: true });
	const previousAgentDir = getAgentDir();
	setAgentDir(isolatedAgent);
	try {
		return await createAgentSession({
			...paths,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...extra,
		});
	} finally {
		setAgentDir(previousAgentDir);
	}
}

describe("root agent id claim", () => {
	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("property: occupied id plan, fc.property seed 17091, numRuns 64", async () => {
		fc.assert(
			fc.property(fc.boolean(), fc.boolean(), (explicitAgentId, explicitRegistry) => {
				const plan = planOccupiedAgentId({ explicitAgentId, explicitRegistry });
				if (explicitAgentId) return plan === "reject";
				if (!explicitRegistry) return plan === "private-registry";
				return plan === "remint";
			}),
			{ seed: 17091, numRuns: 64 },
		);
	});
});

describe("createAgentSession root registry", () => {
	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps the only default root on 0-Main", async () => {
		const opened = await openRoot();
		try {
			stubReply(opened.session, "only-root");
			expect(opened.session.getAgentId()).toBe(MAIN_AGENT_ID);
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(opened.session);
			const result = await ircFrom(AgentRegistry.global(), "1-peer").execute("only", {
				op: "send",
				to: MAIN_AGENT_ID,
				message: "ping",
			});
			expect(result.details?.replies?.[0]?.text).toBe("only-root");
		} finally {
			await opened.session.dispose();
		}
	}, 60_000);

	it("keeps two explicit ids on one shared registry", async () => {
		const registry = new AgentRegistry();
		const first = await openRoot({ agentRegistry: registry, agentId: "root-a" });
		const second = await openRoot({ agentRegistry: registry, agentId: "root-b" });
		try {
			stubReply(first.session, "reply-a");
			stubReply(second.session, "reply-b");
			expect(registry.get("root-a")?.session).toBe(first.session);
			expect(registry.get("root-b")?.session).toBe(second.session);
			const result = await ircFrom(registry, "root-a").execute("peers", {
				op: "send",
				to: "root-b",
				message: "ping",
			});
			expect(result.details?.replies?.[0]?.text).toBe("reply-b");
		} finally {
			await second.session.dispose();
			await first.session.dispose();
		}
	}, 60_000);

	it("routes 0-Main to the first default root after a second root starts", async () => {
		const first = await openRoot();
		const second = await openRoot();
		let secondDisposed = false;
		try {
			stubReply(first.session, "reply-from-first");
			stubReply(second.session, "reply-from-second-private");
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(first.session);
			expect(second.session.getAgentId()).toBe(MAIN_AGENT_ID);
			const result = await ircFrom(AgentRegistry.global(), "1-peer").execute("cross", {
				op: "send",
				to: MAIN_AGENT_ID,
				message: "ping",
			});
			const reply = result.details?.replies?.[0]?.text ?? "";
			expect(reply).toBe("reply-from-first");
			expect(reply).not.toContain("reply-from-second-private");
			await second.session.dispose();
			secondDisposed = true;
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(first.session);
		} finally {
			if (!secondDisposed) await second.session.dispose();
			await first.session.dispose();
		}
	}, 60_000);

	it("does not replace an explicit id the caller asked to share", async () => {
		const registry = new AgentRegistry();
		const first = await openRoot({ agentRegistry: registry, agentId: "root-shared" });
		try {
			await expect(openRoot({ agentRegistry: registry, agentId: "root-shared" })).rejects.toThrow(
				/already registered/,
			);
			expect(registry.get("root-shared")?.session).toBe(first.session);
		} finally {
			await first.session.dispose();
		}
	}, 60_000);

	it("remints a second default id on a caller-supplied registry", async () => {
		const registry = new AgentRegistry();
		const first = await openRoot({ agentRegistry: registry });
		const second = await openRoot({ agentRegistry: registry });
		try {
			stubReply(first.session, "shared-first");
			stubReply(second.session, "shared-second-private");
			expect(first.session.getAgentId()).toBe(MAIN_AGENT_ID);
			const secondId = second.session.getAgentId();
			expect(secondId).not.toBe(MAIN_AGENT_ID);
			expect(registry.get(MAIN_AGENT_ID)?.session).toBe(first.session);
			expect(registry.get(secondId ?? "")?.session).toBe(second.session);
			const toFirst = await ircFrom(registry, "1-peer").execute("to-first", {
				op: "send",
				to: MAIN_AGENT_ID,
				message: "ping",
			});
			expect(toFirst.details?.replies?.[0]?.text).toBe("shared-first");
			const toSecond = await ircFrom(registry, "1-peer").execute("to-second", {
				op: "send",
				to: secondId,
				message: "ping",
			});
			expect(toSecond.details?.replies?.[0]?.text).toBe("shared-second-private");
		} finally {
			await second.session.dispose();
			await first.session.dispose();
		}
	}, 60_000);

	it("lets a later default root claim 0-Main after the first is gone", async () => {
		const first = await openRoot();
		await first.session.dispose();
		const second = await openRoot();
		try {
			expect(second.session.getAgentId()).toBe(MAIN_AGENT_ID);
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(second.session);
		} finally {
			await second.session.dispose();
		}
	}, 60_000);

	it("keeps a reminted second root registered when the first root stops", async () => {
		const registry = new AgentRegistry();
		const first = await openRoot({ agentRegistry: registry });
		const second = await openRoot({ agentRegistry: registry });
		let firstDisposed = false;
		try {
			stubReply(second.session, "second-still-alive");
			const secondId = second.session.getAgentId() ?? "";
			expect(secondId).not.toBe(MAIN_AGENT_ID);
			await first.session.dispose();
			firstDisposed = true;
			expect(registry.get(MAIN_AGENT_ID)).toBeUndefined();
			expect(registry.get(secondId)?.session).toBe(second.session);
			const reply = await ircFrom(registry, "1-peer").execute("after-first-stop", {
				op: "send",
				to: secondId,
				message: "ping",
			});
			expect(reply.details?.replies?.[0]?.text).toBe("second-still-alive");
		} finally {
			if (!firstDisposed) await first.session.dispose();
			await second.session.dispose();
		}
	}, 120_000);

	it("keeps a single registered memory root without a caller cwd", async () => {
		const opened = await openRoot();
		try {
			const cwd = opened.session.sessionManager.getCwd();
			const root = memoryRootFor(opened.session.settings.getAgentDir(), cwd);
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, "memory_summary.md"), "only-root-memory");
			const resource = await InternalUrlRouter.instance().resolve("memory://root");
			expect(resource.content).toBe("only-root-memory");
		} finally {
			await opened.session.dispose();
		}
	}, 60_000);

	it("reads each createAgentSession memory file from that session", async () => {
		const first = await openRoot();
		const second = await openRoot();
		let firstDisposed = false;
		try {
			const firstCwd = first.session.sessionManager.getCwd();
			const secondCwd = second.session.sessionManager.getCwd();
			const firstRoot = memoryRootFor(first.session.settings.getAgentDir(), firstCwd);
			const secondRoot = memoryRootFor(second.session.settings.getAgentDir(), secondCwd);
			fs.mkdirSync(firstRoot, { recursive: true });
			fs.mkdirSync(secondRoot, { recursive: true });
			fs.writeFileSync(path.join(firstRoot, "review.txt"), "from-first");
			fs.writeFileSync(path.join(secondRoot, "review.txt"), "from-second");
			const router = InternalUrlRouter.instance();
			const read = (cwd: string, settings: (typeof second.session)["settings"]) =>
				router.resolve("memory://root/review.txt", { cwd, settings });
			expect((await read(secondCwd, second.session.settings)).content).toBe("from-second");
			expect((await read(firstCwd, first.session.settings)).content).toBe("from-first");
			await first.session.dispose();
			firstDisposed = true;
			expect((await read(secondCwd, second.session.settings)).content).toBe("from-second");
		} finally {
			if (!firstDisposed) await first.session.dispose();
			await second.session.dispose();
		}
	}, 60_000);

	it("search and find read one custom agent dir memory file", async () => {
		const paths = makePaths();
		const processAgentDir = path.join(path.dirname(paths.cwd), "process-agent");
		fs.mkdirSync(processAgentDir, { recursive: true });
		const previousAgentDir = getAgentDir();
		setAgentDir(processAgentDir);
		const opened = await openScopedRoot(paths.cwd, paths.agentDir);
		try {
			const cwd = opened.session.sessionManager.getCwd();
			const agentDir = opened.session.settings.getAgentDir();
			expect(path.resolve(agentDir)).not.toBe(path.resolve(getAgentDir()));
			writeMemoryFile(agentDir, cwd, "review.txt", "custom-root-sentinel\n");
			writeMemoryFile(getAgentDir(), cwd, "review.txt", "process-root-sentinel\n");
			const searched = textOf(
				await runSessionTool(opened.session, "search", {
					pattern: "sentinel",
					paths: ["memory://root/review.txt"],
				}),
			);
			expect(searched).toContain("custom-root-sentinel");
			expect(searched).not.toContain("process-root-sentinel");
			const found = await runSessionTool(opened.session, "find", {
				paths: ["memory://root/review.txt"],
			});
			const foundText = textOf(found);
			expect(foundText).toContain("review.txt");
			const files = (found.details as { files?: string[] } | undefined)?.files ?? [];
			const resolvedFiles = files.map(file => (path.isAbsolute(file) ? file : path.resolve(cwd, file)));
			// Compare the exact memory root, not a basename substring: "agent" also
			// appears in the process fallback dir name "process-agent".
			expect(resolvedFiles.map(file => path.resolve(file))).toContain(
				path.join(memoryRootFor(agentDir, cwd), "review.txt"),
			);
			const processRoot = path.resolve(memoryRootFor(getAgentDir(), cwd)) + path.sep;
			expect(resolvedFiles.some(file => path.resolve(file).startsWith(processRoot))).toBe(false);
		} finally {
			await opened.session.dispose();
			setAgentDir(previousAgentDir);
		}
	}, 120_000);

	it("search and find resolve one memory file name per custom agent dir", async () => {
		const paths = makePaths();
		const processAgentDir = path.join(path.dirname(paths.cwd), "process-agent");
		const agentBeta = path.join(path.dirname(paths.cwd), "agent-beta");
		fs.mkdirSync(processAgentDir, { recursive: true });
		const previousAgentDir = getAgentDir();
		setAgentDir(processAgentDir);
		const first = await openScopedRoot(paths.cwd, paths.agentDir);
		const second = await openScopedRoot(paths.cwd, agentBeta);
		let firstDisposed = false;
		try {
			const cwd = first.session.sessionManager.getCwd();
			writeMemoryFile(first.session.settings.getAgentDir(), cwd, "review.txt", "alpha-sentinel\n");
			writeMemoryFile(second.session.settings.getAgentDir(), cwd, "review.txt", "beta-sentinel\n");
			const readSearch = async (session: AgentSession) =>
				textOf(
					await runSessionTool(session, "search", {
						pattern: "sentinel",
						paths: ["memory://root/review.txt"],
					}),
				);
			const alpha = await readSearch(first.session);
			const beta = await readSearch(second.session);
			expect(alpha).toContain("alpha-sentinel");
			expect(alpha).not.toContain("beta-sentinel");
			expect(beta).toContain("beta-sentinel");
			expect(beta).not.toContain("alpha-sentinel");
			const foundBeta = textOf(
				await runSessionTool(second.session, "find", { paths: ["memory://root/review.txt"] }),
			);
			expect(foundBeta).toContain("review.txt");
			expect(foundBeta).toContain(path.basename(agentBeta));
			// AST search resolves the same caller-scoped memory path.
			writeMemoryFile(
				first.session.settings.getAgentDir(),
				cwd,
				"ast.ts",
				"function alphaSentinel() { return 1 }\n",
			);
			writeMemoryFile(
				second.session.settings.getAgentDir(),
				cwd,
				"ast.ts",
				"function betaSentinel() { return 2 }\n",
			);
			const ast = async (session: AgentSession) =>
				textOf(
					await runSessionTool(session, "ast_grep", {
						pat: "function $NAME() { return $VALUE }",
						paths: ["memory://root/ast.ts"],
					}),
				);
			const alphaAst = await ast(first.session);
			const betaAst = await ast(second.session);
			expect(alphaAst).toContain("alphaSentinel");
			expect(alphaAst).not.toContain("betaSentinel");
			expect(betaAst).toContain("betaSentinel");
			expect(betaAst).not.toContain("alphaSentinel");
			await first.session.dispose();
			firstDisposed = true;
			const betaAfter = await readSearch(second.session);
			expect(betaAfter).toContain("beta-sentinel");
			expect(betaAfter).not.toContain("alpha-sentinel");
		} finally {
			if (!firstDisposed) await first.session.dispose();
			await second.session.dispose();
			setAgentDir(previousAgentDir);
		}
	}, 120_000);

	it("bash expands each root memory URL to that session file", async () => {
		const processAgentDir = path.join(makePaths().cwd, "process-agent");
		fs.mkdirSync(processAgentDir, { recursive: true });
		const previousAgentDir = getAgentDir();
		setAgentDir(processAgentDir);
		const first = await openRoot();
		const second = await openRoot();
		let firstDisposed = false;
		try {
			const firstCwd = first.session.sessionManager.getCwd();
			const secondCwd = second.session.sessionManager.getCwd();
			writeMemoryFile(first.session.settings.getAgentDir(), firstCwd, "review.txt", "from-first-memory\n");
			writeMemoryFile(second.session.settings.getAgentDir(), secondCwd, "review.txt", "from-second-memory\n");
			writeMemoryFile(second.session.settings.getAgentDir(), secondCwd, "only-second.txt", "only-second-memory\n");
			const bashText = async (session: AgentSession, command: string) =>
				textOf(await runSessionTool(session, "bash", { command }));
			const secondReview = await bashText(second.session, "cat memory://root/review.txt");
			expect(secondReview).toContain("from-second-memory");
			expect(secondReview).not.toContain("from-first-memory");
			const firstReview = await bashText(first.session, "cat memory://root/review.txt");
			expect(firstReview).toContain("from-first-memory");
			expect(firstReview).not.toContain("from-second-memory");
			expect(await bashText(second.session, "cat memory://root/only-second.txt")).toContain("only-second-memory");
			await first.session.dispose();
			firstDisposed = true;
			const afterClose = await bashText(second.session, "cat memory://root/review.txt");
			expect(afterClose).toContain("from-second-memory");
			expect(afterClose).not.toContain("from-first-memory");
			expect(await bashText(second.session, "cat memory://root/only-second.txt")).toContain("only-second-memory");
		} finally {
			if (!firstDisposed) await first.session.dispose();
			await second.session.dispose();
			setAgentDir(previousAgentDir);
		}
	}, 120_000);

	it("reads local:// inside the calling root across two default roots", async () => {
		const first = await openRoot();
		const second = await openRoot();
		let firstDisposed = false;
		try {
			const firstRoot = localRootOf(first.session);
			const secondRoot = localRootOf(second.session);
			expect(path.resolve(firstRoot)).not.toBe(path.resolve(secondRoot));
			writeLocalFile(firstRoot, "review.txt", "first-root-local\n");
			writeLocalFile(firstRoot, "only-first.txt", "only-first-local\n");
			writeLocalFile(secondRoot, "review.txt", "second-root-local\n");
			writeLocalFile(secondRoot, "only-second.txt", "only-second-local\n");

			const readLocal = async (session: AgentSession, name: string) =>
				textOf(await runSessionTool(session, "read", { path: `local://${name}` }));

			expect(await readLocal(first.session, "review.txt")).toContain("first-root-local");
			expect(await readLocal(second.session, "review.txt")).toContain("second-root-local");
			expect(await readLocal(second.session, "review.txt")).not.toContain("first-root-local");
			expect(await readLocal(first.session, "review.txt")).not.toContain("second-root-local");
			// A file that exists only in the other root is never returned here.
			await expect(readLocal(second.session, "only-first.txt")).rejects.toThrow(/not found/i);
			await expect(readLocal(first.session, "only-second.txt")).rejects.toThrow(/not found/i);

			await first.session.dispose();
			firstDisposed = true;
			expect(await readLocal(second.session, "review.txt")).toContain("second-root-local");
			expect(await readLocal(second.session, "only-second.txt")).toContain("only-second-local");
			await expect(readLocal(second.session, "only-first.txt")).rejects.toThrow(/not found/i);
		} finally {
			if (!firstDisposed) await first.session.dispose();
			await second.session.dispose();
		}
	}, 120_000);

	it("resolves a caller local binding instead of the process-global root", async () => {
		// The live default root is what the process-global fallback would pick.
		const processRoot = await openRoot();
		const suffix = Snowflake.next();
		const firstScratchId = `pr7576-scratch-a-${suffix}`;
		const secondScratchId = `pr7576-scratch-b-${suffix}`;
		const firstOptions = managedScratchOptions(firstScratchId);
		const secondOptions = managedScratchOptions(secondScratchId);
		const firstScratch = path.join(os.tmpdir(), "gjc-local", firstScratchId);
		const secondScratch = path.join(os.tmpdir(), "gjc-local", secondScratchId);
		try {
			// A caller-bound managed root is the reported /tmp/gjc-local/<id> path.
			expect(resolveLocalRoot(firstOptions)).toBe(firstScratch);
			expect(resolveLocalRoot(secondOptions)).toBe(secondScratch);
			const router = InternalUrlRouter.instance();
			await initializeLocalRoot(firstOptions);
			await initializeLocalRoot(secondOptions);
			writeLocalFile(firstScratch, "review.txt", "managed-first\n");
			writeLocalFile(firstScratch, "only-first.txt", "managed-only-first\n");
			writeLocalFile(secondScratch, "review.txt", "managed-second\n");

			const firstRead = await router.resolve("local://review.txt", { localProtocolOptions: firstOptions });
			const secondRead = await router.resolve("local://review.txt", { localProtocolOptions: secondOptions });
			expect(firstRead.content).toBe("managed-first\n");
			expect(secondRead.content).toBe("managed-second\n");
			expect(firstRead.sourcePath?.startsWith(firstScratch)).toBe(true);
			expect(secondRead.sourcePath?.startsWith(secondScratch)).toBe(true);
			await expect(
				router.resolve("local://only-first.txt", { localProtocolOptions: secondOptions }),
			).rejects.toThrow(/local file not found/i);
		} finally {
			await processRoot.session.dispose();
			fs.rmSync(firstScratch, { recursive: true, force: true });
			fs.rmSync(secondScratch, { recursive: true, force: true });
		}
	}, 120_000);

	it("keeps an explicitly shared local binding across sessions", async () => {
		const parent = await openRoot();
		const parentRoot = localRootOf(parent.session);
		writeLocalFile(parentRoot, "review.txt", "shared-parent-local\n");
		writeLocalFile(parentRoot, "only-parent.txt", "only-parent-local\n");
		// Exactly what a subagent receives from the task executor: the parent's
		// binding, explicitly, rather than a root derived from its own managers.
		const sharedBinding: LocalProtocolOptions = {
			getArtifactsDir: () => parent.session.sessionManager.getArtifactsDir(),
			isManagedDestination: () => parent.session.sessionManager.isManagedDestination(),
			getSessionId: () => parent.session.sessionManager.getSessionId(),
		};
		const child = await openRoot({ localProtocolOptions: sharedBinding });
		try {
			expect(path.resolve(localRootOf(child.session))).not.toBe(path.resolve(parentRoot));
			const readLocal = async (session: AgentSession, name: string) =>
				textOf(await runSessionTool(session, "read", { path: `local://${name}` }));
			expect(await readLocal(child.session, "review.txt")).toContain("shared-parent-local");
			expect(await readLocal(child.session, "only-parent.txt")).toContain("only-parent-local");
			expect(await readLocal(parent.session, "review.txt")).toContain("shared-parent-local");
			// The shared root is deliberate: a file that exists only in the child's
			// own derived root is not reachable through the shared binding.
			const childOnlyRoot = localRootOf(child.session);
			writeLocalFile(childOnlyRoot, "only-child.txt", "only-child-local\n");
			await expect(readLocal(child.session, "only-child.txt")).rejects.toThrow(/not found/i);
		} finally {
			await child.session.dispose();
			await parent.session.dispose();
		}
	}, 120_000);

	it("fails closed for a memory caller that names no agent dir", async () => {
		const opened = await openRoot();
		try {
			const cwd = opened.session.sessionManager.getCwd();
			writeMemoryFile(opened.session.settings.getAgentDir(), cwd, "review.txt", "caller-memory\n");
			await expect(InternalUrlRouter.instance().resolve("memory://root/review.txt", { cwd })).rejects.toThrow(
				/supplied no memory root/i,
			);
		} finally {
			await opened.session.dispose();
		}
	}, 120_000);

	it("fails closed when a caller supplies no local binding", async () => {
		const opened = await openRoot();
		try {
			await expect(
				InternalUrlRouter.instance().resolve("local://review.txt", { cwd: opened.session.sessionManager.getCwd() }),
			).rejects.toThrow(/no session local root binding/i);
		} finally {
			await opened.session.dispose();
		}
	}, 120_000);

	it("keeps the first root registered when a second root fails startup", async () => {
		const first = await openRoot();
		const sharedRegistry = new AgentRegistry();
		try {
			stubReply(first.session, "first-still-alive");
			const failingExtension = () => {
				throw new Error("simulated second-root startup failure");
			};
			await expect(openRoot({ extensions: [failingExtension] })).rejects.toThrow(
				/simulated second-root startup failure/,
			);
			expect(
				AgentRegistry.global()
					.list()
					.map(ref => ref.id),
			).toEqual([MAIN_AGENT_ID]);
			expect(AgentRegistry.global().get(MAIN_AGENT_ID)?.session).toBe(first.session);
			const reply = await ircFrom(AgentRegistry.global(), "1-peer").execute("after-failure", {
				op: "send",
				to: MAIN_AGENT_ID,
				message: "ping",
			});
			expect(reply.details?.replies?.[0]?.text).toBe("first-still-alive");

			// A shared registry is where a newcomer could remint onto a new id; a
			// failed startup must not leave that entry behind either.
			const sharedFirst = await openRoot({ agentRegistry: sharedRegistry });
			try {
				expect(sharedRegistry.get(MAIN_AGENT_ID)?.session).toBe(sharedFirst.session);
				await expect(openRoot({ agentRegistry: sharedRegistry, extensions: [failingExtension] })).rejects.toThrow(
					/simulated second-root startup failure/,
				);
				expect(sharedRegistry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
				expect(sharedRegistry.get(MAIN_AGENT_ID)?.session).toBe(sharedFirst.session);
			} finally {
				await sharedFirst.session.dispose();
			}

			// A failure AFTER the newcomer claimed its id (attachSession runs once the
			// session exists) must release only the newcomer's own entry.
			class FailingAttachRegistry extends AgentRegistry {
				override attachSession(): void {
					throw new Error("simulated late startup failure");
				}
			}
			const lateRegistry = new FailingAttachRegistry();
			lateRegistry.claim({
				id: MAIN_AGENT_ID,
				displayName: "incumbent-root",
				kind: "main",
				session: null,
			});
			await expect(openRoot({ agentRegistry: lateRegistry })).rejects.toThrow(/simulated late startup failure/);
			expect(lateRegistry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
			expect(lateRegistry.get(MAIN_AGENT_ID)?.displayName).toBe("incumbent-root");
		} finally {
			await first.session.dispose();
		}
	}, 180_000);

	it("does not unregister a successor that claims the id during a failed startup", async () => {
		let successorId: string | undefined;
		// The newcomer's own entry is already gone when cleanup runs (disposal
		// released it) and a successor claimed the same id in between. Cleanup must
		// leave that successor alone: it is not the identity this call claimed.
		class SuccessorAttachRegistry extends AgentRegistry {
			override attachSession(id: string): void {
				successorId = id;
				this.unregister(id);
				this.claim({ id, displayName: "successor-root", kind: "main", session: null });
				throw new Error("simulated late startup failure");
			}
		}
		const registry = new SuccessorAttachRegistry();
		registry.claim({ id: MAIN_AGENT_ID, displayName: "incumbent-root", kind: "main", session: null });

		await expect(openRoot({ agentRegistry: registry })).rejects.toThrow(/simulated late startup failure/);

		const newId = successorId ?? "";
		expect(newId).not.toBe("");
		expect(newId).not.toBe(MAIN_AGENT_ID);
		expect(registry.get(MAIN_AGENT_ID)?.displayName).toBe("incumbent-root");
		expect(registry.get(newId)?.displayName).toBe("successor-root");
		expect(registry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID, newId]);
	}, 60_000);
});

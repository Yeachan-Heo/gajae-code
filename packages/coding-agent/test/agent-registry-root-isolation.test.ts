import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
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
		const sdk = await import("@gajae-code/coding-agent/sdk");
		const planOccupiedAgentId = sdk.planOccupiedAgentId;
		if (typeof planOccupiedAgentId !== "function") {
			throw new Error("planOccupiedAgentId missing");
		}
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
			expect(createAgentSession.name).toBe("createAgentSession");
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
			expect(resolvedFiles.some(file => file.includes(path.basename(paths.agentDir)))).toBe(true);
			expect(foundText).not.toContain("process-root-sentinel");
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
});

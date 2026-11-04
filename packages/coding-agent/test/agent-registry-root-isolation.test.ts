import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { IrcTool } from "@gajae-code/coding-agent/tools/irc";
import { Snowflake } from "@gajae-code/utils";
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

async function openRoot(extra: Record<string, unknown> = {}) {
	return createAgentSession({
		...makePaths(),
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
}

describe("root agent id claim", () => {
	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("register does not replace a live id", () => {
		const registry = new AgentRegistry();
		const first = registry.register({ id: "root-a", displayName: "a", kind: "main", session: null });
		expect(() => registry.register({ id: "root-a", displayName: "b", kind: "main", session: null })).toThrow(
			/already registered/,
		);
		expect(registry.get("root-a")).toBe(first);
	});

	it("attach and release stay on the first session", () => {
		const registry = new AgentRegistry();
		const first = { tag: "first" } as unknown as AgentSession;
		const second = { tag: "second" } as unknown as AgentSession;
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: null });
		registry.attachSession(MAIN_AGENT_ID, first);
		registry.attachSession(MAIN_AGENT_ID, second);
		expect(registry.get(MAIN_AGENT_ID)?.session).toBe(first);
		expect(registry.releaseClaim(MAIN_AGENT_ID, second)).toBe(false);
		expect(registry.releaseClaim(MAIN_AGENT_ID, null)).toBe(false);
		expect(registry.releaseClaim(MAIN_AGENT_ID, first)).toBe(true);
		expect(registry.get(MAIN_AGENT_ID)).toBeUndefined();
	});

	it("property: occupied id plan, fc.property seed 17091, numRuns 64", async () => {
		const { planOccupiedAgentId } = await import("@gajae-code/coding-agent/registry/agent-registry");
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
});

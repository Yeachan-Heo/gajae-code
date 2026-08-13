import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@gajae-code/coding-agent/cli/args";
import Master from "@gajae-code/coding-agent/commands/master";
import {
	classifyResidentSession,
	classifySupervisionTarget,
	createMasterModeExtension,
	MASTER_INVENTORY_ROW_LIMIT,
	MASTER_SESSION_CONTEXT_CUSTOM_TYPE,
	type MasterModeExtensionDeps,
	type ResidentSessionInventory,
	renderInventoryMarkdown,
} from "@gajae-code/coding-agent/master";
import { masterModeSystemPromptSection } from "@gajae-code/coding-agent/master/prompt";
import type { SdkSessionRowV1 } from "@gajae-code/coding-agent/sdk/cli/rows";
import { buildSystemPrompt } from "@gajae-code/coding-agent/system-prompt";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

function row(partial: Partial<SdkSessionRowV1> & { sessionId: string }): SdkSessionRowV1 {
	return {
		locator: { repo: "/repo", stateRoot: "/state" },
		endpointGeneration: 1,
		pid: 1234,
		live: true,
		deleted: false,
		indexSeq: 1,
		...partial,
	};
}

function inventory(sessions: SdkSessionRowV1[]): ResidentSessionInventory {
	return { fetchedAt: NOW, sessions };
}

describe("gjc master launch surface", () => {
	it("parses --master as a local launch flag", () => {
		const parsed = parseArgs(["--master"], "local");
		expect(parsed.master).toBe(true);
		expect(parsed.unknownFlags.size).toBe(0);
	});

	it("leaves master mode off by default", () => {
		const parsed = parseArgs([], "local");
		expect(parsed.master).toBeUndefined();
	});

	it("exposes the gjc master command with a supervision description", () => {
		expect(Master.description).toContain("master session");
		expect(Master.description).toContain("SDK");
	});
});

describe("master-mode system prompt section", () => {
	it("is appended only for master sessions", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-master-prompt-"));
		const base = { cwd, contextFiles: [], toolNames: ["bash"] };
		const master = await buildSystemPrompt({ ...base, masterMode: true });
		const plain = await buildSystemPrompt(base);
		expect(master.systemPrompt.some(block => block.includes("<master-mode>"))).toBe(true);
		expect(plain.systemPrompt.some(block => block.includes("<master-mode>"))).toBe(false);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("states the supervision-only contract and non-goals", () => {
		const section = masterModeSystemPromptSection();
		expect(section).toContain("master session");
		expect(section).toContain("NEVER scrape terminal panes");
		expect(section).toContain("NOT a team");
		expect(section).toContain("Fail closed");
	});
});

describe("resident-session classification", () => {
	it("fails closed on ambiguous or terminal-uncertain rows", () => {
		expect(classifyResidentSession(row({ sessionId: "a", ambiguous: true }), NOW)).toBe("blocked");
		expect(classifyResidentSession(row({ sessionId: "b", terminalUncertain: true }), NOW)).toBe("blocked");
		expect(classifyResidentSession(row({ sessionId: "c", live: false, ambiguous: true }), NOW)).toBe("blocked");
	});

	it("classifies dead or deleted rows as terminal", () => {
		expect(classifyResidentSession(row({ sessionId: "a", live: false }), NOW)).toBe("terminal");
		expect(classifyResidentSession(row({ sessionId: "b", deleted: true }), NOW)).toBe("terminal");
	});

	it("classifies a live active session as active within the heartbeat window", () => {
		const active = row({
			sessionId: "a",
			activity: { state: "active", at: NOW - 1_000 },
			lastHeartbeatAt: NOW - 1_000,
		});
		expect(classifyResidentSession(active, NOW)).toBe("active");
	});

	it("classifies a live active session past the stuck threshold as stuck", () => {
		const stale = row({
			sessionId: "a",
			activity: { state: "active", at: NOW - 60 * 60 * 1000 },
			lastHeartbeatAt: NOW - 60 * 60 * 1000,
		});
		expect(classifyResidentSession(stale, NOW)).toBe("stuck");
	});

	it("classifies a live session without an active turn as idle", () => {
		expect(classifyResidentSession(row({ sessionId: "a" }), NOW)).toBe("idle");
		expect(classifyResidentSession(row({ sessionId: "b", activity: { state: "idle", at: NOW - 5_000 } }), NOW)).toBe(
			"idle",
		);
	});
});

describe("supervision classification with authoritative probes", () => {
	it("refines an idle session without a goal to idle_no_goal", () => {
		expect(classifySupervisionTarget("idle", { hasGoal: false, pendingAsk: false, pendingGate: false })).toBe(
			"idle_no_goal",
		);
	});

	it("refines an idle session with a pending ask or gate to question/gate", () => {
		expect(classifySupervisionTarget("idle", { hasGoal: true, pendingAsk: true, pendingGate: false })).toBe(
			"question",
		);
		expect(classifySupervisionTarget("idle", { hasGoal: true, pendingAsk: false, pendingGate: true })).toBe("gate");
	});

	it("keeps an idle session with an active goal as idle", () => {
		expect(classifySupervisionTarget("idle", { hasGoal: true, pendingAsk: false, pendingGate: false })).toBe("idle");
	});

	it("never reclassifies blocked, active, stuck, or terminal rows from probes", () => {
		for (const cls of ["blocked", "active", "stuck", "terminal"] as const) {
			expect(classifySupervisionTarget(cls, { hasGoal: false, pendingAsk: true, pendingGate: true })).toBe(cls);
		}
	});
});

describe("resident-session inventory rendering", () => {
	it("renders exact identity fields and the master self-annotation", () => {
		const md = renderInventoryMarkdown(
			inventory([
				row({ sessionId: "self", hostIncarnation: "inc-1" }),
				row({ sessionId: "other", endpointGeneration: 7, live: false }),
			]),
			"self",
			NOW,
		);
		expect(md).toContain("session=self");
		expect(md).toContain("hostIncarnation=inc-1");
		expect(md).toContain("this master session");
		expect(md).toContain("session=other");
		expect(md).toContain("endpointGeneration=7");
		expect(md).toContain("class=terminal");
	});

	it("flags blocked rows as hands-off", () => {
		const md = renderInventoryMarkdown(inventory([row({ sessionId: "x", ambiguous: true })]), undefined, NOW);
		expect(md).toContain("HANDS-OFF");
		expect(md).toContain("class=blocked");
	});

	it("bounds the rendered rows", () => {
		const sessions = Array.from({ length: MASTER_INVENTORY_ROW_LIMIT + 5 }, (_, i) => row({ sessionId: `s${i}` }));
		const md = renderInventoryMarkdown(inventory(sessions), undefined, NOW);
		expect(md).not.toContain(`session=s${MASTER_INVENTORY_ROW_LIMIT}`);
		expect(md).toContain("5 more");
	});

	it("reports an empty broker index explicitly", () => {
		expect(renderInventoryMarkdown(inventory([]), undefined, NOW)).toContain("No resident sessions");
	});
});

describe("master session-start hook", () => {
	function fakeApi(sent: Array<{ message: Record<string, unknown>; options: unknown }>) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		return {
			handlers,
			api: {
				on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
					handlers.set(event, handler);
				},
				sendMessage: (message: Record<string, unknown>, options: unknown) => {
					sent.push({ message, options });
				},
			},
		};
	}

	const ctx = { sessionManager: { getSessionId: () => "master-self" } };

	it("injects SDK guidance plus the current inventory on session_start", async () => {
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
		const { handlers, api } = fakeApi(sent);
		const deps: MasterModeExtensionDeps = {
			agentDir: "/unused",
			now: () => NOW,
			loadInventory: async () => inventory([row({ sessionId: "master-self" }), row({ sessionId: "worker-1" })]),
		};
		createMasterModeExtension(deps)(api as never);
		const handler = handlers.get("session_start");
		expect(handler).toBeDefined();
		await handler?.({}, ctx);
		expect(sent).toHaveLength(1);
		const [{ message, options }] = sent;
		expect(message.customType).toBe(MASTER_SESSION_CONTEXT_CUSTOM_TYPE);
		expect(message.display).toBe(false);
		expect(options).toEqual({ triggerTurn: false });
		const content = String(message.content);
		expect(content).toContain("SDK supervision quick reference");
		expect(content).toContain("session=worker-1");
		expect(content).toContain("this master session");
	});

	it("fails closed with guidance-only content when the broker is unavailable", async () => {
		const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
		const { handlers, api } = fakeApi(sent);
		createMasterModeExtension({
			agentDir: "/unused",
			now: () => NOW,
			loadInventory: async () => {
				throw new Error("broker gone");
			},
		})(api as never);
		await handlers.get("session_start")?.({}, ctx);
		expect(sent).toHaveLength(1);
		const content = String(sent[0]?.message.content);
		expect(content).toContain("SDK supervision quick reference");
		expect(content).toContain("UNAVAILABLE");
		expect(content).toContain("Fail closed");
	});
});

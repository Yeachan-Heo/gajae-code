import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalRuntime } from "../../src/goals/runtime";
import type { GoalModeState, GoalRuntimeEvent } from "../../src/goals/state";
import { SessionManager } from "../../src/session/session-manager";
import { makeAssistantMessage } from "./helpers";

describe("goal lifecycle preserves managed transcript identity", () => {
	let root: string;
	let manager: SessionManager;
	let runtime: GoalRuntime;
	let state: GoalModeState | undefined;
	let events: GoalRuntimeEvent[];
	let snapshots: Array<Record<string, string | boolean>>;

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "goal-managed-identity-"));
		const cwd = path.join(root, "work");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		fs.mkdirSync(agentDir);
		manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		manager.appendMessage({ role: "user", content: "isolated fixture", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		state = undefined;
		events = [];
		snapshots = [];
		runtime = new GoalRuntime({
			getState: () => state,
			setState: next => {
				state = next;
			},
			getCurrentUsage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
			emit: event => {
				events.push(event);
			},
			persist: (mode, next) => {
				if (mode === "none") manager.appendModeChange("none");
				else if (next) manager.appendModeChange(mode, { goal: next.goal });
			},
			sendHiddenMessage: async message => {
				manager.appendCustomEntry(message.customType, { content: message.content });
			},
		});
	});

	afterEach(async () => {
		await manager.close().catch(() => {});
		const report = process.env.PERSISTENCE_REPRO_REPORT;
		if (report) fs.appendFileSync(report, `${JSON.stringify({ root, snapshots })}\n`);
		fs.rmSync(root, { recursive: true, force: true });
	});

	function assertCurrentIdentity(label: string): void {
		const file = manager.getSessionFile()!;
		const stat = fs.statSync(file, { bigint: true });
		const expected = manager.captureState().managedPersistExpectedIdentity;
		expect(expected).toBeDefined();
		snapshots.push({
			label,
			actualInode: String(stat.ino),
			expectedInode: String(expected!.ino),
			size: String(stat.size),
			sameIdentity: expected!.ino === stat.ino,
		});
		expect(expected!.dev).toBe(stat.dev);
		expect(expected!.ino).toBe(stat.ino);
		expect(String(expected!.size)).toBe(String(stat.size));
	}

	it("adopts goal creation and result identities before the next append", async () => {
		assertCurrentIdentity("before-create");
		await runtime.createGoal({ objective: "Verify isolated persistence" });
		assertCurrentIdentity("after-create");
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "goal-fixture",
			toolName: "goal",
			content: [{ type: "text", text: "created" }],
			isError: false,
			timestamp: Date.now(),
		});
		assertCurrentIdentity("after-tool-result");
		await runtime.onGoalToolCompleted();
		assertCurrentIdentity("after-goal-completed-event");
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		assertCurrentIdentity("after-next-assistant");
		expect(events.some(event => event.type === "goal_updated" && event.goal?.status === "active")).toBe(true);
		const records = fs
			.readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(records.some(record => record.type === "mode_change" && record.mode === "goal")).toBe(true);
		expect(records.at(-1).message.role).toBe("assistant");
	});

	it("retains identity across pause, resume, and ordinary header metadata", async () => {
		await runtime.createGoal({ objective: "Verify transitions" });
		await runtime.pauseGoal();
		assertCurrentIdentity("paused");
		await runtime.resumeGoal();
		assertCurrentIdentity("resumed");
		await manager.setSessionName("Isolated renamed goal", "user");
		assertCurrentIdentity("renamed");
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		assertCurrentIdentity("after-renamed-append");
		expect(manager.getSessionName()).toBe("Isolated renamed goal");
		expect(state?.goal.status).toBe("active");
	});

	it("still rejects an external inode replacement after goal creation", async () => {
		await runtime.createGoal({ objective: "Preserve ownership guards" });
		const file = manager.getSessionFile()!;
		const bytes = fs.readFileSync(file);
		const before = fs.statSync(file, { bigint: true });
		const replacement = `${file}.external`;
		fs.writeFileSync(replacement, bytes, { mode: 0o600 });
		fs.renameSync(replacement, file);
		expect(fs.statSync(file, { bigint: true }).ino).not.toBe(before.ino);
		expect(() => manager.appendMessage(makeAssistantMessage())).toThrow(/identity_mismatch/);
		expect(fs.readFileSync(file).equals(bytes)).toBe(true);
	});
});

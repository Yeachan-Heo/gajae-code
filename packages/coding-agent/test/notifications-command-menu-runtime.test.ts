import { describe, expect, test } from "bun:test";
import { CommandMenuRuntime, type MenuRuntimeDeps, type ModelOption } from "../src/notifications/command-menu-runtime";

interface Recorded {
	asks: Array<{ id: string; question: string; options: string[] }>;
	messages: string[];
	skillRuns: Array<{ skillName: string; prompt: string }>;
	modelSwitches: string[];
}

function makeRuntime(over: Partial<MenuRuntimeDeps> = {}): { rt: CommandMenuRuntime; rec: Recorded } {
	const rec: Recorded = { asks: [], messages: [], skillRuns: [], modelSwitches: [] };
	const deps: MenuRuntimeDeps = {
		allowedSkillIds: over.allowedSkillIds ?? (() => ["ralplan", "deep-interview"]),
		recentModels:
			over.recentModels ??
			((): ModelOption[] => [
				{ ref: "anthropic/opus", label: "opus", current: true },
				{ ref: "openai/gpt-5", label: "gpt-5" },
			]),
		registerAsk: over.registerAsk ?? ((id, question, options) => rec.asks.push({ id, question, options })),
		postMessage: over.postMessage ?? (text => rec.messages.push(text)),
		runSkill:
			over.runSkill ??
			(async (skillName, prompt) => {
				rec.skillRuns.push({ skillName, prompt });
			}),
		setModelTemporary:
			over.setModelTemporary ??
			(async ref => {
				rec.modelSwitches.push(ref);
				return { previous: "anthropic/opus", next: ref };
			}),
	};
	return { rt: new CommandMenuRuntime(deps), rec };
}

describe("CommandMenuRuntime top-level menu", () => {
	test("opens a 3-option menu and owns its id", () => {
		const { rt, rec } = makeRuntime();
		const id = rt.openTopLevelMenu();
		expect(rt.owns(id)).toBe(true);
		expect(rec.asks).toHaveLength(1);
		expect(rec.asks[0]?.options).toEqual(["Skills", "Model", "Notify"]);
		expect(id.startsWith("menu:")).toBe(true);
	});

	test("unknown ids are not menu actions (fall through to real asks)", async () => {
		const { rt } = makeRuntime();
		expect(await rt.handleReply("ask:real-gate", 0)).toEqual({ kind: "not_menu_action" });
	});
});

describe("CommandMenuRuntime skills flow", () => {
	test("Skills → submenu → pending skill prompt (no ask registered)", async () => {
		const { rt, rec } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		// index 0 = Skills
		expect(await rt.handleReply(menuId, 0)).toEqual({ kind: "resolved" });
		const submenu = rec.asks[1];
		expect(submenu?.options).toEqual(["ralplan", "deep-interview"]);
		// pick ralplan (index 0)
		expect(await rt.handleReply(submenu!.id, 0)).toEqual({ kind: "resolved" });
		// No options-less ask is registered; a prompt message is posted instead.
		expect(rt.hasPendingSkillPrompt).toBe(true);
		expect(rec.messages.some(m => m.includes("/skill:ralplan"))).toBe(true);
		expect(rec.asks).toHaveLength(2); // menu + submenu only
		expect(await rt.consumePendingSkillPrompt("make a plan")).toBe(true);
		expect(rec.skillRuns).toEqual([{ skillName: "ralplan", prompt: "make a plan" }]);
		expect(rt.hasPendingSkillPrompt).toBe(false);
	});

	test("consumePendingSkillPrompt returns false when nothing pending", async () => {
		const { rt } = makeRuntime();
		expect(await rt.consumePendingSkillPrompt("unused")).toBe(false);
		expect(rt.hasPendingSkillPrompt).toBe(false);
	});
	test("empty skill prompt is consumed without running", async () => {
		const { rt, rec } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		await rt.handleReply(menuId, 0);
		await rt.handleReply(rec.asks[1]!.id, 0);
		expect(await rt.consumePendingSkillPrompt("   ")).toBe(true);
		expect(rec.skillRuns).toEqual([]);
		expect(rec.messages.some(m => m.includes("Empty prompt"))).toBe(true);
	});

	test("no skills available posts a message instead of a submenu", async () => {
		const { rt, rec } = makeRuntime({ allowedSkillIds: () => [] });
		const menuId = rt.openTopLevelMenu();
		await rt.handleReply(menuId, 0);
		expect(rec.messages.some(m => m.includes("No skills"))).toBe(true);
	});
});

describe("CommandMenuRuntime model flow (temporary only)", () => {
	test("Model → picker → setModelTemporary + previous→new feedback", async () => {
		const { rt, rec } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		// index 1 = Model
		expect(await rt.handleReply(menuId, 1)).toEqual({ kind: "resolved" });
		const picker = rec.asks[1];
		expect(picker?.options).toEqual(["opus (current)", "gpt-5"]);
		// pick gpt-5 (index 1)
		expect(await rt.handleReply(picker!.id, 1)).toEqual({ kind: "resolved" });
		expect(rec.modelSwitches).toEqual(["openai/gpt-5"]);
		expect(
			rec.messages.some(m => m.includes("anthropic/opus → openai/gpt-5") && m.includes("this session only")),
		).toBe(true);
	});

	test("no recent models posts a message", async () => {
		const { rt, rec } = makeRuntime({ recentModels: () => [] });
		const menuId = rt.openTopLevelMenu();
		await rt.handleReply(menuId, 1);
		expect(rec.messages.some(m => m.includes("No recent models"))).toBe(true);
	});
});

describe("CommandMenuRuntime notify", () => {
	test("Notify posts guidance", async () => {
		const { rt, rec } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		await rt.handleReply(menuId, 2); // Notify
		expect(rec.messages.some(m => m.includes("/notify status"))).toBe(true);
	});

	test("Help is no longer a menu option (index out of range is rejected)", async () => {
		const { rt } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		expect(await rt.handleReply(menuId, 3)).toEqual({ kind: "rejected", reason: "unknown menu option" });
	});

	test("out-of-range menu option is rejected", async () => {
		const { rt } = makeRuntime();
		const menuId = rt.openTopLevelMenu();
		expect(await rt.handleReply(menuId, 9)).toEqual({ kind: "rejected", reason: "unknown menu option" });
	});
});

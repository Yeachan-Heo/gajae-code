import { describe, expect, test } from "bun:test";
import { Effort, type Model } from "@gajae-code/ai/core";
import {
	projectDesktopModel,
	projectDesktopThinking,
	projectDesktopThinkingOption,
	validateModelThinking,
	validateSessionThinking,
} from "../src/model-controls";

const reasoning: Model = {
	id: "discrete",
	name: "Discrete reasoning",
	provider: "desktop-fixture",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: {
		mode: "budget",
		minLevel: Effort.Low,
		maxLevel: Effort.Max,
		levels: [Effort.Low, Effort.High, Effort.Max],
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4096,
};
const plain: Model = { ...reasoning, id: "plain", reasoning: false, thinking: undefined };
const toggle: Model = {
	...reasoning,
	id: "MiniMax-M3",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
	thinking: { mode: "effort", minLevel: Effort.High, maxLevel: Effort.High },
};
const alwaysOn: Model = { ...toggle, id: "MiniMax-M2.7", thinking: undefined };

describe("desktop public model capability mapping", () => {
	test("keeps discrete public effort membership and detached wire metadata", () => {
		const projected = projectDesktopModel(reasoning);
		expect(projected).toMatchObject({
			id: "desktop-fixture/discrete",
			contextWindow: 32_768,
			thinking: { mode: "budget" },
		});
		expect(projected.thinking.options.map(option => option.value)).toEqual(["off", "low", "high", "max"]);
		projected.thinking.options[0]!.label = "caller mutation";
		expect(projectDesktopModel(reasoning).thinking.options[0]!.label).toBe("off");
		expect(reasoning.thinking?.levels).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(projectDesktopThinkingOption(Effort.Minimal)).toEqual({ value: "minimal", label: "min" });
	});

	test("session projection reads the resolved level and SDK-owned scope", () => {
		const session = {
			model: reasoning,
			thinkingLevel: Effort.High,
			getThinkingScopeForControl: () => "session" as const,
		};
		expect(projectDesktopThinking(session)).toMatchObject({ level: "high", scope: "session", available: true });
		expect(validateSessionThinking(session, "max")).toBe(Effort.Max);
		for (const value of [undefined, null, true, {}, [], "", " high", "HIGH", "ultra", "medium", "xhigh", "inherit"])
			expect(() => validateSessionThinking(session, value)).toThrow(/thinking level/i);
	});

	test("no-model and nonreasoning sessions never advertise writable controls", () => {
		expect(projectDesktopThinking()).toMatchObject({
			available: false,
			scope: null,
			options: [],
			reason: "Open the session to read reasoning controls.",
		});
		const empty = {
			model: undefined,
			thinkingLevel: undefined,
			getThinkingScopeForControl: () => "session" as const,
		};
		expect(projectDesktopThinking(empty)).toMatchObject({
			level: null,
			available: false,
			reason: "No model is selected.",
		});
		expect(() => validateSessionThinking(empty, "off")).toThrow("No model is selected");
		const session = { ...empty, model: plain };
		expect(projectDesktopThinking(session)).toMatchObject({ options: [], available: false });
		expect(() => validateSessionThinking(session, "off")).toThrow("does not support");
		expect(validateModelThinking(plain, "off")).toBe("off");
		expect(() => validateModelThinking(plain, "high")).toThrow("Unsupported thinking level");
	});

	test("native toggle and always-on capabilities cannot become invented effort ranges", () => {
		expect(projectDesktopModel(toggle).thinking).toEqual({
			mode: "toggle",
			options: [
				{ value: "off", label: "off" },
				{ value: "high", label: "on" },
			],
		});
		expect(projectDesktopModel(alwaysOn).thinking).toEqual({ mode: "always-on", options: [] });
		expect(validateModelThinking(toggle, "off")).toBe("off");
		expect(validateModelThinking(toggle, "high")).toBe(Effort.High);
		for (const value of ["off", "low", "high", "inherit"])
			expect(() => validateModelThinking(alwaysOn, value)).toThrow("Unsupported thinking level");
	});

	test("malformed capability metadata fails closed rather than guessing levels", () => {
		const invalid: Model = {
			...reasoning,
			thinking: { mode: "effort", minLevel: Effort.High, maxLevel: Effort.Low, levels: [] },
		};
		expect(projectDesktopModel(invalid).thinking.options).toEqual([]);
		expect(() => validateModelThinking(invalid, "high")).toThrow("Unsupported thinking level");
	});
});

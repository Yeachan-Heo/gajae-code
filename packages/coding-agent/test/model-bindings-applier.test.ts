import { describe, expect, test } from "bun:test";
import { ModelBindingsApplier } from "../src/config/model-bindings-applier";
import type { Settings } from "../src/config/settings";

function createSettings(initial: {
	modelRoles: Record<string, string | string[]>;
	agentModelOverrides: Record<string, string | string[]>;
}) {
	const values = {
		modelRoles: { ...initial.modelRoles },
		"task.agentModelOverrides": { ...initial.agentModelOverrides },
	};
	const globalValues = {
		modelRoles: { ...initial.modelRoles },
		"task.agentModelOverrides": { ...initial.agentModelOverrides },
	};
	const overrides: Partial<typeof values> = {};
	function setManualValue(path: keyof typeof values, key: string, value: string | string[]) {
		globalValues[path][key] = value;
		overrides[path] = { ...(overrides[path] ?? {}), [key]: value };
		values[path] = { ...globalValues[path], ...overrides[path] };
	}
	function removeManualValue(path: keyof typeof values, key: string) {
		delete globalValues[path][key];
		if (overrides[path]) delete overrides[path][key];
		values[path] = { ...globalValues[path], ...overrides[path] };
	}
	return {
		values,
		setManualValue,
		removeManualValue,
		settings: {
			get(key: keyof typeof values) {
				return values[key];
			},
			getGlobal(key: keyof typeof values) {
				return globalValues[key];
			},
			getOverride(key: keyof typeof values) {
				return overrides[key];
			},
			override(key: keyof typeof values, value: (typeof values)[typeof key]) {
				values[key] = { ...globalValues[key], ...value };
				overrides[key] = value;
			},
			clearOverride(key: keyof typeof values) {
				delete overrides[key];
				values[key] = globalValues[key];
			},
		} as unknown as Settings,
	};
}

describe("ModelBindingsApplier", () => {
	test("forced configured bindings do not resurrect previously observed profile values", () => {
		const { settings, values } = createSettings({ modelRoles: {}, agentModelOverrides: {} });
		const applier = new ModelBindingsApplier();
		applier.setBindings({ modelRoles: { smol: "config/smol" } });
		applier.applyTo(settings);
		values.modelRoles.smol = "profile/smol";
		applier.apply();
		expect(values.modelRoles.smol).toBe("profile/smol");
		applier.forceApplyTo(settings);
		expect(values.modelRoles.smol).toBe("config/smol");
		applier.apply();
		expect(values.modelRoles.smol).toBe("config/smol");
	});

	test("restores untouched bindings while preserving user edits", () => {
		const { settings, values } = createSettings({
			modelRoles: { default: "openai/gpt-4.1" },
			agentModelOverrides: { executor: "anthropic/claude-sonnet" },
		});
		const applier = new ModelBindingsApplier();
		const configuredChain = ["openai/gpt-5", "anthropic/claude-opus"];

		applier.setBindings({
			modelRoles: { default: configuredChain },
			agentModelOverrides: { planner: "google/gemini-2.5-pro" },
		});
		applier.applyTo(settings);

		expect(values.modelRoles.default).toEqual(configuredChain);
		expect(values.modelRoles.default).not.toBe(configuredChain);
		expect(values["task.agentModelOverrides"]).toEqual({
			executor: "anthropic/claude-sonnet",
			planner: "google/gemini-2.5-pro",
		});

		values.modelRoles.default = "user/chosen-model";
		applier.setBindings(undefined);
		applier.apply();

		expect(values.modelRoles).toEqual({ default: "user/chosen-model" });
		expect(values["task.agentModelOverrides"]).toEqual({ executor: "anthropic/claude-sonnet" });
	});
	test("tracks later manual role and agent selections across reloads", () => {
		const { settings, values, setManualValue } = createSettings({ modelRoles: {}, agentModelOverrides: {} });
		const applier = new ModelBindingsApplier();
		applier.setBindings({
			modelRoles: { default: "config/role" },
			agentModelOverrides: { executor: "config/agent" },
		});
		applier.applyTo(settings);

		setManualValue("modelRoles", "default", "manual/role-b");
		setManualValue("task.agentModelOverrides", "executor", "manual/agent-b");
		applier.setBindings({
			modelRoles: { default: "config/role", reviewer: "config/reviewer" },
			agentModelOverrides: { executor: "config/agent", planner: "config/planner" },
		});
		applier.apply();

		setManualValue("modelRoles", "default", "manual/role-c");
		setManualValue("task.agentModelOverrides", "executor", "manual/agent-c");
		applier.apply();

		expect(values.modelRoles.default).toBe("manual/role-c");
		expect(values["task.agentModelOverrides"].executor).toBe("manual/agent-c");
	});

	test("preserves manual role and agent removals across reloads", () => {
		const { settings, values, setManualValue, removeManualValue } = createSettings({
			modelRoles: {},
			agentModelOverrides: {},
		});
		const applier = new ModelBindingsApplier();
		applier.setBindings({
			modelRoles: { default: "config/role" },
			agentModelOverrides: { executor: "config/agent" },
		});
		applier.applyTo(settings);

		setManualValue("modelRoles", "default", "manual/role-b");
		setManualValue("task.agentModelOverrides", "executor", "manual/agent-b");
		applier.setBindings({
			modelRoles: { default: "config/role", reviewer: "config/reviewer" },
			agentModelOverrides: { executor: "config/agent", planner: "config/planner" },
		});
		applier.apply();

		removeManualValue("modelRoles", "default");
		removeManualValue("task.agentModelOverrides", "executor");
		applier.apply();
		applier.setBindings(undefined);
		applier.apply();

		expect(Object.hasOwn(values.modelRoles, "default")).toBe(false);
		expect(Object.hasOwn(values["task.agentModelOverrides"], "executor")).toBe(false);
	});
	test("keeps binding lifecycle isolated per Settings instance", () => {
		const first = createSettings({
			modelRoles: { default: "first/baseline" },
			agentModelOverrides: { executor: "first/executor" },
		});
		const second = createSettings({
			modelRoles: { default: "second/baseline" },
			agentModelOverrides: { executor: "second/executor" },
		});
		const applier = new ModelBindingsApplier();

		applier.setBindings({
			modelRoles: { default: "config/default" },
			agentModelOverrides: { executor: "config/executor" },
		});
		applier.applyTo(first.settings);
		applier.applyTo(second.settings);

		expect(first.values).toEqual({
			modelRoles: { default: "first/baseline" },
			"task.agentModelOverrides": { executor: "first/executor" },
		});
		expect(second.values).toEqual({
			modelRoles: { default: "config/default" },
			"task.agentModelOverrides": { executor: "config/executor" },
		});
	});

	test("snapshots configured selector arrays before applying them", () => {
		const { settings, values } = createSettings({ modelRoles: {}, agentModelOverrides: {} });
		const applier = new ModelBindingsApplier();
		const configuredChain = ["config/primary", "config/fallback"];

		applier.setBindings({ modelRoles: { default: configuredChain } });
		configuredChain[0] = "caller/mutated";
		applier.applyTo(settings);

		expect(values.modelRoles.default).toEqual(["config/primary", "config/fallback"]);
	});
});

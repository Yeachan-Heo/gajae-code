import { describe, expect, test } from "bun:test";
import { ModelBindingsApplier } from "../src/config/model-bindings-applier";
import { Settings } from "../src/config/settings";

function createSettings(initial: {
	modelRoles: Record<string, string | string[]>;
	agentModelOverrides: Record<string, string | string[]>;
}) {
	const values = {
		modelRoles: { ...initial.modelRoles },
		"task.agentModelOverrides": { ...initial.agentModelOverrides },
	};
	return {
		values,
		settings: {
			get(key: keyof typeof values) {
				return values[key];
			},
			override(key: keyof typeof values, value: (typeof values)[typeof key]) {
				values[key] = value;
			},
		} as unknown as Settings,
	};
}

describe("ModelBindingsApplier", () => {
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

	test("snapshots applied bindings and lifecycle onto independent Settings", () => {
		const sourceSettings = Settings.isolated({
			modelRoles: { default: "baseline/default" },
			"task.agentModelOverrides": { executor: "baseline/executor" },
		});
		const sourceApplier = new ModelBindingsApplier();
		sourceApplier.setBindings({
			modelRoles: { default: ["configured/default", "configured/fallback"] },
			agentModelOverrides: { executor: ["configured/executor", "configured/executor-fallback"] },
		});
		sourceApplier.applyTo(sourceSettings);

		sourceSettings.override("modelRoles", {
			...sourceSettings.get("modelRoles"),
			default: "profile/default",
		});
		sourceSettings.override("task.agentModelOverrides", {
			...sourceSettings.get("task.agentModelOverrides"),
			executor: "profile/executor",
		});

		const capturedSettings = sourceSettings.snapshot();
		const fork = sourceApplier.snapshotForSettings(capturedSettings);
		expect(fork.getBindings()).toEqual(sourceApplier.getBindings());
		expect(capturedSettings.get("modelRoles").default).toBe("profile/default");
		expect(capturedSettings.get("task.agentModelOverrides").executor).toBe("profile/executor");

		// The fork already targets the captured Settings; this must not restore or retarget the source.
		fork.applyTo(capturedSettings);
		expect(sourceSettings.get("modelRoles").default).toBe("profile/default");
		expect(sourceSettings.get("task.agentModelOverrides").executor).toBe("profile/executor");

		const callerChain = ["fork/default", "fork/fallback"];
		fork.setBindings({
			modelRoles: { default: callerChain },
			agentModelOverrides: { executor: "fork/executor" },
		});
		callerChain[0] = "caller/mutated";
		fork.forceApplyTo(capturedSettings);
		fork.applyTo(capturedSettings);
		expect(capturedSettings.get("modelRoles").default).toEqual(["fork/default", "fork/fallback"]);
		expect(capturedSettings.get("task.agentModelOverrides").executor).toBe("fork/executor");
		expect(sourceApplier.getBindings()).toEqual({
			modelRoles: { default: ["configured/default", "configured/fallback"] },
			agentModelOverrides: { executor: ["configured/executor", "configured/executor-fallback"] },
		});
		expect(sourceSettings.get("modelRoles").default).toBe("profile/default");
		expect(sourceSettings.get("task.agentModelOverrides").executor).toBe("profile/executor");

		fork.setBindings(undefined);
		fork.apply();
		expect(capturedSettings.get("modelRoles").default).toBe("baseline/default");
		expect(capturedSettings.get("task.agentModelOverrides").executor).toBe("baseline/executor");

		sourceApplier.setBindings({
			modelRoles: { default: "source/default" },
			agentModelOverrides: { executor: "source/executor" },
		});
		sourceApplier.forceApplyTo(sourceSettings);
		fork.setBindings({
			modelRoles: { default: "fork/independent" },
			agentModelOverrides: { executor: "fork/independent" },
		});
		fork.forceApplyTo(capturedSettings);
		expect(sourceSettings.get("modelRoles").default).toBe("source/default");
		expect(sourceSettings.get("task.agentModelOverrides").executor).toBe("source/executor");
		expect(capturedSettings.get("modelRoles").default).toBe("fork/independent");
		expect(capturedSettings.get("task.agentModelOverrides").executor).toBe("fork/independent");
		expect(sourceApplier.getBindings()).toEqual({
			modelRoles: { default: "source/default" },
			agentModelOverrides: { executor: "source/executor" },
		});
		expect(fork.getBindings()).toEqual({
			modelRoles: { default: "fork/independent" },
			agentModelOverrides: { executor: "fork/independent" },
		});

		sourceApplier.setBindings(undefined);
		sourceApplier.apply();
		fork.setBindings(undefined);
		fork.apply();
		expect(sourceSettings.get("modelRoles").default).toBe("baseline/default");
		expect(sourceSettings.get("task.agentModelOverrides").executor).toBe("baseline/executor");
		expect(capturedSettings.get("modelRoles").default).toBe("baseline/default");
		expect(capturedSettings.get("task.agentModelOverrides").executor).toBe("baseline/executor");
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

import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

export interface ConfiguredModelBindings {
	modelRoles?: Record<string, ModelSelectorValue>;
	agentModelOverrides?: Record<string, ModelSelectorValue>;
}

/** Synchronizes config-owned model bindings while preserving user edits. */
export class ModelBindingsApplier {
	#targetSettings: Settings | undefined;
	#bindings: ConfiguredModelBindings | undefined;
	#appliedRoles = new Set<string>();
	#appliedAgentOverrides = new Set<string>();
	#roleBaselines = new Map<string, ModelSelectorValue | undefined>();
	#agentBaselines = new Map<string, ModelSelectorValue | undefined>();
	#lastAppliedRoles = new Map<string, ModelSelectorValue>();
	#lastAppliedAgentOverrides = new Map<string, ModelSelectorValue>();

	setBindings(bindings: ConfiguredModelBindings | undefined): void {
		this.#bindings = bindings && {
			modelRoles: this.#cloneBindings(bindings.modelRoles),
			agentModelOverrides: this.#cloneBindings(bindings.agentModelOverrides),
		};
	}

	applyTo(targetSettings: Settings): void {
		if (this.#targetSettings && this.#targetSettings !== targetSettings) {
			this.#restoreTarget(this.#targetSettings);
			this.#clearTargetLifecycle();
		}
		this.#targetSettings = targetSettings;
		this.apply();
	}

	apply(): void {
		const targetSettings = this.#targetSettings;
		if (!targetSettings) return;
		const bindings = this.#bindings;
		const nextModelRoles = { ...(targetSettings.get("modelRoles") ?? {}) };
		this.#sync(
			nextModelRoles,
			bindings?.modelRoles ?? {},
			this.#appliedRoles,
			this.#roleBaselines,
			this.#lastAppliedRoles,
		);
		targetSettings.override("modelRoles", nextModelRoles);

		const nextAgentOverrides = { ...(targetSettings.get("task.agentModelOverrides") ?? {}) };
		this.#sync(
			nextAgentOverrides,
			bindings?.agentModelOverrides ?? {},
			this.#appliedAgentOverrides,
			this.#agentBaselines,
			this.#lastAppliedAgentOverrides,
		);
		targetSettings.override("task.agentModelOverrides", nextAgentOverrides);
	}

	#restoreTarget(targetSettings: Settings): void {
		const modelRoles = { ...(targetSettings.get("modelRoles") ?? {}) };
		this.#sync(modelRoles, {}, this.#appliedRoles, this.#roleBaselines, this.#lastAppliedRoles);
		targetSettings.override("modelRoles", modelRoles);

		const agentOverrides = { ...(targetSettings.get("task.agentModelOverrides") ?? {}) };
		this.#sync(
			agentOverrides,
			{},
			this.#appliedAgentOverrides,
			this.#agentBaselines,
			this.#lastAppliedAgentOverrides,
		);
		targetSettings.override("task.agentModelOverrides", agentOverrides);
	}

	#clearTargetLifecycle(): void {
		this.#appliedRoles.clear();
		this.#appliedAgentOverrides.clear();
		this.#roleBaselines.clear();
		this.#agentBaselines.clear();
		this.#lastAppliedRoles.clear();
		this.#lastAppliedAgentOverrides.clear();
	}

	#sync(
		target: Record<string, ModelSelectorValue>,
		configured: Record<string, ModelSelectorValue>,
		applied: Set<string>,
		baselines: Map<string, ModelSelectorValue | undefined>,
		lastApplied: Map<string, ModelSelectorValue>,
	): void {
		const configuredKeys = new Set(Object.keys(configured));
		for (const key of applied) {
			if (configuredKeys.has(key)) continue;
			const previous = lastApplied.get(key);
			if (previous !== undefined && this.#equal(target[key], previous)) {
				const baseline = baselines.get(key);
				if (baseline === undefined) delete target[key];
				else target[key] = this.#clone(baseline)!;
			}
			baselines.delete(key);
			lastApplied.delete(key);
		}
		for (const [key, value] of Object.entries(configured)) {
			const previous = lastApplied.get(key);
			if (!baselines.has(key)) baselines.set(key, this.#clone(target[key]));
			if (previous === undefined || this.#equal(target[key], previous)) {
				const appliedValue = this.#clone(value)!;
				target[key] = appliedValue;
				lastApplied.set(key, this.#clone(appliedValue)!);
			}
		}
		applied.clear();
		for (const key of configuredKeys) applied.add(key);
	}

	#cloneBindings(
		bindings: Record<string, ModelSelectorValue> | undefined,
	): Record<string, ModelSelectorValue> | undefined {
		if (!bindings) return undefined;
		const copy: Record<string, ModelSelectorValue> = {};
		for (const [key, value] of Object.entries(bindings)) copy[key] = this.#clone(value)!;
		return copy;
	}

	#clone(value: ModelSelectorValue | undefined): ModelSelectorValue | undefined {
		return Array.isArray(value) ? [...value] : value;
	}

	#equal(left: ModelSelectorValue | undefined, right: ModelSelectorValue | undefined): boolean {
		const leftSelectors = normalizeModelSelectorValue(left);
		const rightSelectors = normalizeModelSelectorValue(right);
		return (
			leftSelectors.length === rightSelectors.length &&
			leftSelectors.every((value, index) => value === rightSelectors[index])
		);
	}
}

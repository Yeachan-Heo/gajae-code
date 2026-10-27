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
	#lastAppliedRoles = new Map<string, ModelSelectorValue>();
	#lastAppliedAgentOverrides = new Map<string, ModelSelectorValue>();
	#manualRoles = new Map<string, ModelSelectorValue | undefined>();
	#manualAgentOverrides = new Map<string, ModelSelectorValue | undefined>();
	#appliedRoles = new Set<string>();
	#appliedAgentOverrides = new Set<string>();
	#roleBaselines = new Map<string, ModelSelectorValue | undefined>();
	#agentBaselines = new Map<string, ModelSelectorValue | undefined>();

	/** The currently configured bindings (as installed at startup), for baseline lookup. */
	getBindings(): ConfiguredModelBindings | undefined {
		return (
			this.#bindings && {
				modelRoles: this.#cloneBindings(this.#bindings.modelRoles),
				agentModelOverrides: this.#cloneBindings(this.#bindings.agentModelOverrides),
			}
		);
	}

	setBindings(bindings: ConfiguredModelBindings | undefined): void {
		this.#bindings = bindings && {
			modelRoles: this.#cloneBindings(bindings.modelRoles),
			agentModelOverrides: this.#cloneBindings(bindings.agentModelOverrides),
		};
	}

	/** Fork configured bindings and their applied lifecycle onto independent settings. */
	snapshotForSettings(targetSettings: Settings): ModelBindingsApplier {
		const snapshot = new ModelBindingsApplier();
		snapshot.#targetSettings = targetSettings;
		snapshot.#bindings = this.getBindings();
		snapshot.#appliedRoles = new Set(this.#appliedRoles);
		snapshot.#appliedAgentOverrides = new Set(this.#appliedAgentOverrides);
		snapshot.#roleBaselines = this.#cloneSelectorMap(this.#roleBaselines);
		snapshot.#agentBaselines = this.#cloneSelectorMap(this.#agentBaselines);
		snapshot.#lastAppliedRoles = this.#cloneSelectorMap(this.#lastAppliedRoles);
		snapshot.#lastAppliedAgentOverrides = this.#cloneSelectorMap(this.#lastAppliedAgentOverrides);
		return snapshot;
	}

	applyTo(targetSettings: Settings): void {
		if (this.#targetSettings && this.#targetSettings !== targetSettings) {
			this.#restoreTarget(this.#targetSettings);
			this.#clearTargetLifecycle();
		}
		this.#targetSettings = targetSettings;
		this.apply();
	}

	/**
	 * Re-assert configured bindings into the target override slots, bypassing
	 * the user-edit-preservation heuristic. Used after a session-scoped profile
	 * reset removes profile-installed keys, so configured role/agent routing is
	 * restored exactly as it was installed at startup.
	 */
	forceApplyTo(targetSettings: Settings): void {
		if (this.#targetSettings && this.#targetSettings !== targetSettings) {
			this.#restoreTarget(this.#targetSettings);
			this.#clearTargetLifecycle();
		}
		this.#targetSettings = targetSettings;
		const bindings = this.#bindings;
		if (!targetSettings) return;
		for (const role of Object.keys(bindings?.modelRoles ?? {})) this.#manualRoles.delete(role);
		for (const role of Object.keys(bindings?.agentModelOverrides ?? {})) this.#manualAgentOverrides.delete(role);
		const modelRoles = { ...(targetSettings.get("modelRoles") ?? {}) };
		this.#forceSync(
			modelRoles,
			bindings?.modelRoles ?? {},
			this.#appliedRoles,
			this.#roleBaselines,
			this.#lastAppliedRoles,
		);
		targetSettings.override("modelRoles", modelRoles);
		const agentOverrides = { ...(targetSettings.get("task.agentModelOverrides") ?? {}) };
		this.#forceSync(
			agentOverrides,
			bindings?.agentModelOverrides ?? {},
			this.#appliedAgentOverrides,
			this.#agentBaselines,
			this.#lastAppliedAgentOverrides,
		);
		targetSettings.override("task.agentModelOverrides", agentOverrides);
	}

	#forceSync(
		target: Record<string, ModelSelectorValue>,
		configured: Record<string, ModelSelectorValue>,
		applied: Set<string>,
		baselines: Map<string, ModelSelectorValue | undefined>,
		lastApplied: Map<string, ModelSelectorValue>,
	): void {
		const configuredKeys = new Set(Object.keys(configured));
		for (const key of applied) {
			if (configuredKeys.has(key)) continue;
			const baseline = baselines.get(key);
			if (baseline === undefined) delete target[key];
			else target[key] = this.#clone(baseline)!;
		}
		for (const [key, value] of Object.entries(configured)) {
			if (!baselines.has(key)) baselines.set(key, this.#clone(target[key]));
			target[key] = this.#clone(value)!;
			lastApplied.set(key, this.#clone(value)!);
		}
		applied.clear();
		for (const key of Object.keys(configured)) applied.add(key);
	}

	apply(): void {
		const targetSettings = this.#targetSettings;
		if (!targetSettings) return;
		const bindings = this.#bindings;
		this.#sync(
			targetSettings,
			"modelRoles",
			bindings?.modelRoles ?? {},
			this.#lastAppliedRoles,
			this.#manualRoles,
			this.#roleBaselines,
		);
		this.#sync(
			targetSettings,
			"task.agentModelOverrides",
			bindings?.agentModelOverrides ?? {},
			this.#lastAppliedAgentOverrides,
			this.#manualAgentOverrides,
			this.#agentBaselines,
		);
	}

	#restoreTarget(targetSettings: Settings): void {
		this.#sync(
			targetSettings,
			"task.agentModelOverrides",
			{},
			this.#lastAppliedAgentOverrides,
			this.#manualAgentOverrides,
			this.#agentBaselines,
		);
		this.#sync(targetSettings, "modelRoles", {}, this.#lastAppliedRoles, this.#manualRoles, this.#roleBaselines);
	}

	#clearTargetLifecycle(): void {
		this.#lastAppliedRoles.clear();
		this.#lastAppliedAgentOverrides.clear();
		this.#manualRoles.clear();
		this.#manualAgentOverrides.clear();
		this.#roleBaselines.clear();
		this.#agentBaselines.clear();
	}

	#sync(
		targetSettings: Settings,
		settingPath: "modelRoles" | "task.agentModelOverrides",
		configured: Record<string, ModelSelectorValue>,
		lastApplied: Map<string, ModelSelectorValue>,
		manualOverrides: Map<string, ModelSelectorValue | undefined>,
		baselines: Map<string, ModelSelectorValue | undefined>,
	): void {
		const configuredKeys = new Set(Object.keys(configured));
		const current = (targetSettings.get(settingPath) ?? {}) as Record<string, ModelSelectorValue>;
		const global = (targetSettings.getGlobal(settingPath) ?? {}) as Record<string, ModelSelectorValue>;
		const runtime = targetSettings.getOverride(settingPath) ?? {};
		for (const key of configuredKeys) {
			if (!lastApplied.has(key) && !baselines.has(key)) baselines.set(key, this.#clone(runtime[key]));
		}

		// Manual bindings remain authoritative, but their cached values must follow
		// later edits and removals from the runtime override slots.
		for (const key of manualOverrides.keys()) {
			manualOverrides.set(key, this.#clone(runtime[key]));
		}

		// Keep existing non-global values that belong to another runtime layer.
		for (const [key, value] of Object.entries(current)) {
			if (configuredKeys.has(key) || lastApplied.has(key) || manualOverrides.has(key)) continue;
			if (!this.#equal(value, global[key])) manualOverrides.set(key, this.#clone(value)!);
		}

		// A value changed while our previous overlay was active is a manual edit.
		for (const [key, previous] of lastApplied) {
			const currentValue = current[key];
			if (!Object.hasOwn(runtime, key) || !Object.hasOwn(current, key)) {
				manualOverrides.set(key, undefined);
			} else if (!this.#equal(runtime[key], previous)) {
				manualOverrides.set(key, this.#clone(runtime[key])!);
			} else if (!this.#equal(currentValue, previous)) {
				manualOverrides.set(key, this.#clone(currentValue)!);
			}
		}

		const nextOverrides: Record<string, ModelSelectorValue> = {};
		for (const [key, value] of Object.entries(runtime)) {
			if (!lastApplied.has(key) && !configuredKeys.has(key)) nextOverrides[key] = this.#clone(value)!;
		}
		for (const [key, baseline] of baselines) {
			if (!configuredKeys.has(key)) {
				if (baseline !== undefined) nextOverrides[key] = this.#clone(baseline)!;
				baselines.delete(key);
			}
		}
		for (const [key, value] of manualOverrides) {
			if (value === undefined) delete nextOverrides[key];
			else nextOverrides[key] = this.#clone(value)!;
		}
		lastApplied.clear();
		for (const [key, value] of Object.entries(configured)) {
			if (manualOverrides.has(key)) continue;
			const appliedValue = this.#clone(value)!;
			nextOverrides[key] = appliedValue;
			lastApplied.set(key, this.#clone(appliedValue)!);
		}

		if (Object.keys(nextOverrides).length === 0) targetSettings.clearOverride(settingPath);
		else targetSettings.override(settingPath, nextOverrides);
	}

	#cloneBindings(
		bindings: Record<string, ModelSelectorValue> | undefined,
	): Record<string, ModelSelectorValue> | undefined {
		if (!bindings) return undefined;
		const copy: Record<string, ModelSelectorValue> = {};
		for (const [key, value] of Object.entries(bindings)) copy[key] = this.#clone(value)!;
		return copy;
	}

	#cloneSelectorMap<T extends ModelSelectorValue | undefined>(source: Map<string, T>): Map<string, T> {
		const copy = new Map<string, T>();
		for (const [key, value] of source) copy.set(key, this.#clone(value) as T);
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

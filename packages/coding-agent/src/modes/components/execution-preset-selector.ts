import { Container, Ellipsis, type SelectItem, SelectList, Text, truncateToWidth } from "@gajae-code/tui";
import {
	applyExecutionPreset,
	type ExecutionPreset,
	type ExecutionPresetApplyReceipt,
	type ExecutionPresetPreview,
	type ExecutionPresetScope,
	ExecutionPresetStore,
	previewExecutionPreset,
} from "../../config/execution-preset";
import type { ScopedConfigurationMutationService } from "../../config/scoped-configuration-mutation";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import type { TaskExecutionPolicyController } from "../../task/execution-policy";
import { DynamicBorder } from "./dynamic-border";

const SELECTABLE_SCOPES: readonly ExecutionPresetScope[] = ["session", "project", "user"];

export interface ExecutionPresetSelectorSource {
	/** Session-owned catalog used by the default adapter. */
	readonly store: ExecutionPresetStore;
	/** Session-owned policy controller. It is the only runtime policy mutation target. */
	readonly controller: TaskExecutionPolicyController;
	/** Current scope, when the host owns scope state outside the component. */
	readonly scope?: ExecutionPresetScope;
	readonly currentScope?: ExecutionPresetScope;
	readonly getScope?: () => ExecutionPresetScope;
	readonly setScope?: (scope: ExecutionPresetScope) => void;
	/** Scope-specific stores let fixtures and hosts provide loaded project/user catalogs. */
	readonly getStoreForScope?: (scope: ExecutionPresetScope) => ExecutionPresetStore;
	readonly storeForScope?: (scope: ExecutionPresetScope) => ExecutionPresetStore;
	readonly scopes?: readonly ExecutionPresetScope[];
	/** Optional writer used when the scope-specific store is constructed by this adapter. */
	readonly scopedMutationService?: Pick<ScopedConfigurationMutationService, "read" | "mutate">;
	/** Optional pure seams for fixtures; omitted values use the real store/controller APIs. */
	readonly previewPreset?: (
		store: ExecutionPresetStore,
		id: string,
		controller: TaskExecutionPolicyController,
		scope: ExecutionPresetScope,
	) => ExecutionPresetPreview;
	readonly applyPreset?: (
		store: ExecutionPresetStore,
		preview: ExecutionPresetPreview,
		controller: TaskExecutionPolicyController,
		scope: ExecutionPresetScope,
		signal: AbortSignal,
	) => Promise<ExecutionPresetApplyReceipt>;
}

export interface ExecutionPresetSelectorCallbacks {
	readonly onCancel?: () => void;
	readonly onApplied?: (receipt: ExecutionPresetApplyReceipt) => void;
	readonly onDeleted?: (presetId: string) => void;
	readonly onStatus?: (status: string) => void;
	readonly requestRender?: () => void;
}

type SelectorView = "list" | "preview" | "delete";

function isSelectableScope(scope: ExecutionPresetScope): boolean {
	return SELECTABLE_SCOPES.includes(scope);
}

function cleanText(value: string, fallback = ""): string {
	const cleaned = value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\bhttps?:\/\/[^\s]+/giu, "<redacted>")
		.replace(
			/\b((?:path|file|cwd|dir|directory|output)\s*[:=]\s*)['"]?(?:file:\/\/)?(?:~|\.{1,2}|\/|[A-Za-z]:[\\/])[^\s'"]*['"]?/giu,
			"$1<redacted>",
		)
		.replace(/(?:^|\s)(?:~|\.{1,2}|\/|[A-Za-z]:[\\/])[^\s]*/gu, " <redacted>")
		.replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
		.replace(/\b(?:sk|pk|ghp|xox[baprs])-[-_A-Za-z0-9]+/gu, "<redacted>")
		.replace(/\s+/gu, " ")
		.trim();
	return cleaned || fallback;
}

function scopeName(scope: ExecutionPresetScope): string {
	return scope === "session" ? "Session" : scope === "project" ? "Project" : scope === "user" ? "User" : "Managed";
}

function formatDuration(durationMs: number | null): string {
	if (durationMs === null) return "unbounded";
	const minutes = durationMs / 60_000;
	const renderedMinutes = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
	return `${durationMs} ms (${renderedMinutes} min)`;
}

function formatTools(policy: ExecutionPreset["policy"]): string {
	const allow = policy.toolAccess.allow.length > 0 ? policy.toolAccess.allow.join(", ") : "none";
	const deny = policy.toolAccess.deny.length > 0 ? policy.toolAccess.deny.join(", ") : "none";
	return `allow ${allow}; deny ${deny}`;
}

function receiptStatus(receipt: ExecutionPresetApplyReceipt): string {
	const scope = scopeName(receipt.scope);
	if (receipt.ok && (receipt.status === "applied" || receipt.status === "committed")) {
		return `Applied for ${scope}; timing ${receipt.timing}; durability ${receipt.durability}.`;
	}
	if (receipt.status === "degraded") {
		const runtimeActivated =
			receipt.controllerRevision > 0 &&
			(receipt.reason === "persistent_reload_mismatch" || receipt.reason === "persistent_reload_unconfirmed");
		return runtimeActivated
			? `Status: Saved for ${scope}; runtime active, verification degraded.`
			: `Saved for ${scope}, but runtime policy was not activated.`;
	}
	if (receipt.status === "conflict")
		return `The ${scope.toLocaleLowerCase("en-US")} preset changed elsewhere; no change was applied.`;
	if (receipt.status === "locked")
		return `The ${scope.toLocaleLowerCase("en-US")} scope is locked; no change was applied.`;
	return "The preset could not be applied; no change was applied.";
}

function mutationStatus(status: string): string {
	if (status === "degraded") return "Saved, but the runtime policy was not activated.";
	if (status === "conflict") return "The preset changed elsewhere; no change was applied.";
	if (status === "locked") return "This scope is locked; no change was applied.";
	return "The preset could not be deleted.";
}

/**
 * Production execution-preset selector. The component owns only presentation
 * state; all policy and persistence changes go through the source's store and
 * controller APIs, which keeps Work Mode completely out of this surface.
 */
export class ExecutionPresetSelectorComponent extends Container {
	#source: ExecutionPresetSelectorSource;
	#callbacks: ExecutionPresetSelectorCallbacks;
	#scope: ExecutionPresetScope;
	#stores = new Map<ExecutionPresetScope, ExecutionPresetStore>();
	#selectList: SelectList | undefined;
	#view: SelectorView = "list";
	#selectedPresetId: string | undefined;
	#preview: ExecutionPresetPreview | undefined;
	#status = "";
	#busy = false;
	#disposed = false;
	#operationGeneration = 0;
	#pendingApplyAbortController: AbortController | undefined;
	#pendingDeleteAbortController: AbortController | undefined;

	constructor(source: ExecutionPresetSelectorSource, callbacks: ExecutionPresetSelectorCallbacks = {}) {
		super();
		this.#source = source;
		this.#callbacks = callbacks;
		this.#scope = this.#initialScope();
		this.#stores.set(source.store.scope, source.store);
		this.#renderList();
	}

	getSelectList(): SelectList {
		if (!this.#selectList) throw new Error("Execution preset preview has no select list");
		return this.#selectList;
	}

	getScope(): ExecutionPresetScope {
		return this.#scope;
	}

	getView(): SelectorView {
		return this.#view;
	}

	getPreview(): ExecutionPresetPreview | undefined {
		return this.#preview;
	}

	override render(width: number): string[] {
		return super.render(Math.max(1, width)).map(line => truncateToWidth(line, Math.max(1, width), Ellipsis.Omit));
	}

	handleInput(data: string): void {
		if (this.#disposed || this.#busy) return;
		if (this.#view === "list") {
			if (data.toLocaleLowerCase("en-US") === "s") {
				this.#cycleScope();
				return;
			}
			if (data.toLocaleLowerCase("en-US") === "d") {
				this.#openDeleteConfirmation();
				return;
			}
			this.#selectList?.handleInput(data);
			return;
		}
		if (this.#view === "preview") {
			if (data === "\x1b" || data === "\u001b") {
				this.#renderList();
				return;
			}
			if (data.toLocaleLowerCase("en-US") === "s") {
				this.#cycleScope();
				if (this.#selectedPresetId) this.#openPreview(this.#selectedPresetId);
				return;
			}
			if (data === "\n" || data === "\r" || data.toLocaleLowerCase("en-US") === "y") {
				this.#applyPreview();
			}
			return;
		}
		if (data === "\x1b" || data === "\u001b" || data.toLocaleLowerCase("en-US") === "n") {
			this.#renderList();
			return;
		}
		if (data === "\n" || data === "\r" || data.toLocaleLowerCase("en-US") === "y") {
			this.#deleteSelected();
		}
	}

	#initialScope(): ExecutionPresetScope {
		const candidate =
			this.#source.getScope?.() ?? this.#source.currentScope ?? this.#source.scope ?? this.#source.store.scope;
		return candidate;
	}

	#scopeOptions(): readonly ExecutionPresetScope[] {
		const configured = this.#source.scopes?.filter(isSelectableScope) ?? [];
		if (configured.length > 0) return configured;
		return this.#source.scopedMutationService ? SELECTABLE_SCOPES : ["session"];
	}

	#storeFor(scope: ExecutionPresetScope): ExecutionPresetStore {
		const cached = this.#stores.get(scope);
		if (cached) return cached;
		const supplied = this.#source.getStoreForScope?.(scope) ?? this.#source.storeForScope?.(scope);
		if (supplied) {
			this.#stores.set(scope, supplied);
			return supplied;
		}
		if (scope !== "session" && !this.#source.scopedMutationService)
			throw new Error(`Execution preset scope is unavailable: ${scope}`);
		const store = new ExecutionPresetStore({
			scope,
			scopedMutationService: this.#source.scopedMutationService,
		});
		this.#stores.set(scope, store);
		return store;
	}

	#currentStore(): ExecutionPresetStore {
		return this.#storeFor(this.#scope);
	}

	#abortPendingApply(): void {
		const controller = this.#pendingApplyAbortController;
		this.#pendingApplyAbortController = undefined;
		controller?.abort();
	}
	#abortPendingDelete(): void {
		const controller = this.#pendingDeleteAbortController;
		this.#pendingDeleteAbortController = undefined;
		controller?.abort();
	}
	#cycleScope(): void {
		if (this.#disposed) return;
		const scopes = this.#scopeOptions();
		const currentIndex = scopes.indexOf(this.#scope);
		const next = scopes[(currentIndex + 1 + scopes.length) % scopes.length] ?? "session";
		this.#scope = next;
		this.#source.setScope?.(next);
		this.#preview = undefined;
		this.#status = `Scope: ${scopeName(next)}.`;
		if (this.#view === "list") this.#renderList();
		else this.#renderPreviewText();
		this.#callbacks.onStatus?.(this.#status);
		this.#callbacks.requestRender?.();
	}

	#items(store: ExecutionPresetStore): readonly SelectItem[] {
		const presets = [...store.list()];
		const curatedIds = new Map<string, number>();
		for (const [index, preset] of store.catalog.entries()) {
			if (preset.kind === "curated") curatedIds.set(preset.id, index);
		}
		presets.sort((left, right) => {
			const leftCurated = curatedIds.get(left.id);
			const rightCurated = curatedIds.get(right.id);
			if (leftCurated !== undefined && rightCurated !== undefined) return leftCurated - rightCurated;
			if (leftCurated !== undefined) return -1;
			if (rightCurated !== undefined) return 1;
			return left.id.localeCompare(right.id, "en-US");
		});
		return presets.map(preset => ({
			value: preset.id,
			label: cleanText(`${preset.label} · ${preset.id}`, preset.id),
			description: cleanText(preset.description),
		}));
	}

	#renderList(): void {
		if (this.#disposed) return;
		this.#view = "list";
		this.#preview = undefined;
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Execution presets")), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Scope: ${scopeName(this.#scope)}`), 1, 0));
		const items = this.#items(this.#currentStore());
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 10), getSelectListTheme());
		if (this.#selectedPresetId) {
			const selectedIndex = items.findIndex(item => item.value === this.#selectedPresetId);
			if (selectedIndex >= 0) this.#selectList.setSelectedIndex(selectedIndex);
		}
		this.#selectList.onSelect = item => this.#openPreview(item.value);
		this.#selectList.onCancel = () => this.#callbacks.onCancel?.();
		this.addChild(this.#selectList);
		this.addChild(new Text(theme.fg("dim", "s Scope · Enter Preview/Apply · d Delete custom · Esc Back"), 1, 0));
		if (this.#status) this.addChild(new Text(theme.fg("muted", cleanText(this.#status)), 1, 0));
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender?.();
	}

	#openPreview(id: string): void {
		if (this.#disposed) return;
		const store = this.#currentStore();
		try {
			const preview = this.#source.previewPreset
				? this.#source.previewPreset(store, id, this.#source.controller, this.#scope)
				: previewExecutionPreset(store, id, this.#source.controller, this.#scope);
			this.#selectedPresetId = id;
			this.#preview = preview;
			this.#view = "preview";
			this.#status = "";
			this.#renderPreviewText();
		} catch {
			this.#status = "The selected preset is unavailable; no change was made.";
			this.#renderList();
		}
	}

	#renderPreviewText(): void {
		if (this.#disposed) return;
		if (!this.#preview) {
			this.#renderList();
			return;
		}
		this.#view = "preview";
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(
			new Text(theme.bold(theme.fg("accent", `Preview: ${cleanText(this.#preview.preset.label)}`)), 1, 0),
		);
		const policy = this.#preview.after.policy;
		const changed = this.#preview.changedFields.length > 0 ? this.#preview.changedFields.join(", ") : "none";
		const warningLines = this.#preview.warnings.map(warning => `Warning: ${cleanText(warning)}`);
		const lines = [
			`ID: ${cleanText(this.#preview.preset.id)}`,
			`Isolation: ${cleanText(policy.isolation)}`,
			`Tools: ${cleanText(formatTools(policy))}`,
			`MCP discovery: ${cleanText(policy.mcpDiscovery)}`,
			`Timeout: ${formatDuration(policy.maxDurationMs)}`,
			`Simple mode: ${policy.simpleMode ? "enabled" : "disabled"}`,
			`Changed fields: ${cleanText(changed)}`,
			...warningLines,
			`Scope: ${scopeName(this.#preview.scope)}`,
			`Timing: ${this.#preview.timingExpectation}`,
			`Durability: ${this.#preview.durabilityExpectation}`,
			"Work Mode: unchanged",
		];
		if (this.#status) lines.push(`Status: ${cleanText(this.#status)}`);
		this.addChild(new Text(lines.join("\n"), 1, 0));
		this.addChild(new Text(theme.fg("dim", "Enter Apply · s Scope · Esc Back"), 1, 0));
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender?.();
	}

	#applyPreview(): void {
		if (this.#disposed || this.#busy) return;
		const preview = this.#preview;
		if (!preview || !this.#selectedPresetId) return;
		this.#abortPendingApply();
		this.#abortPendingDelete();
		const generation = ++this.#operationGeneration;
		this.#busy = true;
		const abortController = new AbortController();
		this.#pendingApplyAbortController = abortController;
		const store = this.#currentStore();
		const operation = this.#source.applyPreset
			? this.#source.applyPreset(store, preview, this.#source.controller, this.#scope, abortController.signal)
			: applyExecutionPreset(store, preview, this.#source.controller, {
					scope: this.#scope,
					preview,
					signal: abortController.signal,
				});
		void Promise.resolve(operation)
			.then(receipt => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				this.#status = receiptStatus(receipt);
				this.#callbacks.onApplied?.(receipt);
				this.#callbacks.onStatus?.(this.#status);
				this.#renderPreviewText();
			})
			.catch(() => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				this.#status = "The preset could not be applied; no change was applied.";
				this.#callbacks.onStatus?.(this.#status);
				this.#renderPreviewText();
			})
			.finally(() => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				this.#busy = false;
				if (this.#pendingApplyAbortController === abortController) this.#pendingApplyAbortController = undefined;
				this.#callbacks.requestRender?.();
			});
	}

	#openDeleteConfirmation(): void {
		if (this.#disposed) return;
		const selected = this.#selectList?.getSelectedItem();
		if (!selected) return;
		const preset = this.#currentStore().get(selected.value);
		if (preset?.kind !== "custom") {
			this.#status = "Only custom presets can be deleted.";
			this.#renderList();
			return;
		}
		this.#selectedPresetId = preset.id;
		this.#view = "delete";
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("warning", `Delete ${cleanText(preset.label)}?`)), 1, 0));
		this.addChild(new Text(theme.fg("muted", "This removes the custom preset from the selected scope."), 1, 0));
		this.addChild(new Text(theme.fg("dim", "Enter/y Confirm · n/Esc Back"), 1, 0));
		this.addChild(new DynamicBorder());
		this.#callbacks.requestRender?.();
	}

	#deleteSelected(): void {
		if (this.#disposed || this.#busy || !this.#selectedPresetId) return;
		this.#abortPendingApply();
		this.#abortPendingDelete();
		const presetId = this.#selectedPresetId;
		const generation = ++this.#operationGeneration;
		this.#busy = true;
		const abortController = new AbortController();
		this.#pendingDeleteAbortController = abortController;
		const store = this.#currentStore();
		void store
			.deleteCustom(presetId, { signal: abortController.signal })
			.then(receipt => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				if (receipt.ok) {
					this.#status = `Deleted from ${scopeName(receipt.scope)}.`;
					this.#callbacks.onDeleted?.(presetId);
				} else {
					this.#status = mutationStatus(receipt.status);
				}
				this.#renderList();
			})
			.catch(() => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				this.#status = "The preset could not be deleted.";
				this.#renderList();
			})
			.finally(() => {
				if (this.#disposed || generation !== this.#operationGeneration) return;
				this.#busy = false;
				if (this.#pendingDeleteAbortController === abortController) this.#pendingDeleteAbortController = undefined;
				this.#callbacks.requestRender?.();
			});
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortPendingApply();
		this.#abortPendingDelete();
		this.#operationGeneration += 1;
		this.#busy = false;
		this.#selectList = undefined;
		super.dispose();
	}
}

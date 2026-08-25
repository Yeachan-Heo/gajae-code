import { Container, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import {
	applyGjcBundleUpdate,
	type GjcLifecycleContext,
	getGjcBundle,
	listGjcBundles,
	previewGjcBundleUpdate,
	setGjcBundleEnabled,
	setGjcBundleSurfaceEnabled,
} from "../../extensibility/gjc-plugins/lifecycle";
import { identityEquals, identityKey } from "../../extensibility/gjc-plugins/lifecycle-reconciliation";
import { findingsForBundle, type GjcRuntimeSnapshotProvider } from "../../extensibility/gjc-plugins/runtime-quarantine";
import type {
	GjcBundleIdentity,
	GjcBundleSummary,
	GjcLifecycleResult,
	GjcReviewedUpdateToken,
	GjcToggleResult,
	GjcUpdateApplyResult,
	GjcUpdatePreview,
} from "../../extensibility/gjc-plugins/types";
import { getSelectListTheme, theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

/** Injectable lifecycle boundary; Settings never reads registries or executes bundle code. */
export interface GjcBundleLifecyclePort {
	listGjcBundles(ctx: GjcLifecycleContext): Promise<GjcBundleSummary[]>;
	getGjcBundle(ctx: GjcLifecycleContext, identity: GjcBundleIdentity): Promise<GjcLifecycleResult<GjcBundleSummary>>;
	previewGjcBundleUpdate(
		ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
	): Promise<GjcLifecycleResult<GjcUpdatePreview>>;
	applyGjcBundleUpdate(
		ctx: GjcLifecycleContext,
		token: GjcReviewedUpdateToken,
	): Promise<GjcLifecycleResult<GjcUpdateApplyResult>>;
	setGjcBundleEnabled(
		ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
		enabled: boolean,
	): Promise<GjcLifecycleResult<GjcToggleResult>>;
	setGjcBundleSurfaceEnabled(
		ctx: GjcLifecycleContext,
		identity: GjcBundleIdentity,
		surfaceId: string,
		enabled: boolean,
	): Promise<GjcLifecycleResult<GjcToggleResult>>;
}

export interface GjcBundleSettingsDependencies {
	lifecycle?: GjcBundleLifecyclePort;
	runtimeSnapshotProvider?: GjcRuntimeSnapshotProvider;
	activationGeneration?: number;
}

export interface GjcBundleSettingsCallbacks {
	onClose: () => void;
	onBundlesChanged?: () => void;
	onRenderRequested?: () => void;
}

export type GjcBundleSettingsState =
	| "loading"
	| "error"
	| "empty"
	| "list"
	| "detail"
	| "unsupported-source"
	| "update-review"
	| "update-confirm"
	| "update-running"
	| "update-result"
	| "stale-result"
	| "quarantined-blocked"
	| "mutation-in-flight-locked";

const PRODUCTION_LIFECYCLE: GjcBundleLifecyclePort = {
	listGjcBundles,
	getGjcBundle,
	previewGjcBundleUpdate,
	applyGjcBundleUpdate,
	setGjcBundleEnabled,
	setGjcBundleSurfaceEnabled,
};

/** Scope-qualified, lifecycle-backed Settings UI for installed GJC bundles. */
export class GjcBundleSettingsComponent extends Container {
	#input: SelectList | null = null;
	#bundles: GjcBundleSummary[] = [];
	#focused: GjcBundleIdentity | null = null;
	#preview: GjcUpdatePreview | null = null;
	#state: GjcBundleSettingsState = "loading";
	#message: string | null = null;
	#navigationLocked = false;
	#disposed = false;

	constructor(
		cwd: string,
		agentDir: string | undefined,
		private readonly callbacks: GjcBundleSettingsCallbacks,
		private readonly dependencies: GjcBundleSettingsDependencies = {},
	) {
		super();
		this.#context = { cwd, agentDir };
		void this.#load();
	}

	readonly #context: GjcLifecycleContext;

	get stateId(): GjcBundleSettingsState {
		return this.#state;
	}

	get navigationLocked(): boolean {
		return this.#navigationLocked;
	}

	get #lifecycle(): GjcBundleLifecyclePort {
		return this.dependencies.lifecycle ?? PRODUCTION_LIFECYCLE;
	}

	async #load(): Promise<void> {
		this.#state = "loading";
		this.#message = null;
		this.#render();
		try {
			this.#bundles = await this.#lifecycle.listGjcBundles(this.#context);
			if (this.#disposed) return;
			this.#state = this.#bundles.length === 0 ? "empty" : "list";
		} catch {
			if (this.#disposed) return;
			this.#state = "error";
			this.#message = "Unable to load GJC bundles.";
		}
		this.#render();
	}

	#render(): void {
		if (this.#disposed) return;
		this.clear();
		this.#input = null;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "  GJC Bundles")), 0, 0));
		this.addChild(new Spacer(1));
		switch (this.#state) {
			case "loading":
				this.addChild(new Text(theme.fg("muted", "  Loading installed bundles…"), 0, 0));
				this.#renderActionList([]);
				break;
			case "error":
				this.#renderActionList([
					{ value: "retry", label: "Retry", description: this.#message ?? "Unable to load GJC bundles." },
				]);
				break;
			case "empty":
				this.addChild(new Text(theme.fg("muted", "  No GJC bundles installed"), 0, 0));
				this.#renderActionList([]);
				break;
			case "list":
				this.#renderList();
				break;
			case "detail":
			case "unsupported-source":
			case "quarantined-blocked":
			case "update-result":
			case "stale-result":
				this.#renderDetail();
				break;
			case "update-review":
			case "update-confirm":
				this.#renderUpdateReview();
				break;
			case "update-running":
			case "mutation-in-flight-locked":
				this.addChild(new Text(theme.fg("muted", "  Applying non-cancellable bundle change…"), 0, 0));
				break;
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					this.#navigationLocked
						? "  Navigation locked while mutation runs"
						: "  Enter to select · Esc to go back",
				),
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
		this.callbacks.onRenderRequested?.();
	}

	#renderList(): void {
		const items: SelectItem[] = this.#bundles.map(bundle => {
			const runtime = findingsForBundle(
				this.dependencies.runtimeSnapshotProvider,
				bundle.identity,
				this.dependencies.activationGeneration ?? 0,
			);
			const intent = bundle.enabled ? "enabled" : "disabled";
			const quarantine = bundle.quarantined ? " · quarantined" : "";
			const effective =
				runtime.status === "unavailable"
					? "runtime unavailable"
					: runtime.findings.length > 0
						? "runtime findings"
						: "runtime current";
			return {
				value: identityKey(bundle.identity),
				label: `${bundle.identity.name} (${bundle.identity.scope})`,
				description: `v${bundle.version} · ${intent}${quarantine} · ${effective}`,
			};
		});
		this.#renderActionList(items);
	}

	#renderDetail(): void {
		const bundle = this.#bundleForFocus();
		if (!bundle) {
			this.#state = "list";
			this.#render();
			return;
		}
		this.addChild(
			new Text(theme.fg("muted", `  ${bundle.identity.name} (${bundle.identity.scope}) · v${bundle.version}`), 0, 0),
		);
		if (bundle.description) this.addChild(new Text(theme.fg("muted", `  ${bundle.description}`), 0, 0));
		this.addChild(new Text(theme.fg("dim", `  Source: ${bundle.source.display}`), 0, 0));
		if (bundle.source.ref) this.addChild(new Text(theme.fg("dim", `  Ref: ${bundle.source.ref}`), 0, 0));
		if (bundle.source.sha) this.addChild(new Text(theme.fg("dim", `  SHA: ${bundle.source.sha}`), 0, 0));
		this.addChild(
			new Text(theme.fg("dim", `  Installed: ${bundle.installedAt} · Updated: ${bundle.updatedAt}`), 0, 0),
		);
		if (!bundle.source.updatable) {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						`  Update unsupported: ${bundle.source.unsupportedReason ?? "This source cannot be refreshed."}`,
					),
					0,
					0,
				),
			);
		}
		if (this.#message) this.addChild(new Text(theme.fg("warning", `  ${this.#message}`), 0, 0));
		const actions: SelectItem[] = [];
		if (bundle.enabled || !bundle.quarantined) {
			actions.push({
				value: `bundle:${bundle.enabled ? "disable" : "enable"}`,
				label: bundle.enabled ? "Disable bundle" : "Enable bundle",
			});
		} else {
			actions.push({
				value: "bundle:blocked",
				label: "Enable bundle (blocked)",
				description: "Quarantined bundles cannot be enabled.",
			});
		}
		if (bundle.source.updatable) actions.push({ value: "update", label: "Review update" });
		for (const surface of bundle.surfaces) {
			const action = surface.enabled ? "disable" : surface.quarantined ? "blocked" : "enable";
			actions.push({
				value: `surface:${surface.extensionId}:${action}`,
				label: `${surface.name} (${surface.kind})`,
				description: `${surface.enabled ? "enabled" : "disabled"}${surface.quarantined ? " · quarantined" : ""}`,
			});
		}
		this.#renderActionList(actions);
	}

	#renderUpdateReview(): void {
		const preview = this.#preview;
		if (!preview) return;
		this.addChild(new Text(theme.fg("muted", `  ${preview.identity.name} (${preview.identity.scope})`), 0, 0));
		this.addChild(new Text(theme.fg("muted", `  v${preview.current.version} → v${preview.candidateVersion}`), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  Surfaces: +${preview.addedSurfaceIds.length} −${preview.removedSurfaceIds.length} =${preview.retainedSurfaceIds.length}`,
				),
				0,
				0,
			),
		);
		if (!preview.changed) this.addChild(new Text(theme.fg("muted", "  No update changes were found."), 0, 0));
		this.#renderActionList([
			this.#state === "update-review"
				? { value: "continue-update", label: "Continue to confirmation" }
				: { value: "apply-update", label: "Apply update", description: "This operation cannot be cancelled." },
		]);
	}

	#renderActionList(items: SelectItem[]): void {
		this.#input = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
		this.#input.onSelect = item => this.#select(item.value);
		this.#input.onCancel = () => this.#back();
		this.addChild(this.#input);
	}

	#select(value: string): void {
		if (this.#navigationLocked) return;
		if (value === "retry") {
			void this.#load();
			return;
		}
		if (this.#state === "list") {
			const bundle = this.#bundles.find(candidate => identityKey(candidate.identity) === value);
			if (bundle) {
				this.#focused = bundle.identity;
				this.#state = bundle.source.updatable ? "detail" : "unsupported-source";
				this.#render();
			}
			return;
		}
		if (value === "update") {
			void this.#reviewUpdate();
			return;
		}
		if (value === "continue-update") {
			this.#state = "update-confirm";
			this.#render();
			return;
		}
		if (value === "apply-update") {
			void this.#applyUpdate();
			return;
		}
		if (value === "bundle:blocked" || value.endsWith(":blocked")) {
			this.#state = "quarantined-blocked";
			this.#message = "quarantined: enable is blocked; disable remains available.";
			this.#render();
			return;
		}
		if (value.startsWith("bundle:")) {
			void this.#toggleBundle(value === "bundle:enable");
			return;
		}
		if (value.startsWith("surface:")) {
			const encoded = value.slice("surface:".length);
			const separator = encoded.lastIndexOf(":");
			const surfaceId = encoded.slice(0, separator);
			const action = encoded.slice(separator + 1);
			if (separator > 0 && surfaceId && action) void this.#toggleSurface(surfaceId, action === "enable");
		}
	}

	async #reviewUpdate(): Promise<void> {
		const bundle = this.#bundleForFocus();
		if (!bundle) return;
		this.#message = null;
		try {
			const result = await this.#lifecycle.previewGjcBundleUpdate(this.#context, bundle.identity);
			if (this.#disposed || !this.#isFocused(bundle.identity)) return;
			if (!result.ok) {
				this.#state = result.error.code === "source_unsupported" ? "unsupported-source" : "detail";
				this.#message = result.error.message;
			} else {
				this.#preview = result.value;
				this.#state = "update-review";
			}
		} catch {
			if (this.#disposed || !this.#isFocused(bundle.identity)) return;
			this.#state = "detail";
			this.#message = "Unable to review this update.";
		}
		this.#render();
	}

	async #applyUpdate(): Promise<void> {
		const preview = this.#preview;
		if (!preview) return;
		await this.#mutate(preview.identity, "update-running", async () => {
			const result = await this.#lifecycle.applyGjcBundleUpdate(this.#context, preview.token);
			if (this.#disposed || !this.#isFocused(preview.identity)) return;
			if (!result.ok) {
				if (result.error.code.startsWith("stale_")) {
					this.#state = "stale-result";
					this.#message = `${result.error.message} Re-review the update.`;
				} else {
					this.#state = "detail";
					this.#message = result.error.message;
				}
				return;
			}
			this.#replaceSummary(result.value.summary);
			this.#state = "update-result";
			this.#message = result.value.status === "updated" ? "Update applied." : "Already up to date.";
			this.callbacks.onBundlesChanged?.();
		});
	}

	async #toggleBundle(enabled: boolean): Promise<void> {
		const bundle = this.#bundleForFocus();
		if (!bundle) return;
		if (enabled && bundle.quarantined) {
			this.#state = "quarantined-blocked";
			this.#message = "quarantined: enable is blocked; disable remains available.";
			this.#render();
			return;
		}
		await this.#mutate(bundle.identity, "mutation-in-flight-locked", async () => {
			const result = await this.#lifecycle.setGjcBundleEnabled(this.#context, bundle.identity, enabled);
			if (this.#disposed || !this.#isFocused(bundle.identity)) return;
			this.#applyToggleResult(result);
		});
	}

	async #toggleSurface(surfaceId: string, enabled: boolean): Promise<void> {
		const bundle = this.#bundleForFocus();
		if (!bundle) return;
		const surface = bundle.surfaces.find(candidate => candidate.extensionId === surfaceId);
		if (enabled && surface?.quarantined) {
			this.#state = "quarantined-blocked";
			this.#message = "quarantined: enable is blocked; disable remains available.";
			this.#render();
			return;
		}
		await this.#mutate(bundle.identity, "mutation-in-flight-locked", async () => {
			const result = await this.#lifecycle.setGjcBundleSurfaceEnabled(
				this.#context,
				bundle.identity,
				surfaceId,
				enabled,
			);
			if (this.#disposed || !this.#isFocused(bundle.identity)) return;
			this.#applyToggleResult(result);
		});
	}

	#applyToggleResult(result: GjcLifecycleResult<GjcToggleResult>): void {
		if (!result.ok) {
			this.#state = result.error.code === "quarantined" ? "quarantined-blocked" : "detail";
			this.#message = result.error.message;
			return;
		}
		this.#replaceSummary(result.value.summary);
		this.#state = "detail";
		this.#message = null;
		this.callbacks.onBundlesChanged?.();
	}

	async #mutate(
		identity: GjcBundleIdentity,
		runningState: "update-running" | "mutation-in-flight-locked",
		operation: () => Promise<void>,
	): Promise<void> {
		if (this.#navigationLocked) return;
		this.#navigationLocked = true;
		this.#state = runningState;
		this.#render();
		try {
			await operation();
		} catch {
			if (!this.#disposed && this.#isFocused(identity)) {
				this.#state = "detail";
				this.#message = "Unable to apply this bundle change.";
			}
		} finally {
			if (!this.#disposed) {
				this.#navigationLocked = false;
				if (this.#isFocused(identity)) this.#render();
			}
		}
	}

	#replaceSummary(summary: GjcBundleSummary): void {
		const index = this.#bundles.findIndex(bundle => identityEquals(bundle.identity, summary.identity));
		if (index >= 0) this.#bundles[index] = summary;
	}

	#bundleForFocus(): GjcBundleSummary | undefined {
		return this.#focused ? this.#bundles.find(bundle => identityEquals(bundle.identity, this.#focused!)) : undefined;
	}

	#isFocused(identity: GjcBundleIdentity): boolean {
		return this.#focused !== null && identityEquals(this.#focused, identity);
	}

	#back(): void {
		if (this.#navigationLocked) return;
		if (this.#state === "list" || this.#state === "empty" || this.#state === "error") {
			this.callbacks.onClose();
			return;
		}
		if (this.#state === "update-review" || this.#state === "update-confirm") {
			this.#state = "detail";
			this.#preview = null;
		} else {
			this.#focused = null;
			this.#preview = null;
			this.#message = null;
			this.#state = this.#bundles.length === 0 ? "empty" : "list";
		}
		this.#render();
	}

	override dispose(): void {
		this.#disposed = true;
		this.#input = null;
		super.dispose();
	}

	handleInput(data: string): void {
		if (this.#navigationLocked) return;
		this.#input?.handleInput(data);
	}
}

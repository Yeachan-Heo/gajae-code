import * as util from "node:util";
import type { Api, Model } from "@gajae-code/ai/core";
import {
	type AutoroutingProvenance,
	type AutoroutingSetup,
	type AutoroutingTierMapInput,
	buildAutoroutingEnabledPatch,
	buildAutoroutingSettingsBatch,
	evaluateAutoroutingProvenanceState,
	type TierMap,
	validateAutoroutingSetup,
} from "../config/autorouting-contract";
import { type AutoroutingSourceIdentity, generateTierChains } from "../config/autorouting-generator";
import { CURATED_TIER_MAP } from "../config/autorouting-tier-map";
import type { RawSettings, Settings, SettingsAtomicPatch, SettingsAtomicReceipt } from "../config/settings";

export interface RoutingSettingsPreview {
	readonly setup: AutoroutingSetup;
	readonly tiers: TierMap;
	readonly provenance: AutoroutingProvenance;
	readonly sourceIdentity: AutoroutingSourceIdentity;
}

export interface RoutingSettingsDependencies {
	readonly settings: Settings;
	readonly getCatalog: () => readonly Model<Api>[];
	readonly getProviderOrder: () => readonly string[];
	/** The host must serialize scope changes with each routing operation through completion. */
	readonly isScoped: () => boolean;
	/** Notify the host after settings publication; this is not a model or lifecycle operation. */
	readonly activate?: () => Promise<void> | void;
}

export interface RoutingSettingsOutcome {
	readonly durability: "persisted" | "memory";
	readonly activation: "not_requested" | "notified";
}

export interface RoutingSettingsPreviewOutcome extends RoutingSettingsOutcome {
	readonly preview: RoutingSettingsPreview;
}

export class RoutingSettingsConfirmationRequiredError extends Error {
	readonly code = "autorouting-hand-edited" as const;

	constructor(readonly preview: RoutingSettingsPreview) {
		super("Generated autorouting tiers were hand-edited; explicit confirmation is required.");
		this.name = "RoutingSettingsConfirmationRequiredError";
	}
}

export class RoutingSettingsActivationError extends Error {
	readonly activation = "failed" as const;
	constructor(
		readonly durability: RoutingSettingsOutcome["durability"],
		readonly rollback: "restored" | "conflict" | "discarded" | "not-restorable" | "failed",
		cause: unknown,
		readonly rollbackError?: unknown,
	) {
		super(`Smart-routing settings were published but notification failed; rollback ${rollback}.`, { cause });
		this.name = "RoutingSettingsActivationError";
	}
}

type RoutingState = { provenance?: AutoroutingProvenance; setup?: AutoroutingSetup; tiers?: unknown };

type RoutingBaseline = {
	readonly setup: AutoroutingSetup | undefined;
	readonly tiers: AutoroutingTierMapInput | undefined;
	readonly provenance: AutoroutingProvenance | undefined;
};

type PreviewAuthority = {
	readonly preview: RoutingSettingsPreview;
	readonly baseline: RoutingBaseline;
	// Confirmation authorizes only the exact states observed inside the writer.
	guard?: { global: RoutingState; effective: RoutingState };
	refresh?: { setup: AutoroutingSetup; providerOrder: readonly string[] };
};

function rawAutoroutingState(current: Readonly<RawSettings>): RoutingState {
	const task = current.task;
	if (!task || typeof task !== "object" || Array.isArray(task)) return {};
	const autorouting = (task as Record<string, unknown>).autorouting;
	if (!autorouting || typeof autorouting !== "object" || Array.isArray(autorouting)) return {};
	const record = autorouting as Record<string, unknown>;
	return {
		provenance: record.provenance as AutoroutingProvenance | undefined,
		setup: record.setup as AutoroutingSetup | undefined,
		tiers: record.tiers,
	};
}

// A new service over the same stale Settings instance must not regain authority.
const unknownSettings = new WeakSet<Settings>();

export class RoutingSettingsService {
	#inFlight = false;
	readonly #previews = new WeakMap<RoutingSettingsPreview, PreviewAuthority>();
	// An admitted operation may still raise a guard after its preview is discarded.
	readonly #discardedPreviews = new WeakSet<RoutingSettingsPreview>();
	constructor(private readonly dependencies: RoutingSettingsDependencies) {}

	get stateUnknown(): boolean {
		return unknownSettings.has(this.dependencies.settings);
	}

	previewSmartRouting(draft: AutoroutingSetup): RoutingSettingsPreview {
		this.#assertStateKnown();
		const issues = validateAutoroutingSetup(draft);
		if (issues.length > 0)
			throw new Error(issues.map(issue => `${issue.path || "setup"}: ${issue.detail}`).join("; "));
		const setup = structuredClone(draft);
		const generated = generateTierChains(setup, CURATED_TIER_MAP, this.dependencies.getCatalog());
		const preview: RoutingSettingsPreview = {
			setup,
			tiers: structuredClone(generated.tiers),
			provenance: {
				schema: 1,
				source: structuredClone(generated.sourceIdentity),
				declarationFingerprint: generated.declarationFingerprint,
				tiersFingerprint: generated.tiersFingerprint,
			},
			sourceIdentity: structuredClone(generated.sourceIdentity),
		};
		return this.#registerPreview(preview, this.#globalBaseline());
	}

	#registerPreview(preview: RoutingSettingsPreview, baseline: RoutingBaseline): RoutingSettingsPreview {
		const issued = structuredClone(preview);
		this.#previews.set(issued, { preview: structuredClone(issued), baseline: structuredClone(baseline) });
		return issued;
	}

	#assertSourceCurrent(preview: RoutingSettingsPreview): void {
		const generated = generateTierChains(preview.setup, CURATED_TIER_MAP, this.dependencies.getCatalog());
		if (
			!util.isDeepStrictEqual(generated.sourceIdentity, preview.sourceIdentity) ||
			!util.isDeepStrictEqual(generated.tiers, preview.tiers) ||
			generated.declarationFingerprint !== preview.provenance.declarationFingerprint ||
			generated.tiersFingerprint !== preview.provenance.tiersFingerprint
		) {
			throw new Error("Smart-routing preview source changed; preview again before applying.");
		}
	}

	#globalBaseline(): RoutingBaseline {
		const settings = this.dependencies.settings;
		return structuredClone({
			setup: settings.getGlobal("task.autorouting.setup"),
			tiers: settings.getGlobal("task.autorouting.tiers"),
			provenance: settings.getGlobal("task.autorouting.provenance"),
		});
	}

	#assertStateKnown(): void {
		if (this.stateUnknown) {
			throw new Error(
				"Smart-routing settings are unknown after a failed rollback; reload Settings before continuing.",
			);
		}
	}

	#assertWritable(): void {
		this.#assertStateKnown();
		if (this.dependencies.isScoped())
			throw new Error("Smart-routing settings are read-only in a --models-scoped session.");
		if (!this.dependencies.settings.canWriteDurableConfig()) {
			throw new Error("Cannot change smart-routing settings while durable config is unavailable.");
		}
	}

	#assertNotHandEdited(
		preview: RoutingSettingsPreview,
		current: RoutingState,
		supplied: RoutingSettingsPreview,
	): void {
		if (!current.provenance || current.tiers === undefined) return;
		const state = evaluateAutoroutingProvenanceState(current.provenance, {
			catalogFingerprint: preview.sourceIdentity.catalogFingerprint,
			mapFingerprint: preview.sourceIdentity.mapFingerprint,
			tiers: current.tiers,
		});
		if (state.handEdited) {
			throw new RoutingSettingsConfirmationRequiredError(supplied);
		}
	}

	#assertFresh(
		preview: RoutingSettingsPreview,
		baseline: RoutingBaseline,
		current: RoutingState,
		confirmed: boolean,
	): void {
		if (!util.isDeepStrictEqual(current.setup, baseline.setup)) {
			throw new Error("Smart-routing setup changed since the preview; preview again before applying.");
		}
		const changed =
			!util.isDeepStrictEqual(current.tiers, baseline.tiers) ||
			!util.isDeepStrictEqual(current.provenance, baseline.provenance);
		const confirmedHandEdit =
			confirmed &&
			util.isDeepStrictEqual(current.provenance, baseline.provenance) &&
			current.provenance !== undefined &&
			current.tiers !== undefined &&
			evaluateAutoroutingProvenanceState(current.provenance, {
				catalogFingerprint: preview.sourceIdentity.catalogFingerprint,
				mapFingerprint: preview.sourceIdentity.mapFingerprint,
				tiers: current.tiers,
			}).handEdited;
		if (changed && !confirmedHandEdit) {
			throw new Error("Smart-routing generated settings changed since the preview; preview again before applying.");
		}
	}

	#effectiveState(): RoutingState {
		const settings = this.dependencies.settings;
		return {
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
			tiers: settings.get("task.autorouting.tiers"),
		};
	}

	async #commit(
		build: (current: Readonly<RawSettings>) => readonly SettingsAtomicPatch[],
	): Promise<RoutingSettingsOutcome> {
		if (this.#inFlight) throw new Error("Another smart-routing operation is already in progress.");
		this.#inFlight = true;
		try {
			this.#assertWritable();
			const receipt: SettingsAtomicReceipt = await this.dependencies.settings.commitAtomicBatchWithCurrent(
				current => {
					this.#assertWritable();
					const patches = build(current);
					this.#assertWritable();
					return patches;
				},
			);
			const durability = this.dependencies.settings.canPersistDurableConfig() ? "persisted" : "memory";
			if (this.dependencies.activate) {
				try {
					await this.dependencies.activate();
				} catch (cause) {
					let rollback: RoutingSettingsActivationError["rollback"];
					let rollbackError: unknown;
					try {
						rollback = (await receipt.restore()).status;
					} catch (error) {
						rollback = "failed";
						rollbackError = error;
					}
					// A durable restore that did not succeed may have observed another Settings
					// writer. This instance is not reloaded, and replacing it here could erase
					// pending local mutations. Require a new safely loaded Settings instead.
					if (
						durability === "persisted" &&
						(rollback === "conflict" || rollback === "failed" || rollback === "not-restorable")
					) {
						unknownSettings.add(this.dependencies.settings);
					}
					throw new RoutingSettingsActivationError(durability, rollback, cause, rollbackError);
				}
			}
			receipt.discard();
			return { durability, activation: this.dependencies.activate ? "notified" : "not_requested" };
		} finally {
			this.#inFlight = false;
		}
	}

	discardPreview(preview: RoutingSettingsPreview): void {
		this.#discardedPreviews.add(preview);
		this.#previews.delete(preview);
	}

	async applySmartRouting(
		draft: AutoroutingSetup,
		options?: { preview?: RoutingSettingsPreview; confirmHandEdit?: boolean },
	): Promise<RoutingSettingsPreviewOutcome> {
		const confirmed = options?.confirmHandEdit === true;
		const supplied = options?.preview ?? this.previewSmartRouting(draft);
		const authority = this.#previews.get(supplied);
		if (!authority) throw new Error("Smart-routing preview is not valid for this service; preview again.");
		if (
			!util.isDeepStrictEqual(supplied, authority.preview) ||
			!util.isDeepStrictEqual(draft, authority.preview.setup)
		) {
			this.#previews.delete(supplied);
			throw new Error("Smart-routing preview or draft was changed; preview again.");
		}
		const preview = authority.preview;
		this.#previews.delete(supplied);
		let outcome: RoutingSettingsOutcome;
		let guardRaised = false;
		try {
			this.#assertWritable();
			this.#assertSourceCurrent(preview);
			outcome = await this.#commit(current => {
				const state = rawAutoroutingState(current);
				const effective = this.#effectiveState();
				this.#assertSourceCurrent(preview);
				if (authority.refresh) {
					if (!util.isDeepStrictEqual(state.setup, authority.refresh.setup)) {
						throw new Error("Smart-routing setup changed while refresh was preparing; refresh again.");
					}
					if (!util.isDeepStrictEqual(authority.refresh.providerOrder, this.dependencies.getProviderOrder())) {
						throw new Error("Smart-routing provider order changed; refresh again before applying.");
					}
				}
				const guard = confirmed ? authority.guard : undefined;
				if (guard) {
					if (
						!util.isDeepStrictEqual(state, guard.global) ||
						!util.isDeepStrictEqual(effective, guard.effective)
					) {
						throw new Error("Smart-routing hand-edited settings changed; preview again before applying.");
					}
				} else {
					try {
						this.#assertNotHandEdited(preview, effective, supplied);
						this.#assertNotHandEdited(preview, state, supplied);
					} catch (error) {
						if (error instanceof RoutingSettingsConfirmationRequiredError) {
							authority.guard = structuredClone({ global: state, effective });
							guardRaised = true;
						}
						throw error;
					}
				}
				this.#assertFresh(preview, authority.baseline, state, guard !== undefined);
				return buildAutoroutingSettingsBatch({
					tiers: preview.tiers,
					setup: preview.setup,
					provenance: preview.provenance,
				});
			});
		} catch (error) {
			if (guardRaised && !this.#discardedPreviews.has(supplied)) this.#previews.set(supplied, authority);
			throw error;
		}
		return {
			...outcome,
			preview: this.#registerPreview(preview, {
				setup: preview.setup,
				tiers: preview.tiers,
				provenance: preview.provenance,
			}),
		};
	}

	async refreshSmartRouting(options?: {
		preview?: RoutingSettingsPreview;
		confirmHandEdit?: boolean;
	}): Promise<RoutingSettingsPreviewOutcome> {
		this.#assertWritable();
		if (options?.preview || options?.confirmHandEdit === true) {
			const preview = options.preview;
			if (!preview || options.confirmHandEdit !== true) {
				throw new Error("Refreshing with confirmation requires its guarded preview and explicit confirmation.");
			}
			const authority = this.#previews.get(preview);
			if (!authority?.refresh || !authority.guard) {
				throw new Error("Smart-routing refresh preview is not valid for this service; refresh again.");
			}
			return this.applySmartRouting(preview.setup, { preview, confirmHandEdit: true });
		}
		const setup = this.dependencies.settings.getGlobal("task.autorouting.setup");
		if (setup === undefined || validateAutoroutingSetup(setup).length > 0) {
			throw new Error("Cannot refresh smart routing without a valid recorded global setup.");
		}
		const declared = new Set(setup.providers.map(provider => provider.trim().toLowerCase()));
		const providerOrder = [...this.dependencies.getProviderOrder()];
		const providers = providerOrder.filter(provider => declared.has(provider.trim().toLowerCase()));
		if (providers.length === 0)
			throw new Error("No declared providers remain in the catalog; smart routing was not updated.");
		const preview = this.previewSmartRouting({ ...structuredClone(setup), providers });
		const authority = this.#previews.get(preview);
		if (!authority) throw new Error("Smart-routing preview is unavailable.");
		authority.refresh = { setup: structuredClone(setup), providerOrder };
		return this.applySmartRouting(preview.setup, { preview });
	}

	clearGeneratedSetup(): Promise<RoutingSettingsOutcome> {
		return this.#commit(() => buildAutoroutingSettingsBatch({ clear: true }));
	}

	setAutoroutingEnabled(enabled: boolean): Promise<RoutingSettingsOutcome> {
		return this.#commit(() => [buildAutoroutingEnabledPatch(enabled)]);
	}
}

export function createRoutingSettingsService(dependencies: RoutingSettingsDependencies): RoutingSettingsService {
	return new RoutingSettingsService(dependencies);
}

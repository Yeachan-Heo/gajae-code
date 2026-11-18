import { Container, getKeybindings, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import type {
	AutoroutingProvenance,
	AutoroutingProviderOrderHint,
	AutoroutingSetup,
	AutoroutingTier,
	TierMap,
} from "../../config/autorouting-contract";
import {
	RoutingSettingsActivationError,
	RoutingSettingsConfirmationRequiredError,
	type RoutingSettingsPreview,
} from "../../sdk/routing-settings";
import { theme } from "../theme/theme";

/** Longest rendered panel line before truncation. */
export const MAX_PANEL_LINE_WIDTH = 200;

// Even double-width code points fit alongside the draft label within the line cap.
const DRAFT_PAGE_CODE_POINTS = 64;

export type SmartRoutingIntent =
	| {
			kind: "apply";
			draft: AutoroutingSetup;
			preview: RoutingSettingsPreview;
			confirmHandEdit?: boolean;
	  }
	| {
			kind: "refresh";
			preview?: RoutingSettingsPreview;
			confirmHandEdit?: boolean;
	  }
	| {
			kind: "clear";
	  }
	| {
			kind: "toggle";
			enabled: boolean;
	  };

export type SmartRoutingPanelMode = "editing" | "confirming" | "committing" | "done" | "error";
export type SmartRoutingConfirmation = "clear" | "hand-edit" | undefined;

export interface SmartRoutingPanelOptions {
	setup: AutoroutingSetup;
	tiers?: TierMap;
	provenance?: AutoroutingProvenance;
	/** Advisory drift between the recorded declaration and current provider priority. */
	providerOrderHint?: AutoroutingProviderOrderHint;
	enabled: boolean;
	effectiveGeneratedSetup?: boolean;
	readOnly: boolean;
	isStateUnknown?: () => boolean;
	stale: boolean;
	preview: RoutingSettingsPreview;
	generatePreview: (draft: AutoroutingSetup) => RoutingSettingsPreview;
	discardPreview?: (preview: RoutingSettingsPreview) => void;
	effectiveDiffersFromSaved?: boolean;
	onSelect: (intent: SmartRoutingIntent) => undefined | Promise<RoutingSettingsPreview | undefined>;
	onCancel: () => void;
}

function cloneSetup(setup: AutoroutingSetup): AutoroutingSetup {
	return structuredClone(setup);
}

function clonePreview(preview: RoutingSettingsPreview): RoutingSettingsPreview {
	return structuredClone(preview);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function isBackspace(data: string): boolean {
	return data === "\x7f" || data === "\b";
}

/**
 * Provider names, allowlist entries, generated selectors, and error text all
 * originate in hand-editable config or catalog data, so any of them can carry
 * tabs, control bytes, line breaks, or terminal escape sequences. Any of those
 * can inject extra rows or evade the width cap, so flatten and bound the value
 * before it reaches a renderer.
 */
function displaySafe(text: string): string {
	return truncateToWidth(replaceTabs(sanitizeDisplayLine(text)), MAX_PANEL_LINE_WIDTH);
}

function draftPageEnd(text: string, start: number): number {
	let end = start;
	for (let count = 0; count < DRAFT_PAGE_CODE_POINTS && end < text.length; count++) {
		end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
	}
	return end;
}

function draftPageStart(text: string, end: number): number {
	let start = end;
	for (let count = 0; count < DRAFT_PAGE_CODE_POINTS && start > 0; count++) {
		start--;
		const code = text.charCodeAt(start);
		if (code >= 0xdc00 && code <= 0xdfff && start > 0) start--;
	}
	return start;
}

function formatTier(tier: AutoroutingTier, tiers: TierMap | undefined): string {
	const selectors = tiers?.[tier];
	return displaySafe(
		`${tier}: ${selectors && selectors.length > 0 ? selectors.join(", ") : "(empty; manual fallback)"}`,
	);
}

/**
 * Presentational smart-routing setup editor. It owns only ephemeral draft and
 * preview state; all durable changes are emitted as typed intents.
 */
export class SmartRoutingPanelComponent extends Container {
	readonly #onSelect: SmartRoutingPanelOptions["onSelect"];
	readonly #onCancel: () => void;
	readonly #discardPreview?: (preview: RoutingSettingsPreview) => void;
	readonly #generatePreview: (draft: AutoroutingSetup) => RoutingSettingsPreview;
	readonly #readOnly: boolean;
	readonly #isStateUnknown?: () => boolean;
	#sharedStateInvalidated = false;
	#draft: AutoroutingSetup;

	#tiers?: TierMap;
	#provenance?: AutoroutingProvenance;
	#enabled: boolean | undefined;
	#effectiveGeneratedSetup: boolean | undefined;
	#stateRevision = 0;
	#stale: boolean;
	/** Service-owned preview identity; never clone it when forwarding a mutation intent. */
	#preview: RoutingSettingsPreview;
	#previewValid = true;
	#committedPreviewUnknown = false;
	#effectiveDiffersFromSaved: boolean | undefined = false;
	#mode: SmartRoutingPanelMode = "editing";
	#confirmation: SmartRoutingConfirmation;
	/** Intent that triggered the current hand-edit confirmation, replayed verbatim on confirm. */
	#pendingIntent: SmartRoutingIntent | undefined;
	#providerCursor = 0;
	#allowlistEditing = false;
	#allowlistBuffer = "";
	#uncommittedAllowlist: string | undefined;
	// Maintain the sanitized view on input, never allocate a full draft during rendering.
	#sanitizedAllowlistBuffer = "";
	#uncommittedPageStart = 0;
	#providerOrderHint: AutoroutingProviderOrderHint | undefined;
	#status = "";
	#error = "";

	constructor(options: SmartRoutingPanelOptions) {
		super();
		this.#onSelect = options.onSelect;
		this.#onCancel = options.onCancel;
		this.#discardPreview = options.discardPreview;
		this.#effectiveDiffersFromSaved = options.effectiveDiffersFromSaved === true;
		this.#generatePreview = options.generatePreview;
		this.#readOnly = options.readOnly;
		this.#isStateUnknown = options.isStateUnknown;
		this.#draft = cloneSetup(options.setup);

		this.#tiers = options.tiers ? structuredClone(options.tiers) : undefined;
		this.#provenance = options.provenance ? structuredClone(options.provenance) : undefined;
		this.#enabled = options.enabled;
		this.#effectiveGeneratedSetup = options.effectiveGeneratedSetup;
		this.#providerOrderHint = options.providerOrderHint ? structuredClone(options.providerOrderHint) : undefined;
		this.#stale = options.stale;
		this.#preview = options.preview;
		this.#render();
	}

	get mode(): SmartRoutingPanelMode {
		return this.#mode;
	}

	get confirmation(): SmartRoutingConfirmation {
		return this.#confirmation;
	}

	getDraft(): AutoroutingSetup {
		return cloneSetup(this.#draft);
	}

	/** Detached display data only; apply intents retain the service-issued identity internally. */
	getPreviewPayload(): RoutingSettingsPreview {
		return clonePreview(this.#visiblePreview());
	}

	#visiblePreview(): RoutingSettingsPreview {
		if (
			this.#confirmation === "hand-edit" &&
			this.#pendingIntent?.kind === "refresh" &&
			this.#pendingIntent.preview
		) {
			return this.#pendingIntent.preview;
		}
		return this.#preview;
	}

	getProviderOrder(): readonly string[] {
		return [...this.#draft.providers];
	}

	/**
	 * Advisory-only, non-destructive hint update.
	 *
	 * `refreshState` deliberately replaces the draft and clears editor state, so it
	 * must never be used for a background settings change: an external
	 * `modelProviderOrder` edit would then discard the user's unsaved reordering,
	 * allowlist buffer, cursor, and confirmation. This replaces the hint and nothing
	 * else.
	 */
	updateProviderOrderHint(hint: AutoroutingProviderOrderHint | undefined): void {
		this.#providerOrderHint = hint ? structuredClone(hint) : undefined;
		this.#render();
	}

	/** Forget effective indicators when a committed result cannot be presented reliably. */
	markEffectiveStateUnknown(): void {
		this.#enabled = undefined;
		this.#effectiveGeneratedSetup = undefined;
		this.#provenance = undefined;
		this.#stale = false;
		this.#providerOrderHint = undefined;
		this.#effectiveDiffersFromSaved = undefined;
		this.#status = "";
	}

	#observeSharedInvalidation(): boolean {
		if (!this.#sharedStateInvalidated && this.#isStateUnknown?.()) {
			this.#sharedStateInvalidated = true;
			if (this.#pendingIntent && "preview" in this.#pendingIntent) {
				const pendingPreview = this.#pendingIntent.preview;
				if (pendingPreview && pendingPreview !== this.#preview) this.#discardPreview?.(pendingPreview);
			}
			this.#pendingIntent = undefined;
			this.#confirmation = undefined;
			if (this.#mode === "confirming") this.#mode = "editing";
			if (this.#allowlistEditing) this.#uncommittedAllowlist = this.#allowlistBuffer;
			this.#allowlistEditing = false;
			this.#allowlistBuffer = "";
			this.markEffectiveStateUnknown();
			this.#render();
		}
		return this.#sharedStateInvalidated;
	}

	render(width: number): string[] {
		this.#observeSharedInvalidation();
		return super.render(width);
	}

	/** Replace the panel's persisted snapshot after a controller mutation. */
	refreshState(options: {
		setup: AutoroutingSetup;
		tiers?: TierMap;
		provenance?: AutoroutingProvenance;
		enabled: boolean;
		effectiveGeneratedSetup: boolean;
		providerOrderHint?: AutoroutingProviderOrderHint;
		stale: boolean;
		preview?: RoutingSettingsPreview;
		effectiveDiffersFromSaved?: boolean;
	}): void {
		if (this.#preview !== options.preview) this.#discardPreview?.(this.#preview);
		this.#draft = cloneSetup(options.setup);
		this.#tiers = options.tiers ? structuredClone(options.tiers) : undefined;
		this.#provenance = options.provenance ? structuredClone(options.provenance) : undefined;
		this.#enabled = options.enabled;
		this.#effectiveGeneratedSetup = options.effectiveGeneratedSetup;
		this.#stale = options.stale;
		this.#providerOrderHint = options.providerOrderHint ? structuredClone(options.providerOrderHint) : undefined;
		if (options.preview) this.#preview = options.preview;
		this.#previewValid = options.preview !== undefined;
		this.#committedPreviewUnknown = false;
		this.#effectiveDiffersFromSaved = options.effectiveDiffersFromSaved === true;
		this.#providerCursor = Math.min(this.#providerCursor, Math.max(0, this.#draft.providers.length - 1));
		this.#mode = "editing";
		this.#confirmation = undefined;
		this.#status = "";
		this.#error = "";
		this.#render();
		this.#stateRevision++;
	}

	#render(): void {
		this.detachAll();
		this.addChild(new Text(theme.fg("accent", "Smart routing setup"), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", "Declare providers in priority order; generated chains are deterministic."), 0, 0),
		);
		if (this.#readOnly) {
			this.addChild(
				new Text(
					theme.fg("warning", "Read-only: temporary or --models-scoped sessions cannot write autorouting."),
					0,
					0,
				),
			);
		}
		if (this.#sharedStateInvalidated) {
			this.addChild(
				new Text(theme.fg("warning", "Routing settings are unknown; reload Settings before continuing."), 0, 0),
			);
		}
		if (this.#effectiveDiffersFromSaved === undefined) {
			this.addChild(new Text(theme.fg("muted", "Effective settings comparison to global: unknown."), 0, 0));
		} else if (this.#effectiveDiffersFromSaved) {
			this.addChild(
				new Text(theme.fg("muted", "Committed preview is global; effective settings currently differ."), 0, 0),
			);
		}
		if (this.#stale) {
			this.addChild(
				new Text(
					theme.fg("warning", "Stale generated setup: catalog/map or hand-edited tiers differ from provenance."),
					0,
					0,
				),
			);
		}
		// Advisory only: a changed provider priority is a new suggestion, never proof
		// that the persisted tiers went stale.
		if (this.#providerOrderHint?.reordered) {
			this.addChild(
				new Text(
					theme.fg("muted", "Provider priority changed since this setup was generated. Press r to refresh."),
					0,
					0,
				),
			);
		}
		if (this.#providerOrderHint && this.#providerOrderHint.missing.length > 0) {
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						displaySafe(
							`Declared providers missing from the catalog: ${this.#providerOrderHint.missing.join(", ")}`,
						),
					),
					0,
					0,
				),
			);
		}
		if (this.#provenance)
			this.addChild(new Text(theme.fg("dim", "Provenance recorded for this generated setup."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Effective enabled: ${this.#enabled === undefined ? "unknown" : this.#enabled ? "yes" : "no"}`,
				),
				0,
				0,
			),
		);
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Effective generated setup: ${this.#effectiveGeneratedSetup === undefined ? "unknown" : this.#effectiveGeneratedSetup ? "present" : "absent"}`,
				),
				0,
				0,
			),
		);
		const providersLabel = this.#sharedStateInvalidated
			? "Providers:"
			: this.#committedPreviewUnknown
				? "Draft providers:"
				: "Providers (↑/↓ reorder; x removes; m edits allowlist):";
		this.addChild(new Text(theme.fg("muted", providersLabel), 0, 0));
		for (let index = 0; index < this.#draft.providers.length; index++) {
			const provider = this.#draft.providers[index] ?? "";
			const prefix = index === this.#providerCursor ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			this.addChild(new Text(`${prefix}${displaySafe(provider)}`, 0, 0));
		}
		if (this.#draft.providers.length === 0)
			this.addChild(new Text(theme.fg("error", "  No providers declared."), 0, 0));
		if (this.#allowlistEditing) {
			this.addChild(
				new Text(theme.fg("accent", displaySafe(`Allowlist: ${this.#allowlistBuffer || "(all models)"}`)), 0, 0),
			);
			this.addChild(
				new Text(theme.fg("muted", "  Type provider/model values separated by commas, then Enter."), 0, 0),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						displaySafe(
							`Allowlist: ${this.#draft.models && this.#draft.models.length > 0 ? this.#draft.models.join(", ") : "(all labeled models)"}`,
						),
					),
					0,
					0,
				),
			);
		}
		if (this.#uncommittedAllowlist !== undefined) {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						displaySafe(
							`Uncommitted allowlist draft (read-only): ${this.#sanitizedAllowlistBuffer.slice(
								this.#uncommittedPageStart,
								draftPageEnd(this.#sanitizedAllowlistBuffer, this.#uncommittedPageStart),
							)}`,
						),
					),
					0,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));
		const visiblePreview = this.#visiblePreview();
		const visiblePreviewValid =
			this.#previewValid ||
			(this.#confirmation === "hand-edit" &&
				this.#pendingIntent?.kind === "refresh" &&
				this.#pendingIntent.preview !== undefined);
		if (this.#confirmation === "hand-edit" && this.#pendingIntent?.kind === "refresh") {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						displaySafe(
							`Pending refresh uses recorded global providers: ${visiblePreview.setup.providers.join(", ")}`,
						),
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						displaySafe(
							`Pending refresh uses recorded global allowlist: ${visiblePreview.setup.models?.length ? visiblePreview.setup.models.join(", ") : "(all labeled models)"}`,
						),
					),
					0,
					0,
				),
			);
		}
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					visiblePreviewValid
						? "Preview:"
						: this.#committedPreviewUnknown
							? "Committed preview: unknown."
							: "Preview invalid; regenerate before applying:",
				),
				0,
				0,
			),
		);
		if (visiblePreviewValid) {
			for (const tier of ["fast", "balanced", "strong"] as const) {
				this.addChild(new Text(`  ${formatTier(tier, visiblePreview.tiers)}`, 0, 0));
			}
		}
		if (this.#status) this.addChild(new Text(theme.fg("success", displaySafe(this.#status)), 0, 0));
		if (this.#error) this.addChild(new Text(theme.fg("error", displaySafe(this.#error)), 0, 0));
		if (this.#confirmation === "clear") {
			this.addChild(
				new Text(
					theme.fg("warning", "Clear global generated tiers, setup, and provenance? Enter confirms; Esc cancels."),
					0,
					0,
				),
			);
		} else if (this.#confirmation === "hand-edit") {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						"Stored tiers were hand-edited. Regenerate and replace them? Enter confirms; Esc cancels.",
					),
					0,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));
		const actions =
			this.#sharedStateInvalidated && this.#uncommittedAllowlist !== undefined
				? "PageUp/PageDown: inspect draft · Esc: cancel"
				: this.#readOnly || this.#sharedStateInvalidated
					? "Esc: cancel"
					: "a: apply · r: refresh · t: toggle · c: clear · Esc: cancel";
		this.addChild(new Text(theme.fg("muted", actions), 0, 0));
	}

	#recomputePreview(): void {
		this.#committedPreviewUnknown = false;
		this.#discardPreview?.(this.#preview);
		this.#previewValid = false;
		try {
			this.#preview = this.#generatePreview(this.#draft);
			this.#previewValid = true;
			this.#error = "";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
	}

	async #emit(intent: SmartRoutingIntent): Promise<void> {
		if (this.#observeSharedInvalidation() || this.#readOnly || this.#mode === "committing") return;
		if (intent.kind === "apply" && !this.#previewValid) {
			this.#error = "Preview unavailable; edit the setup to generate and review a fresh preview.";
			this.#render();
			return;
		}
		this.#mode = "committing";
		this.#status = "Committing smart-routing settings…";
		this.#error = "";
		this.#confirmation = undefined;
		this.#render();
		const stateRevision = this.#stateRevision;
		try {
			const result = await this.#onSelect(intent);
			const invalidated = this.#observeSharedInvalidation();
			if (invalidated) {
				if (result) this.#discardPreview?.(result);
				if ((intent.kind === "apply" || intent.kind === "refresh") && intent.preview && intent.preview !== result) {
					this.#discardPreview?.(intent.preview);
				}
				if (intent.kind === "apply" || intent.kind === "refresh") {
					this.#previewValid = false;
					this.#committedPreviewUnknown = true;
				}
			} else if ((intent.kind === "apply" || intent.kind === "refresh") && result) {
				if (this.#preview !== result) this.#discardPreview?.(this.#preview);
				this.#draft = cloneSetup(result.setup);
				this.#preview = result;
				this.#previewValid = true;
				this.#committedPreviewUnknown = false;
			} else if ((intent.kind === "apply" || intent.kind === "refresh") && !result) {
				this.#previewValid = false;
				this.#committedPreviewUnknown = true;
			}
			if (invalidated || this.#stateRevision === stateRevision) {
				// A callback-only host cannot establish effective state after any write.
				this.markEffectiveStateUnknown();
			}
			this.#mode = "done";
			this.#status =
				intent.kind === "clear"
					? "Global generated setup cleared."
					: intent.kind === "toggle"
						? `Global enabled updated: ${intent.enabled ? "yes" : "no"}.`
						: "Global smart-routing settings updated.";
		} catch (error) {
			if (this.#observeSharedInvalidation()) {
				if (error instanceof RoutingSettingsConfirmationRequiredError) this.#discardPreview?.(error.preview);
				if ((intent.kind === "apply" || intent.kind === "refresh") && intent.preview) {
					if (!(error instanceof RoutingSettingsConfirmationRequiredError) || intent.preview !== error.preview) {
						this.#discardPreview?.(intent.preview);
					}
				}
				this.#previewValid = false;
				this.markEffectiveStateUnknown();
				this.#mode = "error";
				this.#status = "";
				this.#error =
					error instanceof RoutingSettingsConfirmationRequiredError
						? ""
						: error instanceof Error
							? error.message
							: String(error);
				this.#render();
				return;
			}
			if (
				error instanceof RoutingSettingsActivationError &&
				(error.rollback === "conflict" || error.rollback === "failed" || error.rollback === "not-restorable") &&
				this.#stateRevision === stateRevision
			) {
				this.#enabled = undefined;
				this.#effectiveGeneratedSetup = undefined;
				this.#provenance = undefined;
				this.#stale = false;
				this.#effectiveDiffersFromSaved = undefined;
			}
			if (
				error instanceof RoutingSettingsConfirmationRequiredError &&
				(intent.kind === "apply" || intent.kind === "refresh")
			) {
				this.#mode = "confirming";
				this.#confirmation = "hand-edit";
				// Retain the intent that triggered the guard so confirming replays THAT intent. An Apply
				// carrying an edited draft must not be silently downgraded to a Refresh, which would
				// discard the frozen preview and commit the previously recorded setup instead (AC6).
				this.#pendingIntent =
					intent.kind === "apply"
						? { ...intent, preview: error.preview }
						: { kind: "refresh", preview: error.preview };
				this.#status = "";
				this.#error = "";
			} else {
				this.#mode = "error";
				this.#error = error instanceof Error ? error.message : String(error);
				this.#status = "";
				if (intent.kind === "apply" || intent.kind === "refresh") {
					if (intent.preview) this.#discardPreview?.(intent.preview);
					this.#discardPreview?.(this.#preview);
					this.#previewValid = false;
					this.#mode = "editing";
					try {
						this.#preview = this.#generatePreview(this.#draft);
						this.#previewValid = true;
						this.#error += " A fresh preview is shown; review it before applying again.";
					} catch {
						this.#error += " Preview generation failed; edit the setup to prepare again.";
					}
				}
			}
		}
		this.#render();
	}

	#beginClearConfirmation(): void {
		if (this.#readOnly || this.#mode !== "editing") return;
		this.#mode = "confirming";
		this.#confirmation = "clear";
		this.#render();
	}

	#commitAllowlistBuffer(): void {
		const values = this.#allowlistBuffer
			.split(",")
			.map(value => value.trim())
			.filter(value => value.length > 0);
		this.#draft =
			values.length > 0
				? { ...this.#draft, models: [...new Set(values)] }
				: { schema: 1, providers: [...this.#draft.providers] };
		this.#allowlistEditing = false;
		this.#allowlistBuffer = "";
		this.#sanitizedAllowlistBuffer = "";
		this.#recomputePreview();
		this.#render();
	}

	handleInput(data: string): void {
		if (this.#observeSharedInvalidation()) {
			if (this.#uncommittedAllowlist !== undefined && matchesKey(data, "pageDown")) {
				const end = draftPageEnd(this.#sanitizedAllowlistBuffer, this.#uncommittedPageStart);
				if (end < this.#sanitizedAllowlistBuffer.length) this.#uncommittedPageStart = end;
				this.#render();
			} else if (this.#uncommittedAllowlist !== undefined && matchesKey(data, "pageUp")) {
				this.#uncommittedPageStart = draftPageStart(this.#sanitizedAllowlistBuffer, this.#uncommittedPageStart);
				this.#render();
			} else if (getKeybindings().matches(data, "tui.select.cancel")) {
				this.#discardPreview?.(this.#preview);
				this.#onCancel();
			}
			return;
		}
		if (this.#mode === "committing") return;
		if (this.#mode === "done" || this.#mode === "error") {
			if (getKeybindings().matches(data, "tui.select.cancel")) {
				this.#discardPreview?.(this.#preview);
				this.#onCancel();
			}
			return;
		}
		if (this.#confirmation) {
			if (getKeybindings().matches(data, "tui.select.cancel")) {
				if (
					this.#confirmation === "hand-edit" &&
					this.#pendingIntent &&
					"preview" in this.#pendingIntent &&
					this.#pendingIntent.preview
				) {
					this.#discardPreview?.(this.#pendingIntent.preview);
					if (this.#pendingIntent.preview === this.#preview) this.#recomputePreview();
				}
				this.#confirmation = undefined;
				this.#pendingIntent = undefined;
				this.#mode = "editing";
				this.#render();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				void this.#emitConfirmed();
			}
			return;
		}
		if (this.#allowlistEditing) {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#commitAllowlistBuffer();
				return;
			}
			if (getKeybindings().matches(data, "tui.select.cancel")) {
				this.#allowlistEditing = false;
				this.#allowlistBuffer = "";
				this.#sanitizedAllowlistBuffer = "";
				this.#render();
				return;
			}
			if (isBackspace(data)) {
				this.#allowlistBuffer = this.#allowlistBuffer.slice(0, -1);
				this.#sanitizedAllowlistBuffer = replaceTabs(sanitizeDisplayLine(this.#allowlistBuffer));
				this.#render();
				return;
			}
			if (isPrintable(data)) {
				this.#allowlistBuffer += data;
				this.#sanitizedAllowlistBuffer = replaceTabs(sanitizeDisplayLine(this.#allowlistBuffer));
				this.#render();
			}
			return;
		}
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.#discardPreview?.(this.#preview);
			this.#onCancel();
			return;
		}
		if (this.#readOnly) return;
		if (data === "m" || data === "M") {
			this.#allowlistEditing = true;
			this.#allowlistBuffer = this.#draft.models?.join(", ") ?? "";
			this.#sanitizedAllowlistBuffer = replaceTabs(sanitizeDisplayLine(this.#allowlistBuffer));
			this.#render();
			return;
		}
		if (data === "x" || data === "X") {
			if (this.#draft.providers.length <= 1) {
				this.#error = "At least one provider must remain declared.";
				this.#render();
				return;
			}
			const providers = this.#draft.providers.filter((_, index) => index !== this.#providerCursor);
			this.#draft = { ...this.#draft, providers };
			this.#providerCursor = Math.min(this.#providerCursor, providers.length - 1);
			this.#recomputePreview();
			this.#render();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.#providerCursor > 0) {
				const providers = [...this.#draft.providers];
				[providers[this.#providerCursor - 1], providers[this.#providerCursor]] = [
					providers[this.#providerCursor]!,
					providers[this.#providerCursor - 1]!,
				];
				this.#draft = { ...this.#draft, providers };
				this.#providerCursor--;
				this.#recomputePreview();
				this.#render();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.#providerCursor < this.#draft.providers.length - 1) {
				const providers = [...this.#draft.providers];
				[providers[this.#providerCursor], providers[this.#providerCursor + 1]] = [
					providers[this.#providerCursor + 1]!,
					providers[this.#providerCursor]!,
				];
				this.#draft = { ...this.#draft, providers };
				this.#providerCursor++;
				this.#recomputePreview();
				this.#render();
			}
			return;
		}
		if (data === "a" || data === "A") {
			void this.#emit({ kind: "apply", draft: cloneSetup(this.#draft), preview: this.#preview });
			return;
		}
		if (data === "r" || data === "R") {
			void this.#emit({ kind: "refresh" });
			return;
		}
		if (data === "t" || data === "T") {
			void this.#emit({ kind: "toggle", enabled: this.#enabled !== true });
			return;
		}
		if (data === "c" || data === "C") {
			this.#beginClearConfirmation();
		}
	}

	__testApply(): Promise<void> {
		return this.#emit({ kind: "apply", draft: cloneSetup(this.#draft), preview: this.#preview });
	}

	/** Test hook mirroring an in-panel provider reorder/edit: mutates the draft and re-previews. */
	__testSetProviders(providers: string[]): void {
		this.#draft = { ...this.#draft, providers: [...providers] };
		this.#recomputePreview();
		this.#providerCursor = 0;
	}

	__testRefresh(): Promise<void> {
		return this.#emit({ kind: "refresh" });
	}

	__testToggle(enabled = this.#enabled !== true): Promise<void> {
		return this.#emit({ kind: "toggle", enabled });
	}

	__testClear(): Promise<void> {
		return this.#emit({ kind: "clear" });
	}

	__testConfirm(): Promise<void> {
		return this.#emitConfirmed();
	}

	/**
	 * Replay the intent the confirmation was raised for. A `clear` confirmation always emits `clear`;
	 * a hand-edit confirmation re-emits the ORIGINAL intent with `confirmHandEdit`, so a guarded Apply
	 * commits its own edited draft instead of being downgraded to a Refresh of the recorded setup.
	 */
	#emitConfirmed(): Promise<void> {
		if (this.#confirmation === "clear") return this.#emit({ kind: "clear" });
		if (this.#confirmation !== "hand-edit") return Promise.resolve();
		const pending = this.#pendingIntent;
		this.#pendingIntent = undefined;
		if (pending?.kind === "apply")
			return this.#emit({ kind: "apply", draft: pending.draft, preview: pending.preview, confirmHandEdit: true });
		if (pending?.kind === "refresh" && pending.preview)
			return this.#emit({ kind: "refresh", preview: pending.preview, confirmHandEdit: true });
		return Promise.resolve();
	}
}

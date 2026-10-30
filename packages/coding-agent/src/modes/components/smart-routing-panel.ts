import { Container, getKeybindings, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import type {
	AutoroutingProvenance,
	AutoroutingProviderOrderHint,
	AutoroutingSetup,
	AutoroutingTier,
	TierMap,
} from "../../config/autorouting-contract";
import type { AutoroutingSourceIdentity } from "../../config/autorouting-generator";
import { theme } from "../theme/theme";

/** Longest rendered panel line before truncation. */
export const MAX_PANEL_LINE_WIDTH = 200;

export type SmartRoutingPreview = {
	readonly setup: AutoroutingSetup;
	readonly tiers: TierMap;
	readonly provenance: AutoroutingProvenance;
	readonly sourceIdentity: AutoroutingSourceIdentity;
};

export type SmartRoutingIntent =
	| {
			kind: "apply";
			draft: AutoroutingSetup;
			preview: SmartRoutingPreview;
			confirmHandEdit?: boolean;
	  }
	| {
			kind: "refresh";
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
	readOnly: boolean;
	stale: boolean;
	preview: SmartRoutingPreview;
	generatePreview: (draft: AutoroutingSetup) => SmartRoutingPreview;
	onSelect: (intent: SmartRoutingIntent) => undefined | Promise<SmartRoutingPreview | undefined>;
	onCancel: () => void;
}

function cloneSetup(setup: AutoroutingSetup): AutoroutingSetup {
	return structuredClone(setup);
}

function clonePreview(preview: SmartRoutingPreview): SmartRoutingPreview {
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
	readonly #generatePreview: (draft: AutoroutingSetup) => SmartRoutingPreview;
	readonly #readOnly: boolean;
	#draft: AutoroutingSetup;

	#tiers?: TierMap;
	#provenance?: AutoroutingProvenance;
	#enabled: boolean;
	#stale: boolean;
	#preview: SmartRoutingPreview;
	#mode: SmartRoutingPanelMode = "editing";
	#confirmation: SmartRoutingConfirmation;
	/** Intent that triggered the current hand-edit confirmation, replayed verbatim on confirm. */
	#pendingIntent: SmartRoutingIntent | undefined;
	#providerCursor = 0;
	#allowlistEditing = false;
	#allowlistBuffer = "";
	#providerOrderHint: AutoroutingProviderOrderHint | undefined;
	#status = "";
	#error = "";

	constructor(options: SmartRoutingPanelOptions) {
		super();
		this.#onSelect = options.onSelect;
		this.#onCancel = options.onCancel;
		this.#generatePreview = options.generatePreview;
		this.#readOnly = options.readOnly;
		this.#draft = cloneSetup(options.setup);

		this.#tiers = options.tiers ? structuredClone(options.tiers) : undefined;
		this.#provenance = options.provenance ? structuredClone(options.provenance) : undefined;
		this.#enabled = options.enabled;
		this.#providerOrderHint = options.providerOrderHint ? structuredClone(options.providerOrderHint) : undefined;
		this.#stale = options.stale;
		this.#preview = clonePreview(options.preview);
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

	getPreviewPayload(): SmartRoutingPreview {
		return clonePreview(this.#preview);
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

	/** Replace the panel's persisted snapshot after a controller mutation. */
	refreshState(options: {
		setup: AutoroutingSetup;
		tiers?: TierMap;
		provenance?: AutoroutingProvenance;
		enabled: boolean;
		providerOrderHint?: AutoroutingProviderOrderHint;
		stale: boolean;
		preview: SmartRoutingPreview;
	}): void {
		this.#draft = cloneSetup(options.setup);
		this.#tiers = options.tiers ? structuredClone(options.tiers) : undefined;
		this.#provenance = options.provenance ? structuredClone(options.provenance) : undefined;
		this.#enabled = options.enabled;
		this.#stale = options.stale;
		this.#providerOrderHint = options.providerOrderHint ? structuredClone(options.providerOrderHint) : undefined;
		this.#preview = clonePreview(options.preview);
		this.#providerCursor = Math.min(this.#providerCursor, Math.max(0, this.#draft.providers.length - 1));
		this.#mode = "editing";
		this.#confirmation = undefined;
		this.#status = "";
		this.#error = "";
		this.#render();
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
		this.addChild(new Text(theme.fg("muted", `Enabled: ${this.#enabled ? "yes" : "no"}`), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Providers (↑/↓ reorder; x removes; m edits allowlist):"), 0, 0));
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
		for (const tier of ["fast", "balanced", "strong"] as const) {
			this.addChild(new Text(`  ${formatTier(tier, this.#preview.tiers)}`, 0, 0));
		}
		if (this.#status) this.addChild(new Text(theme.fg("success", displaySafe(this.#status)), 0, 0));
		if (this.#error) this.addChild(new Text(theme.fg("error", displaySafe(this.#error)), 0, 0));
		if (this.#confirmation === "clear") {
			this.addChild(
				new Text(
					theme.fg("warning", "Clear generated tiers, setup, and provenance? Enter confirms; Esc cancels."),
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
		const actions = this.#readOnly ? "Esc: cancel" : "a: apply · r: refresh · t: toggle · c: clear · Esc: cancel";
		this.addChild(new Text(theme.fg("muted", actions), 0, 0));
	}

	#recomputePreview(): void {
		try {
			this.#preview = clonePreview(this.#generatePreview(this.#draft));
			this.#error = "";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
	}

	async #emit(intent: SmartRoutingIntent): Promise<void> {
		if (this.#readOnly || this.#mode === "committing") return;
		this.#mode = "committing";
		this.#status = "Committing smart-routing settings…";
		this.#error = "";
		this.#confirmation = undefined;
		this.#render();
		try {
			const result = await this.#onSelect(intent);
			if (intent.kind === "apply") {
				const appliedPreview = result ?? this.#generatePreview(intent.draft);
				this.#draft = cloneSetup(appliedPreview.setup);
				this.#preview = clonePreview(appliedPreview);
			} else if (intent.kind === "toggle") {
				this.#enabled = intent.enabled;
			}
			this.#mode = "done";
			this.#status = intent.kind === "clear" ? "Generated setup cleared." : "Smart-routing settings saved.";
		} catch (error) {
			const typed = error as { code?: unknown } | undefined;
			if (typed?.code === "autorouting-hand-edited") {
				this.#mode = "confirming";
				this.#confirmation = "hand-edit";
				// Retain the intent that triggered the guard so confirming replays THAT intent. An Apply
				// carrying an edited draft must not be silently downgraded to a Refresh, which would
				// discard the frozen preview and commit the previously recorded setup instead (AC6).
				this.#pendingIntent = intent;
				this.#status = "";
				this.#error = "";
			} else {
				this.#mode = "error";
				this.#error = error instanceof Error ? error.message : String(error);
				this.#status = "";
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
		this.#recomputePreview();
		this.#render();
	}

	handleInput(data: string): void {
		if (this.#mode === "committing") return;
		if (this.#mode === "done" || this.#mode === "error") {
			if (getKeybindings().matches(data, "tui.select.cancel")) this.#onCancel();
			return;
		}
		if (this.#confirmation) {
			if (getKeybindings().matches(data, "tui.select.cancel")) {
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
				this.#render();
				return;
			}
			if (isBackspace(data)) {
				this.#allowlistBuffer = this.#allowlistBuffer.slice(0, -1);
				this.#render();
				return;
			}
			if (isPrintable(data)) {
				this.#allowlistBuffer += data;
				this.#render();
			}
			return;
		}
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.#onCancel();
			return;
		}
		if (this.#readOnly) return;
		if (data === "m" || data === "M") {
			this.#allowlistEditing = true;
			this.#allowlistBuffer = this.#draft.models?.join(", ") ?? "";
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
			void this.#emit({ kind: "apply", draft: cloneSetup(this.#draft), preview: clonePreview(this.#preview) });
			return;
		}
		if (data === "r" || data === "R") {
			void this.#emit({ kind: "refresh" });
			return;
		}
		if (data === "t" || data === "T") {
			void this.#emit({ kind: "toggle", enabled: !this.#enabled });
			return;
		}
		if (data === "c" || data === "C") {
			this.#beginClearConfirmation();
		}
	}

	__testApply(): Promise<void> {
		return this.#emit({ kind: "apply", draft: cloneSetup(this.#draft), preview: clonePreview(this.#preview) });
	}

	/** Test hook mirroring an in-panel provider reorder/edit: mutates the draft and re-previews. */
	__testSetProviders(providers: string[]): void {
		this.#draft = { ...this.#draft, providers: [...providers] };
		this.#preview = this.#generatePreview(this.#draft);
		this.#providerCursor = 0;
	}

	__testRefresh(confirmHandEdit = false): Promise<void> {
		return this.#emit({ kind: "refresh", ...(confirmHandEdit ? { confirmHandEdit: true } : {}) });
	}

	__testToggle(enabled = !this.#enabled): Promise<void> {
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
		return this.#emit({ kind: "refresh", confirmHandEdit: true });
	}
}

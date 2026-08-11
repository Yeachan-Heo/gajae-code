/**
 * Ordered provider priority editor for `modelProviderOrder`.
 *
 * Full-screen custom settings editor (Container + row list, mirroring the
 * StatusLine custom editor layout) with add/remove/move-up/move-down/reset
 * actions that persist to settings immediately. Rows are rebuilt from the live
 * `ProviderOrderContext` snapshot before every render pass, keeping the
 * previously selected provider highlighted when the underlying order or auth
 * state changes. Unavailable persisted providers are retained and dimmed.
 *
 * The editor owns the `ProviderOrderContext` lifecycle: both normal close
 * (`#close`) and external teardown (`dispose()`) release the context
 * subscriptions and dispose the container, idempotently.
 */

import { Container, getKeybindings, matchesKey, Spacer, Text } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { theme } from "../../modes/theme/theme";
import {
	formatProviderOrderLabel,
	type ProviderOrderContext,
	type ProviderOrderEntry,
	type ProviderOrderSnapshot,
} from "./provider-order-context";

type EditorPage = "main" | "add";

type EditorRowKind = "action" | "provider" | "providerAction" | "candidate" | "back" | "empty";

interface EditorRow {
	/** Stable row identity used to restore the selection after a rebuild. */
	id: string;
	kind: EditorRowKind;
	/** Sanitized display text (no ANSI / control chars). */
	label: string;
	/** Right-side status text (sanitized). */
	status?: string;
	/** Normalized provider id when the row belongs to a provider. */
	providerId?: string;
	/** Render the label dimmed (e.g. unavailable providers). */
	dimmer?: boolean;
}

function entryStatus(entry: ProviderOrderEntry | undefined): string {
	if (!entry?.available) return "unavailable";
	return entry.authenticated ? "logged in" : "not logged in";
}

function entryDetail(entry: ProviderOrderEntry | undefined, adding = false): string {
	const base = entry?.available
		? entry.authenticated
			? "Credentials are available for this provider."
			: "No credentials yet; it still wins priority once configured."
		: "Unavailable right now (not in the model catalog); retained and skipped at runtime.";
	return adding ? `${base} Adds this provider to the end of the order.` : base;
}

export class ProviderOrderEditorComponent extends Container {
	#context: ProviderOrderContext;
	#onClose: () => void;
	#onError: ((message: string) => void) | undefined;
	#page: EditorPage = "main";
	#rows: EditorRow[] = [];
	#selectedIndex = 0;
	#selectedRowId: string | undefined;
	#selectedProviderId: string | undefined;
	#rowsContainer: Container;
	#detailText: Text;
	#hintText: Text;
	#closed = false;
	#persisting = false;

	constructor(context: ProviderOrderContext, onClose: () => void, onError?: (message: string) => void) {
		super();
		this.#context = context;
		this.#onClose = onClose;
		this.#onError = onError;

		this.addChild(new Text(theme.bold(theme.fg("accent", "Provider Priority Order")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Providers listed earlier win ties during automatic model resolution. Unavailable saved entries are kept but skipped at runtime.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#rowsContainer = new Container();
		this.addChild(this.#rowsContainer);
		this.#detailText = new Text("", 0, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.#detailText);
		this.addChild(new Spacer(1));
		this.#hintText = new Text("", 0, 0);
		this.addChild(this.#hintText);

		try {
			this.#rebuild();
		} catch (error) {
			// The context subscribed to settings/auth in its constructor; if the
			// initial snapshot/rebuild fails, release those subscriptions before
			// rethrowing so a construction failure cannot leak listeners.
			this.dispose();
			throw error;
		}
	}

	/** Rebuild rows from the current snapshot. Called by the controller on context changes. */
	refresh(): void {
		if (this.#closed) return;
		this.#rebuild();
	}

	#rebuild(): void {
		const snapshot = this.#context.snapshot();
		const preserveRowId = this.#selectedRowId;
		const preserveProviderId = this.#selectedProviderId;

		this.#rows = this.#page === "add" ? this.#buildAddRows(snapshot) : this.#buildMainRows(snapshot);

		let nextIndex = 0;
		if (preserveRowId) {
			const exact = this.#rows.findIndex(row => row.id === preserveRowId);
			if (exact >= 0) {
				nextIndex = exact;
			} else {
				const byProvider = preserveProviderId
					? this.#rows.findIndex(row => row.providerId === preserveProviderId)
					: -1;
				nextIndex =
					byProvider >= 0 ? byProvider : Math.min(this.#selectedIndex, Math.max(0, this.#rows.length - 1));
			}
		} else {
			nextIndex = Math.min(this.#selectedIndex, Math.max(0, this.#rows.length - 1));
		}

		this.#selectedIndex = nextIndex;
		this.#captureSelection();
		this.#renderRows();
		this.#renderFooter();
	}

	#captureSelection(): void {
		const row = this.#rows[this.#selectedIndex];
		this.#selectedRowId = row?.id;
		this.#selectedProviderId = row?.providerId;
	}

	#buildMainRows(snapshot: ProviderOrderSnapshot): EditorRow[] {
		const rows: EditorRow[] = [
			{ id: "action.add", kind: "action", label: "Add provider", status: "+" },
			{ id: "action.reset", kind: "action", label: "Reset to default order", status: "reset" },
		];

		if (snapshot.order.length === 0) {
			rows.push({
				id: "empty",
				kind: "empty",
				label: "No providers in priority order yet. Use Add provider to build the order.",
			});
		} else {
			for (let index = 0; index < snapshot.order.length; index++) {
				const providerId = snapshot.order[index]!;
				const entry = snapshot.entries.find(candidate => candidate.id === providerId);
				const label = sanitizeText(entry?.label ?? formatProviderOrderLabel(providerId));
				rows.push({
					id: `provider.${providerId}`,
					kind: "provider",
					label: `#${index + 1} ${label}`,
					status: entryStatus(entry),
					providerId,
					dimmer: entry ? !entry.available : true,
				});
				rows.push({
					id: `moveup.${providerId}`,
					kind: "providerAction",
					label: `Move up: ${label}`,
					status: "up",
					providerId,
				});
				rows.push({
					id: `movedown.${providerId}`,
					kind: "providerAction",
					label: `Move down: ${label}`,
					status: "down",
					providerId,
				});
				rows.push({
					id: `remove.${providerId}`,
					kind: "providerAction",
					label: `Remove: ${label}`,
					status: "remove",
					providerId,
				});
			}
		}

		rows.push({ id: "action.done", kind: "action", label: "Done", status: "done" });
		return rows;
	}

	#buildAddRows(snapshot: ProviderOrderSnapshot): EditorRow[] {
		const rows: EditorRow[] = [{ id: "back", kind: "back", label: "Back to order" }];
		const candidates = snapshot.entries.filter(entry => !entry.inOrder);
		if (candidates.length === 0) {
			rows.push({
				id: "empty",
				kind: "empty",
				label: "Every known provider is already in the priority order.",
			});
		} else {
			for (const entry of candidates) {
				rows.push({
					id: `candidate.${entry.id}`,
					kind: "candidate",
					label: sanitizeText(entry.label),
					status: entryStatus(entry),
					providerId: entry.id,
					dimmer: !entry.available,
				});
			}
		}
		return rows;
	}

	#renderRows(): void {
		this.#rowsContainer.clear();
		for (let index = 0; index < this.#rows.length; index++) {
			const row = this.#rows[index];
			if (!row) continue;
			this.#rowsContainer.addChild(new Text(this.#renderRow(row, index === this.#selectedIndex), 0, 0));
		}
	}

	#renderRow(row: EditorRow, selected: boolean): string {
		const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		let label = row.label;
		if (selected) {
			label = theme.fg("accent", label);
		} else if (row.dimmer) {
			label = theme.fg("dim", label);
		}
		let line = `${prefix}${label}`;
		if (row.status) {
			const status =
				selected || row.kind === "providerAction" || row.kind === "action"
					? theme.fg("dim", row.status)
					: row.status === "logged in"
						? theme.fg("success", row.status)
						: theme.fg("dim", row.status);
			line += `  ${status}`;
		}
		return line;
	}

	#renderFooter(): void {
		const row = this.#rows[this.#selectedIndex];
		let detail = "";
		if (row) {
			switch (row.kind) {
				case "provider": {
					const entry = this.#context.snapshot().entries.find(candidate => candidate.id === row.providerId);
					detail = entryDetail(entry);
					break;
				}
				case "candidate": {
					const entry = this.#context.snapshot().entries.find(candidate => candidate.id === row.providerId);
					detail = entryDetail(entry, true);
					break;
				}
				case "providerAction": {
					detail = row.id.startsWith("moveup.")
						? "Move this provider earlier in the priority order."
						: row.id.startsWith("movedown.")
							? "Move this provider later in the priority order."
							: "Remove this provider from the priority order.";
					break;
				}
				case "action":
					detail =
						row.id === "action.add"
							? "Append a provider to the end of the priority order."
							: row.id === "action.reset"
								? "Clear the saved order so default provider ranking applies."
								: "Close the editor. Changes already saved take effect immediately.";
					break;
				case "back":
					detail = "Return to the priority order without adding a provider.";
					break;
				default:
					detail = "";
					break;
			}
		}
		this.#detailText.setText(theme.fg("muted", detail));
		this.#hintText.setText(
			theme.fg(
				"dim",
				this.#page === "add"
					? "  Up/Down navigate · Enter add · Esc back"
					: "  Up/Down navigate · Enter select · Esc close",
			),
		);
	}

	#moveSelection(delta: 1 | -1): void {
		if (this.#rows.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + this.#rows.length) % this.#rows.length;
		this.#captureSelection();
		this.#rebuild();
	}

	handleInput(data: string): void {
		if (this.#closed || this.#persisting) return;
		if (matchesKey(data, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activate();
			return;
		}
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			if (this.#page === "add") {
				this.#page = "main";
				this.#selectedIndex = 0;
				this.#captureSelection();
				this.#rebuild();
			} else {
				this.#close();
			}
		}
	}

	#activate(): void {
		const row = this.#rows[this.#selectedIndex];
		if (!row) return;

		if (this.#page === "add") {
			if (row.kind === "back") {
				this.#page = "main";
				this.#selectedIndex = 0;
				this.#captureSelection();
				this.#rebuild();
				return;
			}
			if (row.kind === "candidate" && row.providerId) {
				const order = this.#context.snapshot().order;
				void this.#persist([...order, row.providerId]);
				return;
			}
			return;
		}

		if (row.kind === "provider") return;

		if (row.kind === "providerAction" && row.providerId) {
			this.#mutateOrder(row);
			return;
		}

		switch (row.id) {
			case "action.add":
				this.#page = "add";
				this.#selectedIndex = 0;
				this.#captureSelection();
				this.#rebuild();
				return;
			case "action.reset":
				void this.#persistReset();
				return;
			case "action.done":
				this.#close();
				return;
		}
	}

	#mutateOrder(row: EditorRow): void {
		const providerId = row.providerId;
		if (!providerId) return;
		const order = [...this.#context.snapshot().order];
		const index = order.indexOf(providerId);
		if (index < 0) return;
		if (row.id.startsWith("moveup.")) {
			if (index === 0) return;
			order.splice(index - 1, 2, providerId, order[index - 1]!);
		} else if (row.id.startsWith("movedown.")) {
			if (index === order.length - 1) return;
			order.splice(index, 2, order[index + 1]!, providerId);
		} else if (row.id.startsWith("remove.")) {
			order.splice(index, 1);
		} else {
			return;
		}
		void this.#persist(order);
	}

	async #persist(order: readonly string[]): Promise<void> {
		this.#persisting = true;
		try {
			await this.#context.persistOrder(order);
		} catch (error) {
			this.#onError?.(error instanceof Error ? error.message : String(error));
		} finally {
			this.#persisting = false;
			if (!this.#closed) this.#rebuild();
		}
	}

	async #persistReset(): Promise<void> {
		this.#persisting = true;
		try {
			await this.#context.resetOrder();
		} catch (error) {
			this.#onError?.(error instanceof Error ? error.message : String(error));
		} finally {
			this.#persisting = false;
			if (!this.#closed) this.#rebuild();
		}
	}

	#close(): void {
		if (this.#closed) return;
		this.dispose();
		this.#onClose();
	}
	override dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#context.dispose();
		super.dispose();
	}
}

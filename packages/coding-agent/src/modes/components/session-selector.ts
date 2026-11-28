import {
	type Component,
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { formatBytes, sanitizeDisplayLine, sanitizeText } from "@gajae-code/utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import type { ResumeSessionIdentity } from "../../sdk/session-readonly/storage";
import type { SessionHandoverOutcome, SessionHandoverWaitOptions } from "../../session/session-handover";
import { prioritizeStarredSessions, type ResumeTailInspection, type SessionInfo } from "../../session/session-manager";
import {
	type SessionHeldError,
	type SessionOwnerClaim,
	sessionOwnerHolderMarker,
} from "../../session/session-ownership";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";
import { createHeldSessionWarning, SESSION_HOST_WAITING_MESSAGE } from "./session-held-warning";

export interface SelectedSession {
	kind: "selected";
	path: string;
	identity: ResumeSessionIdentity;
	action: "continue-tail" | "open-idle";
	/** Continue here's claim of the session: the caller releases it once its open has claimed. */
	admission?: SessionOwnerClaim;
}

export interface CancelledSessionSelection {
	kind: "cancelled";
}

/** Fork chosen from the held-session warning: the session stays with its holder, a copy opens idle. */
export interface ForkHeldSessionSelection {
	kind: "fork";
	path: string;
	error: SessionHeldError;
}

export type SessionSelectionResult = SelectedSession | CancelledSessionSelection | ForkHeldSessionSelection;
/** A session another process holds, as checked when it is chosen. */
export interface HeldSession {
	readonly error: SessionHeldError;
	/**
	 * Continue here (design §13 L1), only when the holder is a broker-launched host: close it and
	 * claim the session for the caller, which releases the claim once its open has claimed.
	 */
	readonly handOver?: () => Promise<SessionHandoverOutcome>;
}
/**
 * Whether another process holds a session, checked when it is chosen (enforce only). `wait` lets the
 * picker show the wait for a launched host and stop it when the check is abandoned.
 */
export type HeldSessionCheck = (
	session: SessionInfo,
	wait?: SessionHandoverWaitOptions,
) => Promise<HeldSession | undefined>;
export type SessionInspector = (sessionPath: string) => Promise<ResumeTailInspection>;

/** One picker row. Keep each newline as its own space, then drop terminal controls. */
function sessionRowText(value: string): string {
	return sanitizeText(value).replace(/\n/g, " ");
}

/** Marks a model-generated recap row so it reads as generated text, not the user's message. */
const SESSION_RECAP_LABEL = "[AI recap]";

type SelectorState =
	| { kind: "browsing" }
	| { kind: "starring"; token: number }
	| { kind: "checking"; session: SessionInfo; token: number }
	| { kind: "confirming"; session: SessionInfo; token: number; identity: ResumeSessionIdentity }
	| { kind: "warning"; session: SessionInfo; token: number }
	/** Continue here is closing the holder: input is frozen and it cannot be cancelled. */
	| { kind: "handing-over"; session: SessionInfo; token: number }
	| { kind: "settled" };

class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex = 0;
	readonly #searchInput = new Input();
	readonly #heldMarkers = new Map<string, string>();
	#inputFrozen = false;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onDeleteRequest?: (session: SessionInfo) => void;
	onToggleStarRequest?: (session: SessionInfo) => void;

	constructor(
		private readonly allSessions: SessionInfo[],
		private readonly showCwd = false,
	) {
		this.#filteredSessions = prioritizeStarredSessions(allSessions);
		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) this.onSelect?.(selected);
		};
	}

	setInputFrozen(frozen: boolean): void {
		this.#inputFrozen = frozen;
	}

	/** Mark (or unmark, with `undefined`) a session another process holds, by id: `in terminal`. */
	setHeldMarker(sessionId: string, marker: string | undefined): void {
		if (marker === undefined) this.#heldMarkers.delete(sessionId);
		else this.#heldMarkers.set(sessionId, marker);
	}

	#clampSelectedIndex(): void {
		this.#selectedIndex =
			this.#filteredSessions.length === 0
				? 0
				: Math.max(0, Math.min(this.#selectedIndex, this.#filteredSessions.length - 1));
	}

	#filterSessions(query: string): void {
		this.#filteredSessions = prioritizeStarredSessions(
			fuzzyFilter(this.allSessions, query, session =>
				[
					session.id,
					session.title ?? "",
					session.cwd ?? "",
					session.firstMessage ?? "",
					session.recap?.text ?? "",
					session.allMessagesText,
					session.path,
				]
					.filter(Boolean)
					.join(" "),
			),
		);
		this.#clampSelectedIndex();
	}

	removeSession(sessionPath: string): void {
		const index = this.allSessions.findIndex(session => session.path === sessionPath);
		if (index === -1) return;
		this.allSessions.splice(index, 1);
		this.#filterSessions(this.#searchInput.getValue());
	}

	setSessionStarred(sessionPath: string, starred: boolean): void {
		const session = this.allSessions.find(session => session.path === sessionPath);
		if (!session) return;
		session.starred = starred;
		this.#filterSessions(this.#searchInput.getValue());
		this.#selectedIndex = Math.max(
			0,
			this.#filteredSessions.findIndex(session => session.path === sessionPath),
		);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [...this.#searchInput.render(width), ""];
		if (this.#filteredSessions.length === 0) {
			lines.push(
				truncateToWidth(
					theme.fg(
						"muted",
						this.showCwd ? "  No sessions found" : "  No sessions in current folder. Press Tab to view all.",
					),
					width,
				),
			);
			return lines;
		}
		const formatDate = (date: Date): string => {
			const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
			if (minutes < 1) return "just now";
			if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
			const days = Math.floor(hours / 24);
			return days === 1 ? "1 day ago" : days < 7 ? `${days} days ago` : date.toLocaleDateString();
		};
		const maxVisible = 5;
		const start = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.#filteredSessions.length);
		for (let index = start; index < end; index++) {
			const session = this.#filteredSessions[index];
			const selected = index === this.#selectedIndex;
			const cursor = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursor);
			const prefix = selected ? theme.fg("accent", cursor) : padding(cursorWidth);
			const message = sessionRowText(session.firstMessage).trim();
			const star = session.starred ? theme.fg("warning", `${theme.icon.star} `) : "";
			const heldMarker = this.#heldMarkers.get(session.id);
			const held = heldMarker ? theme.fg("warning", `  ${theme.format.bullet} ${heldMarker}`) : "";
			const title = truncateToWidth(
				sessionRowText(session.title ?? message),
				width - cursorWidth - visibleWidth(star) - visibleWidth(held),
			);
			const row = prefix + star + (selected ? theme.bold(title) : title);
			lines.push(held ? truncateToWidth(row + held, width) : row);
			if (session.recap) {
				// A model-written recap replaces the first-message description and is labelled as such,
				// so it is never mistaken for the user's own words.
				const recapText = replaceTabs(sanitizeDisplayLine(session.recap.text)).trim();
				lines.push(
					truncateToWidth(`  ${theme.fg("muted", SESSION_RECAP_LABEL)} ${theme.fg("dim", recapText)}`, width),
				);
			} else if (session.title) {
				lines.push(`  ${theme.fg("dim", truncateToWidth(message, width - cursorWidth))}`);
			}
			lines.push(
				theme.fg(
					"dim",
					truncateToWidth(
						`  ${formatDate(session.modified)} ${theme.sep.dot} ${formatBytes(session.size)}`,
						width,
					),
				),
			);
			lines.push("");
		}
		if (start > 0 || end < this.#filteredSessions.length)
			lines.push(theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#filteredSessions.length})`));
		if (this.onToggleStarRequest)
			lines.push(theme.fg("muted", truncateToWidth("  [Ctrl+S to star/unstar selected session]", width)));
		lines.push(
			"",
			theme.fg("muted", "  [Del to delete selected transcript/artifacts, Enter to select, Esc to cancel]"),
		);
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		if (this.#inputFrozen) return;
		const move = (delta: number): void => {
			if (this.#filteredSessions.length === 0) return;
			this.#selectedIndex += delta;
			this.#clampSelectedIndex();
		};
		if (matchesKey(keyData, "ctrl+s")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) this.onToggleStarRequest?.(selected);
		} else if (matchesKey(keyData, "delete")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) this.onDeleteRequest?.(selected);
		} else if (matchesKey(keyData, "up")) move(-1);
		else if (matchesKey(keyData, "down")) move(1);
		else if (matchesKey(keyData, "pageUp")) move(-5);
		else if (matchesKey(keyData, "pageDown")) move(5);
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) this.onSelect?.(selected);
		} else {
			this.#searchInput.handleInput(keyData);
			this.#filterSessions(this.#searchInput.getValue());
		}
	}
}

/** A one-shot resume consent selector with host-owned deletion and star persistence. */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#messageContainer = new Container();
	#onRequestRender?: () => void;
	#state: SelectorState = { kind: "browsing" };
	#nextToken = 0;
	#heldCheck: HeldSessionCheck | undefined;
	/** Stops the held check in flight, and its wait for a session host, when the picker moves on. */
	#heldCheckAbort: AbortController | undefined;

	constructor(
		sessions: SessionInfo[],
		private readonly onSelect: (sessionPath: string) => void | Promise<void>,
		private readonly onCancel: () => void,
		private readonly onExit: () => void,
		private readonly onDelete?: (session: SessionInfo) => Promise<boolean>,
		private readonly inspector?: SessionInspector,
		private readonly onSelection?: (selection: SessionSelectionResult) => void,
		private readonly onSetStarred?: (session: SessionInfo, starred: boolean) => Promise<void>,
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		this.#sessionList = new SessionList([...sessions]);
		this.#sessionList.onSelect = session => {
			if (this.inspector) void this.#inspect(session);
			else this.#dispatchSelect(session.path);
		};
		this.#sessionList.onCancel = () => this.#cancel();
		this.#sessionList.onExit = () => this.#exit();
		this.#sessionList.onDeleteRequest = session => this.#showDeleteConfirmation(session);
		if (this.onSetStarred) this.#sessionList.onToggleStarRequest = session => void this.#toggleStar(session);
		this.addChild(this.#sessionList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	/**
	 * Under enforce (design §1 row 2): mark the rows other processes hold, and, with `check`, show the
	 * held-session warning when one is chosen instead of resuming it. Cancel returns to the list.
	 */
	setHeldSessions(held: ReadonlyMap<string, SessionHeldError>, check?: HeldSessionCheck): void {
		for (const [sessionId, error] of held)
			this.#sessionList.setHeldMarker(sessionId, sessionOwnerHolderMarker(error.holder));
		this.#heldCheck = check;
	}
	#clearError(): void {
		this.#messageContainer.clear();
	}
	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(
			new Text(theme.fg("error", `Error: ${replaceTabs(message).slice(0, 200)}`), 1, 0),
		);
		this.#messageContainer.addChild(new Spacer(1));
	}
	#requestRender(): void {
		this.#onRequestRender?.();
	}

	/**
	 * Observe async `onSelect` handlers. Callers (e.g. resume) may return a
	 * Promise; leaving it unobserved turns preparation/switch failures into
	 * process-killing unhandled rejections. Inline recovery keeps the picker
	 * usable when the host has not already closed it.
	 */
	#dispatchSelect(sessionPath: string): void {
		void Promise.resolve(this.onSelect(sessionPath)).catch((error: unknown) => {
			if (this.#state.kind === "settled") {
				// Host already closed the picker (interactive resume path). Surface the
				// message only if we still have a render surface; controller catch is
				// the primary recovery path after `done()`.
				this.#showError(error instanceof Error ? error.message : String(error));
				this.#requestRender();
				return;
			}
			this.#state = { kind: "browsing" };
			this.#sessionList.setInputFrozen(false);
			this.#showError(error instanceof Error ? error.message : String(error));
			this.#requestRender();
		});
	}

	#settle(selection: SessionSelectionResult): void {
		if (this.#state.kind === "settled") return;
		this.#state = { kind: "settled" };
		this.#sessionList.setInputFrozen(true);
		const dialog = this.#confirmationDialog;
		this.#confirmationDialog = null;
		if (dialog) this.removeChild(dialog);
		if (this.onSelection) this.onSelection(selection);
		else if (selection.kind === "selected") this.#dispatchSelect(selection.path);
		else this.onCancel();
	}
	#cancel(): void {
		if (this.#state.kind === "settled" || this.#state.kind === "handing-over") return;
		if (this.#state.kind === "checking") this.#nextToken++;
		this.#heldCheckAbort?.abort();
		this.#settle({ kind: "cancelled" });
	}
	#exit(): void {
		// A handover cannot be interrupted (it is bounded); Ctrl+C is ignored until it settles.
		if (this.#state.kind === "handing-over") return;
		if (this.#state.kind !== "settled") this.#nextToken++;
		this.#heldCheckAbort?.abort();
		this.#state = { kind: "settled" };
		this.#sessionList.setInputFrozen(true);
		this.onExit();
	}
	async #toggleStar(session: SessionInfo): Promise<void> {
		if (!this.onSetStarred || this.#state.kind !== "browsing" || this.#confirmationDialog) return;
		const token = ++this.#nextToken;
		const starred = !session.starred;
		this.#state = { kind: "starring", token };
		this.#sessionList.setInputFrozen(true);
		this.#clearError();
		this.#requestRender();
		try {
			await this.onSetStarred(session, starred);
			if (this.#state.kind !== "starring" || this.#state.token !== token) return;
			this.#sessionList.setSessionStarred(session.path, starred);
		} catch (error) {
			if (this.#state.kind !== "starring" || this.#state.token !== token) return;
			this.#showError(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.#state.kind === "starring" && this.#state.token === token) {
				this.#state = { kind: "browsing" };
				this.#sessionList.setInputFrozen(false);
				this.#requestRender();
			}
		}
	}
	async #inspect(session: SessionInfo): Promise<void> {
		const inspector = this.inspector;
		if (!inspector || this.#state.kind !== "browsing") return;
		const token = ++this.#nextToken;
		this.#state = { kind: "checking", session, token };
		this.#sessionList.setInputFrozen(true);
		this.#clearError();
		this.#requestRender();
		const abort = new AbortController();
		this.#heldCheckAbort = abort;
		const current = () => this.#state.kind === "checking" && this.#state.token === token;
		try {
			// Checked again when chosen: the list's markers are only as fresh as the listing.
			const held = this.#heldCheck
				? await this.#heldCheck(session, {
						signal: abort.signal,
						onWaiting: () => {
							if (!current()) return;
							this.#messageContainer.clear();
							this.#messageContainer.addChild(new Text(theme.fg("muted", SESSION_HOST_WAITING_MESSAGE), 1, 0));
							this.#requestRender();
						},
					})
				: undefined;
			if (!current()) return;
			this.#clearError();
			if (this.#heldCheck)
				this.#sessionList.setHeldMarker(session.id, held && sessionOwnerHolderMarker(held.error.holder));
			if (held) {
				this.#showHeldWarning(session, token, held);
				return;
			}
		} catch (error) {
			this.#failCheck(token, error);
			return;
		} finally {
			if (this.#heldCheckAbort === abort) this.#heldCheckAbort = undefined;
		}
		await this.#inspectChosen(session, token, inspector);
	}
	/** The inspection and resume confirmation of a chosen session nobody else holds. */
	async #inspectChosen(session: SessionInfo, token: number, inspector: SessionInspector): Promise<void> {
		try {
			const inspection = await inspector(session.path);
			if (this.#state.kind !== "checking" || this.#state.token !== token) return;
			if (inspection.kind === "error") {
				this.#state = { kind: "browsing" };
				this.#sessionList.setInputFrozen(false);
				this.#showError(`Unable to inspect session (${inspection.reason}).`);
				this.#requestRender();
				return;
			}
			if (inspection.kind === "terminal") {
				this.#settle({ kind: "selected", path: session.path, identity: inspection.identity, action: "open-idle" });
				return;
			}
			this.#showResumeConfirmation(session, token, inspection.identity);
		} catch (error) {
			this.#failCheck(token, error);
		}
	}
	#failCheck(token: number, error: unknown): void {
		if (this.#state.kind !== "checking" || this.#state.token !== token) return;
		this.#state = { kind: "browsing" };
		this.#sessionList.setInputFrozen(false);
		this.#showError(error instanceof Error ? error.message : String(error));
		this.#requestRender();
	}
	/**
	 * Continue here: the read-only inspection and the resume confirmation come first, so nothing is
	 * closed before the user's final yes; then the handover, which cannot be cancelled.
	 */
	async #continueHere(session: SessionInfo, token: number, held: HeldSession): Promise<void> {
		const inspector = this.inspector;
		if (!held.handOver || !inspector) return;
		this.#state = { kind: "checking", session, token };
		this.#requestRender();
		let inspection: ResumeTailInspection;
		try {
			inspection = await inspector(session.path);
		} catch (error) {
			this.#failCheck(token, error);
			return;
		}
		if (this.#state.kind !== "checking" || this.#state.token !== token) return;
		if (inspection.kind === "error") {
			this.#failCheck(token, `Unable to inspect session (${inspection.reason}).`);
			return;
		}
		if (inspection.kind === "terminal") {
			await this.#handOverAndSettle(session, token, held, inspector, "open-idle");
			return;
		}
		this.#showResumeConfirmation(session, token, inspection.identity, () =>
			this.#handOverAndSettle(session, token, held, inspector, "continue-tail"),
		);
	}
	async #handOverAndSettle(
		session: SessionInfo,
		token: number,
		held: HeldSession,
		inspector: SessionInspector,
		action: SelectedSession["action"],
	): Promise<void> {
		if (!held.handOver) return;
		const dialog = this.#confirmationDialog;
		if (dialog) this.removeChild(dialog);
		this.#confirmationDialog = null;
		this.#state = { kind: "handing-over", session, token };
		this.#sessionList.setInputFrozen(true);
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("muted", "Handing the session over…"), 1, 0));
		this.#requestRender();
		// Still this handover: nothing settled the picker meanwhile.
		const current = () => this.#state.kind === "handing-over" && this.#state.token === token;
		let claim: SessionOwnerClaim | undefined;
		try {
			const outcome = await held.handOver();
			if (outcome.kind === "closed") claim = outcome.claim;
			if (!current()) {
				claim?.release();
				return;
			}
			if (outcome.kind === "refused") {
				this.#clearError();
				this.#showHeldWarning(session, token, held, outcome.message);
				return;
			}
			this.#sessionList.setHeldMarker(session.id, undefined);
			// Read the tail again under the claim: the host may have finished a turn since the first read.
			const inspection = await inspector(session.path);
			if (!current()) {
				claim?.release();
				return;
			}
			if (inspection.kind === "error") throw new Error(`Unable to inspect session (${inspection.reason}).`);
			const settled = { kind: "selected", path: session.path, identity: inspection.identity } as const;
			this.#settle({
				...settled,
				action: inspection.kind === "terminal" ? "open-idle" : action,
				...(claim ? { admission: claim } : {}),
			});
		} catch (error) {
			// Never back to the list while holding the session, and never on a picker that closed.
			claim?.release();
			if (!current()) return;
			this.#state = { kind: "checking", session, token };
			this.#failCheck(token, error);
		}
	}
	#showResumeConfirmation(
		session: SessionInfo,
		token: number,
		identity: ResumeSessionIdentity,
		onYes?: () => Promise<void>,
	): void {
		this.#state = { kind: "confirming", session, token, identity };
		const dialog = new HookSelectorComponent(
			"Resume this session?",
			["Yes", "No"],
			option => {
				if (this.#confirmationDialog !== dialog || this.#state.kind !== "confirming") return;
				if (option === "Yes" && onYes) void onYes();
				else if (option === "Yes")
					this.#settle({ kind: "selected", path: session.path, identity, action: "continue-tail" });
				else this.#settle({ kind: "cancelled" });
			},
			() => this.#settle({ kind: "cancelled" }),
			{ acceleratorMap: { y: "Yes", n: "No" } },
		);
		this.#confirmationDialog = dialog;
		this.addChild(dialog);
		this.#requestRender();
	}
	#showHeldWarning(session: SessionInfo, token: number, held: HeldSession, note?: string): void {
		this.#state = { kind: "warning", session, token };
		const { error } = held;
		const dialog = createHeldSessionWarning(
			error,
			choice => {
				if (this.#confirmationDialog !== dialog || this.#state.kind !== "warning") return;
				switch (choice) {
					case "fork":
						this.#settle({ kind: "fork", path: session.path, error });
						return;
					case "continue":
						this.removeChild(dialog);
						this.#confirmationDialog = null;
						void this.#continueHere(session, token, held);
						return;
					case "cancel":
						this.removeChild(dialog);
						this.#confirmationDialog = null;
						this.#state = { kind: "browsing" };
						this.#sessionList.setInputFrozen(false);
						this.#requestRender();
						return;
					default: {
						const unknown: never = choice;
						throw new Error(`Unknown held-session choice: ${String(unknown)}`);
					}
				}
			},
			{ continueHere: held.handOver !== undefined, note },
		);
		this.#confirmationDialog = dialog;
		this.addChild(dialog);
		this.#requestRender();
	}
	#showDeleteConfirmation(session: SessionInfo): void {
		if (this.#state.kind !== "browsing" || this.#confirmationDialog) return;
		const fromTitle = session.title ? sessionRowText(session.title) : "";
		const displayName = fromTitle || sessionRowText(session.firstMessage).slice(0, 40) || session.id;
		let deleting = false;
		const dialog = new HookSelectorComponent(
			`Delete selected session transcript and artifacts?\n${displayName}\nThis cannot be undone. Other sessions and topic/history metadata are not deleted.`,
			["Yes", "No"],
			async option => {
				if (this.#confirmationDialog !== dialog || deleting) return;
				if (option === "Yes" && this.onDelete) {
					deleting = true;
					this.#clearError();
					try {
						if (await this.onDelete(session)) this.#sessionList.removeSession(session.path);
					} catch (error) {
						this.#showError(error instanceof Error ? error.message : String(error));
					}
				}
				this.removeChild(dialog);
				this.#confirmationDialog = null;
				this.#requestRender();
			},
			() => {
				if (this.#confirmationDialog !== dialog || deleting) return;
				this.removeChild(dialog);
				this.#confirmationDialog = null;
				this.#requestRender();
			},
		);
		this.#confirmationDialog = dialog;
		this.addChild(dialog);
	}
	handleInput(keyData: string): void {
		if (this.#confirmationDialog) this.#confirmationDialog.handleInput(keyData);
		else this.#sessionList.handleInput(keyData);
	}
	getSessionList(): SessionList {
		return this.#sessionList;
	}
}

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
import { formatBytes } from "@gajae-code/utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import type { ResumeSessionIdentity, ResumeTailInspection, SessionInfo } from "../../session/session-manager";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

export interface SelectedSession {
	kind: "selected";
	path: string;
	identity: ResumeSessionIdentity;
	action: "continue-tail" | "open-idle";
}

export interface CancelledSessionSelection {
	kind: "cancelled";
}

export type SessionSelectionResult = SelectedSession | CancelledSessionSelection;
export type SessionInspector = (sessionPath: string) => Promise<ResumeTailInspection>;

type SelectorState =
	| { kind: "browsing" }
	| { kind: "checking"; session: SessionInfo; token: number }
	| { kind: "confirming"; session: SessionInfo; token: number; identity: ResumeSessionIdentity }
	| { kind: "settled" };

class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex = 0;
	readonly #searchInput = new Input();
	#inputFrozen = false;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onDeleteRequest?: (session: SessionInfo) => void;

	constructor(
		private readonly allSessions: SessionInfo[],
		private readonly showCwd = false,
	) {
		this.#filteredSessions = allSessions;
		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) this.onSelect?.(selected);
		};
	}

	setInputFrozen(frozen: boolean): void {
		this.#inputFrozen = frozen;
	}

	#clampSelectedIndex(): void {
		this.#selectedIndex =
			this.#filteredSessions.length === 0
				? 0
				: Math.max(0, Math.min(this.#selectedIndex, this.#filteredSessions.length - 1));
	}

	#filterSessions(query: string): void {
		this.#filteredSessions = fuzzyFilter(this.allSessions, query, session =>
			[
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.allMessagesText,
				session.path,
			]
				.filter(Boolean)
				.join(" "),
		);
		this.#clampSelectedIndex();
	}

	removeSession(sessionPath: string): void {
		const index = this.allSessions.findIndex(session => session.path === sessionPath);
		if (index === -1) return;
		this.allSessions.splice(index, 1);
		this.#filterSessions(this.#searchInput.getValue());
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
			const message = session.firstMessage.replace(/\n/g, " ").trim();
			const title = truncateToWidth(session.title ?? message, width - cursorWidth);
			lines.push(prefix + (selected ? theme.bold(title) : title));
			if (session.title) lines.push(`  ${theme.fg("dim", truncateToWidth(message, width - cursorWidth))}`);
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
		if (matchesKey(keyData, "delete")) {
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

/** A one-shot resume consent selector. It never opens or mutates sessions. */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#messageContainer = new Container();
	#onRequestRender?: () => void;
	#state: SelectorState = { kind: "browsing" };
	#nextToken = 0;

	constructor(
		sessions: SessionInfo[],
		private readonly onSelect: (sessionPath: string) => void,
		private readonly onCancel: () => void,
		private readonly onExit: () => void,
		private readonly onDelete?: (session: SessionInfo) => Promise<boolean>,
		private readonly inspector?: SessionInspector,
		private readonly onSelection?: (selection: SessionSelectionResult) => void,
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		this.#sessionList = new SessionList(sessions);
		this.#sessionList.onSelect = session => {
			if (this.inspector) void this.#inspect(session);
			else this.onSelect(session.path);
		};
		this.#sessionList.onCancel = () => this.#cancel();
		this.#sessionList.onExit = () => this.#exit();
		this.#sessionList.onDeleteRequest = session => this.#showDeleteConfirmation(session);
		this.addChild(this.#sessionList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
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

	#settle(selection: SessionSelectionResult): void {
		if (this.#state.kind === "settled") return;
		this.#state = { kind: "settled" };
		this.#sessionList.setInputFrozen(true);
		const dialog = this.#confirmationDialog;
		this.#confirmationDialog = null;
		if (dialog) this.removeChild(dialog);
		if (this.onSelection) this.onSelection(selection);
		else if (selection.kind === "selected") this.onSelect(selection.path);
		else this.onCancel();
	}
	#cancel(): void {
		if (this.#state.kind === "settled") return;
		if (this.#state.kind === "checking") this.#nextToken++;
		this.#settle({ kind: "cancelled" });
	}
	#exit(): void {
		if (this.#state.kind !== "settled") this.#nextToken++;
		this.#state = { kind: "settled" };
		this.#sessionList.setInputFrozen(true);
		this.onExit();
	}
	async #inspect(session: SessionInfo): Promise<void> {
		const inspector = this.inspector;
		if (!inspector || this.#state.kind !== "browsing") return;
		const token = ++this.#nextToken;
		this.#state = { kind: "checking", session, token };
		this.#sessionList.setInputFrozen(true);
		this.#clearError();
		this.#requestRender();
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
			if (this.#state.kind !== "checking" || this.#state.token !== token) return;
			this.#state = { kind: "browsing" };
			this.#sessionList.setInputFrozen(false);
			this.#showError(error instanceof Error ? error.message : String(error));
			this.#requestRender();
		}
	}
	#showResumeConfirmation(session: SessionInfo, token: number, identity: ResumeSessionIdentity): void {
		this.#state = { kind: "confirming", session, token, identity };
		const dialog = new HookSelectorComponent(
			"Resume this session?",
			["Yes", "No"],
			option => {
				if (this.#confirmationDialog !== dialog || this.#state.kind !== "confirming") return;
				if (option === "Yes")
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
	#showDeleteConfirmation(session: SessionInfo): void {
		if (this.#state.kind !== "browsing" || this.#confirmationDialog) return;
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
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

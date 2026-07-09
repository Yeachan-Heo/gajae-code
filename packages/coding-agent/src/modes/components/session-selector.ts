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
import type { SessionInfo } from "../../session/session-manager";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	readonly #searchInput: Input;
	onSelect?: (sessionPath: string) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	#maxVisible: number = 5; // Max sessions visible (each session is 3 lines: msg + metadata + blank)

	onDeleteRequest?: (session: SessionInfo) => void;

	constructor(
		private readonly allSessions: SessionInfo[],
		private readonly showCwd = false,
	) {
		this.#filteredSessions = allSessions;
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			if (this.#filteredSessions[this.#selectedIndex]) {
				const selected = this.#filteredSessions[this.#selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.path);
				}
			}
		};
	}

	#clampSelectedIndex(): void {
		if (this.#filteredSessions.length === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredSessions.length - 1));
	}

	#filterSessions(query: string): void {
		this.#filteredSessions = fuzzyFilter(this.allSessions, query, session => {
			const parts = [
				session.id,
				session.title ?? "",
				session.cwd ?? "",
				session.firstMessage ?? "",
				session.allMessagesText,
				session.path,
			];
			return parts.filter(Boolean).join(" ");
		});
		this.#clampSelectedIndex();
	}

	removeSession(sessionPath: string): void {
		const index = this.allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.allSessions.splice(index, 1);
		// Re-filter to update filteredSessions
		this.#filterSessions(this.#searchInput.getValue());
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#filteredSessions.length === 0) {
			if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(
				this.#selectedIndex - Math.floor(this.#maxVisible / 2),
				this.#filteredSessions.length - this.#maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#filteredSessions.length);

		// Render visible sessions (2-3 lines per session + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = width - cursorWidth; // Account for cursor width

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				lines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				lines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				lines.push(messageLine);
			}

			// Metadata line: date + file size
			const modified = formatDate(session.modified);
			const metadata = `  ${modified} ${theme.sep.dot} ${formatBytes(session.size)}`;
			const metadataLine = theme.fg("dim", truncateToWidth(metadata, width));

			lines.push(metadataLine);
			lines.push(""); // Blank line between sessions
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.#filteredSessions.length) {
			const scrollText = `  (${this.#selectedIndex + 1}/${this.#filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width));
			lines.push(scrollInfo);
		}

		// Add keybinding hint
		lines.push("");
		lines.push(theme.fg("muted", "  [Del to delete selected transcript/artifacts, Enter to select, Esc to cancel]"));

		return lines;
	}

	handleInput(keyData: string): void {
		const moveSelection = (delta: number): void => {
			if (this.#filteredSessions.length === 0) return;
			this.#selectedIndex += delta;
			this.#clampSelectedIndex();
		};

		// Delete key - request delete confirmation from parent
		if (matchesKey(keyData, "delete")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}

		// Up arrow
		if (matchesKey(keyData, "up")) {
			moveSelection(-1);
			return;
		}
		// Down arrow
		if (matchesKey(keyData, "down")) {
			moveSelection(1);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			moveSelection(-this.#maxVisible);
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			moveSelection(this.#maxVisible);
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.path);
			}
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#messageContainer: Container;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;

	constructor(
		sessions: SessionInfo[],
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		onDelete?: (session: SessionInfo) => Promise<boolean>,
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = onDelete;
		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list
		this.#sessionList = new SessionList(sessions);
		this.#sessionList.onSelect = onSelect;
		this.#sessionList.onCancel = onCancel;
		this.#sessionList.onExit = onExit;
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		this.addChild(this.#sessionList);

		// Add bottom border
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
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete selected session transcript and artifacts?\n${displayName}\nThis cannot be undone. Other sessions and topic/history metadata are not deleted.`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				// Close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
			() => {
				// Cancel - close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
		);
		// Show confirmation dialog
		this.addChild(this.#confirmationDialog);
	}

	handleInput(keyData: string): void {
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}

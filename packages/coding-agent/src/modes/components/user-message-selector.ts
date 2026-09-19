import { type Component, Container, matchesKey, Spacer, Text, truncateToWidth } from "@gajae-code/tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	#selectedIndex: number = 0;
	#selectionInFlight = false;
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	#availableRows = Number.POSITIVE_INFINITY;

	constructor(private readonly messages: UserMessageItem[]) {
		// Store messages in chronological order (oldest to newest)
		// Start with the last (most recent) message selected
		this.#selectedIndex = Math.max(0, this.messages.length - 1);
	}

	setAvailableRows(rows: number): void {
		this.#availableRows = Math.max(3, rows);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// Each entry uses two content rows plus a separator. Leave one row for
		// the scroll position whenever the full history does not fit.
		const needsScrollIndicator = this.messages.length * 3 > this.#availableRows;
		const maxVisible = Math.max(1, Math.floor((this.#availableRows - (needsScrollIndicator ? 1 : 0)) / 3));
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.messages.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.messages.length);

		// Render visible messages (2 lines per message + blank line)
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// Second line: metadata (position in history)
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push(""); // Blank line between messages
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (this.#selectionInFlight) return;
		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (matchesKey(keyData, "up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.messages.length - 1 : this.#selectedIndex - 1;
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (matchesKey(keyData, "down")) {
			this.#selectedIndex = this.#selectedIndex === this.messages.length - 1 ? 0 : this.#selectedIndex + 1;
		}
		// Enter - select message and branch
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.messages[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.#selectionInFlight = true;
				this.onSelect(selected.id);
			}
		}
		// Escape / cancel
		else if (matchesSelectCancel(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * Component that renders a prompt selector for creating a new session
 */
export class UserMessageSelectorComponent extends Container {
	#messageList: UserMessageList;
	#header: Container;
	#footer: Container;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		private readonly getViewportRows: () => number,
	) {
		super();

		// Add header
		this.#header = new Container();
		this.#header.addChild(new Spacer(1));
		this.#header.addChild(new Text(theme.bold("Fork from Prompt"), 1, 0));
		this.#header.addChild(
			new Text(
				theme.fg(
					"muted",
					"Creates a new session with history before the prompt; shared files stay in the same cwd.",
				),
				1,
				0,
			),
		);
		this.#header.addChild(
			new Text(theme.fg("muted", "The selected prompt is restored for editing, not submitted."), 1, 0),
		);
		this.#header.addChild(new Text(theme.fg("muted", "↑/↓ move · Enter select · Esc cancel"), 1, 0));
		this.#header.addChild(new Spacer(1));
		this.#header.addChild(new DynamicBorder());
		this.#header.addChild(new Spacer(1));
		this.addChild(this.#header);

		// Create message list
		this.#messageList = new UserMessageList(messages);
		this.#messageList.onSelect = onSelect;
		this.#messageList.onCancel = onCancel;

		this.addChild(this.#messageList);

		// Add bottom border
		this.#footer = new Container();
		this.#footer.addChild(new Spacer(1));
		this.#footer.addChild(new DynamicBorder());
		this.addChild(this.#footer);

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	render(width: number): string[] {
		const chromeRows = this.#header.render(width).length + this.#footer.render(width).length;
		// Reserve the pinned status/composer rows outside the overlay. Recompute
		// against current terminal rows and wrapped header height on every render.
		this.#messageList.setAvailableRows(this.getViewportRows() - chromeRows - 2);
		return super.render(width);
	}

	getMessageList(): UserMessageList {
		return this.#messageList;
	}
}

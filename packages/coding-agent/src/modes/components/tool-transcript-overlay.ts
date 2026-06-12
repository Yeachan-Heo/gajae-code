import { Container, matchesKey } from "@gajae-code/tui";
import { theme } from "../theme/theme";
import { ToolExecutionComponent } from "./tool-execution";

/**
 * 083.1 pattern A — full tool transcript overlay (Codex pager analogue).
 * Renders every tool block fully expanded in a scrollable viewport, regardless
 * of minimize/preview state in the chat. Tools live in the chat container for
 * the whole session, so no pendingTools lifecycle change is needed.
 */
export class ToolTranscriptOverlayComponent extends Container {
	#tools: ToolExecutionComponent[];
	#close: () => void;
	#requestRender: () => void;
	#scroll = 0;
	#cache?: { width: number; lines: string[] };

	constructor(tools: ToolExecutionComponent[], callbacks: { close: () => void; requestRender: () => void }) {
		super();
		this.#tools = tools;
		this.#close = callbacks.close;
		this.#requestRender = callbacks.requestRender;
	}

	getFocus(): ToolTranscriptOverlayComponent {
		return this;
	}

	#viewportRows(): number {
		return Math.max(8, (process.stdout.rows ?? 30) - 8);
	}

	#transcriptLines(width: number): string[] {
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines: string[] = [];
		for (const tool of this.#tools) {
			const wasExpanded = tool.expanded;
			if (!wasExpanded) tool.setExpanded(true);
			lines.push(...tool.render(width));
			if (!wasExpanded) tool.setExpanded(false);
		}
		// Drop the leading separator blank so the pager starts at content.
		while (lines.length > 0 && lines[0] === "") lines.shift();
		this.#cache = { width, lines };
		return lines;
	}

	handleInput(data: string): void {
		const rows = this.#viewportRows();
		const total = this.#cache?.lines.length ?? 0;
		const maxScroll = Math.max(0, total - rows);
		if (matchesKey(data, "escape") || data === "q") {
			this.#close();
			return;
		}
		if (matchesKey(data, "up")) this.#scroll = Math.max(0, this.#scroll - 1);
		else if (matchesKey(data, "down")) this.#scroll = Math.min(maxScroll, this.#scroll + 1);
		else if (matchesKey(data, "pageUp")) this.#scroll = Math.max(0, this.#scroll - rows);
		else if (matchesKey(data, "pageDown")) this.#scroll = Math.min(maxScroll, this.#scroll + rows);
		else if (data === "g") this.#scroll = 0;
		else if (data === "G") this.#scroll = maxScroll;
		else return;
		this.#requestRender();
	}

	override render(width: number): string[] {
		const lines = this.#transcriptLines(width);
		const rows = this.#viewportRows();
		const maxScroll = Math.max(0, lines.length - rows);
		this.#scroll = Math.min(this.#scroll, maxScroll);
		const out: string[] = [];
		const position = lines.length === 0 ? "empty" : `${this.#scroll + 1}–${Math.min(this.#scroll + rows, lines.length)}/${lines.length}`;
		out.push(theme.fg("accent", ` Tool transcript (${this.#tools.length} tools, ${position})`));
		out.push(...lines.slice(this.#scroll, this.#scroll + rows));
		out.push(theme.fg("dim", " ↑↓ scroll · pgup/pgdn page · g/G top/bottom · esc close"));
		return out;
	}
}

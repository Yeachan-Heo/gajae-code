import { Box, Markdown, Spacer, Text } from "@gajae-code/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CompactionSummaryMessage } from "../../session/messages";
import type { ExpandHintCapability } from "../../tools/render-utils";
import { expandHintSuffix } from "../../tools/render-utils";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as hook messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	#expanded = false;

	constructor(
		private readonly message: CompactionSummaryMessage,
		private readonly expandHintCapability?: ExpandHintCapability,
	) {
		super(1, 1, t => theme.bg("customMessageBg", t));
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", theme.bold("[compaction]"));
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.#expanded) {
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild({
				render: () => [
					theme.fg(
						"customMessageText",
						`Compacted from ${tokenStr} tokens${expandHintSuffix(theme, this.expandHintCapability!)}`,
					),
				],
				invalidate: () => {},
			});
			if (this.message.shortSummary) {
				this.addChild(new Text(theme.fg("customMessageText", this.message.shortSummary), 0, 1));
			}
		}
	}
}

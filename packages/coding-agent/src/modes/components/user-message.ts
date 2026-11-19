import { Container, Markdown, Spacer, Text, type ViewportAnchorSource } from "@gajae-code/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	#viewportAnchorSource?: ViewportAnchorSource;

	constructor(text: string, synthetic = false, viewportAnchorId?: string) {
		super();
		if (viewportAnchorId) this.#viewportAnchorSource = { id: viewportAnchorId };
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		this.addChild(new Spacer(1));
		const label = synthetic ? "replay" : "user";
		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 1, 0));
		const prompt = new Markdown(text, 1, 1, getMarkdownTheme(), { bgColor, color });
		this.addChild(prompt);
		if (this.#viewportAnchorSource) this.setViewportAnchorSource(prompt, this.#viewportAnchorSource);
	}
}

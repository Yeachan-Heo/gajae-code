/**
 * Shared rendering for extension/hook custom message frames.
 *
 * Both `CustomMessageComponent` and `HookMessageComponent` wrap a
 * `Spacer(1) + Box` layout, try a user-supplied renderer first, and fall
 * back to a label + markdown body when the renderer returns nothing or
 * throws. The only meaningful difference is that hook messages collapse to
 * the first N lines when not expanded; extension messages render in full.
 */

import type { TextContent } from "@gajae-code/ai/core";
import type { Box, Component } from "@gajae-code/tui";
import { Markdown, Spacer, Text } from "@gajae-code/tui";
import { getMarkdownTheme, type Theme, theme } from "../../modes/theme/theme";

/** Message shape consumed by the shared frame. */
export interface FramedMessage {
	customType: string;
	content: string | (TextContent | { type: string })[];
}

/**
 * Callable signature shared by `MessageRenderer` (extensions) and
 * `HookMessageRenderer` (hooks). Both narrow `message` to their own type;
 * this signature is the structural intersection callers can hand off here.
 */
export type FramedRenderer<M extends FramedMessage> = (
	message: M,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

export interface RebuildFrameOptions<M extends FramedMessage> {
	message: M;
	box: Box;
	expanded: boolean;
	/** Collapse the markdown body to this many lines when `expanded` is false. Omit to never collapse. */
	collapseAfterLines?: number;
	customRenderer?: FramedRenderer<M>;
}

/**
 * Attempt the custom renderer; on failure or undefined return, populate
 * `box` with the default `[customType]` label + markdown body and return
 * undefined. When the custom renderer succeeds, return its Component so the
 * caller can mount it and skip the default box.
 */
export function renderFramedMessage<M extends FramedMessage>(opts: RebuildFrameOptions<M>): Component | undefined {
	if (opts.customRenderer) {
		try {
			const component = opts.customRenderer(opts.message, { expanded: opts.expanded }, theme);
			if (component) return component;
		} catch {
			// Fall through to default rendering
		}
	}

	opts.box.clear();

	const label = theme.fg("customMessageLabel", theme.bold(`[${opts.message.customType}]`));
	opts.box.addChild(new Text(label, 0, 0));
	opts.box.addChild(new Spacer(1));

	let text: string;
	if (typeof opts.message.content === "string") {
		text = opts.message.content;
	} else {
		text = opts.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}

	if (!opts.expanded && opts.collapseAfterLines !== undefined) {
		const lines = text.split("\n");
		if (lines.length > opts.collapseAfterLines) {
			text = `${lines.slice(0, opts.collapseAfterLines).join("\n")}\n…`;
		}
	}

	opts.box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);

	return undefined;
}

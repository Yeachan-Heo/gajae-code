import type { TextContent } from "@gajae-code/ai";
import type { Component } from "@gajae-code/tui";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth } from "@gajae-code/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";

export class SkillMessageComponent extends Container {
	#box: Box;
	#contentComponent?: Component;
	#expanded = false;

	constructor(private readonly message: CustomMessage<SkillPromptDetails>) {
		super();
		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#contentComponent) {
			this.removeChild(this.#contentComponent);
			this.#contentComponent = undefined;
		}

		this.removeChild(this.#box);
		this.addChild(this.#box);
		this.#box.clear();

		const details = this.message.details;
		const name = details?.name ?? "unknown";
		const args = details?.args?.trim();

		// Single compact line: `[skill] <name>: <args>`. The summary is the
		// args the user typed; with none, just `[skill] <name>`. Collapsed to
		// one line — path / line-count / full prompt body are debugging detail
		// and only render once expanded.
		const summary = args ? truncateToWidth(args.replace(/\s+/g, " "), 72) : undefined;
		const header = `${theme.fg("customMessageLabel", theme.bold("[skill]"))} ${theme.fg("customMessageText", name)}`;
		const headerText = summary ? `${header}${theme.fg("customMessageText", `: ${summary}`)}` : header;
		this.#box.addChild(new Text(headerText, 0, 0));

		if (!this.#expanded) {
			return;
		}

		const detailLines = [
			details?.path ? `Path: ${details.path}` : undefined,
			typeof details?.lineCount === "number" ? `Prompt: ${details.lineCount} lines` : undefined,
		].filter((line): line is string => Boolean(line));

		if (detailLines.length > 0) {
			this.#box.addChild(new Spacer(1));
			this.#box.addChild(
				new Markdown(detailLines.join("\n"), 0, 0, getMarkdownTheme(), {
					color: (value: string) => theme.fg("customMessageText", value),
				}),
			);
		}

		const text = this.#extractText();
		if (!text) {
			return;
		}

		this.#box.addChild(new Spacer(1));
		const promptHeader = theme.fg("customMessageLabel", theme.bold("Prompt"));
		this.#box.addChild(new Text(promptHeader, 0, 0));
		this.#box.addChild(new Spacer(1));

		this.#contentComponent = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		});
		this.#box.addChild(this.#contentComponent);
	}

	#extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
}

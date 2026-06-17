import type { TextContent } from "@gajae-code/ai";
import type { Component } from "@gajae-code/tui";
import {
	Box,
	Container,
	Markdown,
	replaceTabs,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";

const COLLAPSED_ARGS_PREVIEW_WIDTH = 96;
const COLLAPSED_ARGS_PREVIEW_LINES = 6;
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

		// Collapsed view keeps args readable without exposing the full prompt body.
		// Each visual line is bounded, but multi-line arguments remain multi-line so
		// the invocation context is not mistaken for a one-line truncated payload.
		const argsPreview = args ? this.#formatArgsPreview(args) : [];
		const header = `${theme.fg("customMessageLabel", theme.bold("[skill]"))} ${theme.fg("customMessageText", name)}`;
		this.#box.addChild(new Text(header, 0, 0));
		if (argsPreview.length > 0) {
			this.#box.addChild(new Spacer(1));
			this.#box.addChild(new Text(argsPreview.map(line => theme.fg("customMessageText", line)).join("\n"), 0, 0));
		}

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

		if (args) {
			this.#box.addChild(new Spacer(1));
			const argsHeader = theme.fg("customMessageLabel", theme.bold("Arguments"));
			this.#box.addChild(new Text(argsHeader, 0, 0));
			this.#box.addChild(new Spacer(1));
			this.#box.addChild(
				new Markdown(replaceTabs(args), 0, 0, getMarkdownTheme(), {
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

	#formatArgsPreview(args: string): string[] {
		const preview: string[] = [];
		let omitted = false;
		const sourceLines = replaceTabs(args).split(/\r?\n/);
		for (let index = 0; index < sourceLines.length; index += 1) {
			const sourceLine = sourceLines[index]?.trimEnd() ?? "";
			const wrapped = wrapTextWithAnsi(sourceLine.length > 0 ? sourceLine : " ", COLLAPSED_ARGS_PREVIEW_WIDTH);
			for (const line of wrapped.length > 0 ? wrapped : [""]) {
				if (preview.length >= COLLAPSED_ARGS_PREVIEW_LINES) {
					omitted = true;
					break;
				}
				preview.push(truncateToWidth(line, COLLAPSED_ARGS_PREVIEW_WIDTH));
			}
			if (omitted) break;
		}
		if (sourceLines.length > 0 && preview.length === COLLAPSED_ARGS_PREVIEW_LINES) {
			const visibleSource = preview.join("\n");
			omitted ||= replaceTabs(args).trimEnd().length > visibleSource.trimEnd().length;
		}
		if (omitted && preview.length > 0) {
			preview[preview.length - 1] = truncateToWidth(
				`${preview[preview.length - 1]} …`,
				COLLAPSED_ARGS_PREVIEW_WIDTH,
			);
		}
		return preview;
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

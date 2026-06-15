import type { AssistantMessage, ImageContent, Usage } from "@gajae-code/ai";
import { type Component, Container, Image, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import { settings } from "../../config/settings";
import { renderDeepInterviewAssistantText } from "../../deep-interview/render-middleware";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { isSilentAbort } from "../../session/messages";
import { resolveImageOptions } from "../../tools/render-utils";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#responseHeader = new Text(theme.bold(theme.fg("statusLineModel", "gajae")), 1, 0);
	#contentBlocksCache = new WeakMap<object, { source: string; component: Component }>();

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage);
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#renderTextBlock(content: { text: string }): Component {
		const cached = this.#contentBlocksCache.get(content);
		if (cached?.source === content.text) return cached.component;
		const trimmed = content.text.trim();
		const deepInterview = renderDeepInterviewAssistantText(trimmed, theme);
		// Reuse the same Markdown instance across streaming chunks (update text in place)
		// instead of constructing a new one each chunk; combined with the markdown
		// per-code-block highlight cache, appends no longer re-highlight the whole prefix.
		if (!deepInterview && cached && cached.component instanceof Markdown) {
			cached.component.setText(trimmed);
			cached.source = content.text;
			return cached.component;
		}
		const component = deepInterview ?? new Markdown(trimmed, 1, 0, getMarkdownTheme());
		this.#contentBlocksCache.set(content, { source: content.text, component });
		return component;
	}

	#renderThinkingBlock(content: { thinking: string }): Markdown {
		const cached = this.#contentBlocksCache.get(content);
		if (cached?.source === content.thinking) return cached.component as Markdown;
		const trimmed = content.thinking.trim();
		const component = new Markdown(trimmed, 1, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("thinkingText", text),
			italic: true,
		});
		this.#contentBlocksCache.set(content, { source: content.thinking, component });
		return component;
	}

	#renderToolImages(): void {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of imageEntries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						resolveImageOptions(),
					),
				);
				continue;
			}
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;

		// Clear content container
		this.#contentContainer.clear();

		const hasVisibleContent = message.content.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(this.#responseHeader);
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				this.#contentContainer.addChild(this.#renderTextBlock(content));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.#contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				} else {
					this.#contentContainer.addChild(this.#renderThinkingBlock(content));
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		this.#renderToolImages();
		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted" && !isSilentAbort(message.errorMessage)) {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.#contentContainer.addChild(new Spacer(1));
				} else {
					this.#contentContainer.addChild(new Spacer(1));
				}
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
		if (
			message.errorMessage &&
			!isSilentAbort(message.errorMessage) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${message.errorMessage}`), 1, 0));
		}

		// Token usage metadata
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
		}
	}
}

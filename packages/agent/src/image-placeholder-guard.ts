import type { ImageContent, TextContent } from "@gajae-code/ai";

export const IMAGE_PLACEHOLDER_ATTACHMENT_GUIDANCE =
	"Image placeholder text was submitted without an image payload. Paste the image with #paste-image, attach it with @path/to/image.png, or save the image and provide the saved file path.";

const IMAGE_PLACEHOLDER_ONLY_PATTERN = /^\s*(?:\[image\s+\d+\]\s*)+$/i;

export function isImagePlaceholderOnlyText(text: string): boolean {
	return IMAGE_PLACEHOLDER_ONLY_PATTERN.test(text);
}

export function assertImagePlaceholdersHavePayload(
	text: string,
	content: readonly (TextContent | ImageContent)[] | undefined,
): void {
	if (!isImagePlaceholderOnlyText(text)) return;
	const hasImagePayload = content?.some(part => part.type === "image") ?? false;
	if (hasImagePayload) return;
	throw new Error(IMAGE_PLACEHOLDER_ATTACHMENT_GUIDANCE);
}

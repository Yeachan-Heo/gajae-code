import type { TurnPromptInput } from "@gajae-code/coding-agent/sdk";

const prompts: TurnPromptInput[] = [
	{ text: "text", clientRef: "text-request" },
	{ text: "caption", images: [{ data: "aA==", mimeType: "image/png" }] },
	{ text: "", stagedImages: [{ id: "finished-upload" }] },
];

// @ts-expect-error Direct and staged image inputs are mutually exclusive.
const mixed: TurnPromptInput = { text: "", images: [], stagedImages: [{ id: "finished-upload" }] };

// @ts-expect-error A staged image descriptor requires its upload ID.
const missingId: TurnPromptInput = { text: "", stagedImages: [{}] };

// @ts-expect-error Upload IDs are strings, not numeric image positions.
const numericId: TurnPromptInput = { text: "", stagedImages: [{ id: 1 }] };

void [prompts, mixed, missingId, numericId];

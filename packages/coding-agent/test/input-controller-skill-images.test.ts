/**
 * `/skill:<name> ... [image N]` must deliver the pasted image with the skill prompt.
 *
 * The skill dispatcher builds a custom message from the text, so images pasted
 * into the composer used to be dropped and the model answered that the attached
 * image was not visible. The same bare placeholder was resubmitted when a restored
 * queued message was sent again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { TempDir } from "@gajae-code/utils";

const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const OTHER_IMAGE = { type: "image" as const, data: "BBBB", mimeType: "image/png" };

type PendingImages = InteractiveModeContext["pendingImages"];

function createContext(opts: { skillCommands: Map<string, Skill>; pendingImages: PendingImages; streaming?: boolean }) {
	const customMessages: { content: unknown }[] = [];
	const prompts: { text: string; options: { images?: PendingImages } | undefined }[] = [];
	const followUps: { text: string; images: PendingImages | undefined }[] = [];
	const showWarning = vi.fn();

	// The real editor reports onChange("") when its buffer is emptied, which defers
	// a pendingImages reset to a microtask. A controller that reads the images
	// after an await would find them already gone.
	const editor = {
		setText(text: string) {
			if (text.length > 0) return;
			const images = ctx.pendingImages;
			queueMicrotask(() => {
				if (ctx.pendingImages === images) ctx.pendingImages = [];
			});
		},
		getText: () => "",
		addToHistory: vi.fn(),
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
	};

	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		skillCommands: opts.skillCommands,
		session: {
			sessionId: "stub-session",
			isStreaming: opts.streaming ?? false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			enqueueCustomMessageDisplay: vi.fn(() => "sk-test-0"),
			sendCustomMessage: vi.fn(async (message: { content: unknown }) => {
				customMessages.push({ content: message.content });
			}),
			promptCustomMessage: vi.fn(async (message: { content: unknown }) => {
				customMessages.push({ content: message.content });
			}),
			prompt: vi.fn(async (text: string, options?: { images?: PendingImages }) => {
				prompts.push({ text, options });
			}),
			followUp: vi.fn(async (text: string, images?: PendingImages) => {
				followUps.push({ text, images });
			}),
		},
		settings: { get: () => undefined },
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => "named" },
		showError: vi.fn(),
		showWarning,
		showStatus: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		pendingImages: opts.pendingImages,
		isBackgrounded: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		hasActiveBtw: () => false,
	} as unknown as InteractiveModeContext;

	return { ctx, editor, customMessages, prompts, followUps, showWarning };
}

function imageBlocks(content: unknown): unknown[] {
	return Array.isArray(content) ? content.filter((part: { type: string }) => part.type === "image") : [];
}

describe("InputController skill command images", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-skill-images-");
		const skillPath = path.join(tempDir.path(), "test-skill.md");
		fs.writeFileSync(skillPath, "---\nname: test-skill\n---\nDo the thing.\n");
		const skill: Skill = {
			name: "test-skill",
			description: "Test skill",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		};
		skillCommands = new Map<string, Skill>([
			["skill:test-skill", skill],
			["test-skill", skill],
		]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function submit(text: string, pendingImages: PendingImages, streaming = false) {
		const stub = createContext({ skillCommands, pendingImages, streaming });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.(text);
		return stub;
	}

	it("sends the pasted image with the skill prompt", async () => {
		const { customMessages, ctx } = await submit("/skill:test-skill look at [image 1]", [IMAGE]);

		expect(customMessages).toHaveLength(1);
		expect(imageBlocks(customMessages[0]?.content)).toEqual([IMAGE]);
		expect(ctx.pendingImages).toEqual([]);
	});

	it("sends only the images the skill args reference", async () => {
		const { customMessages } = await submit("/skill:test-skill use [image 2]", [IMAGE, OTHER_IMAGE]);

		expect(imageBlocks(customMessages[0]?.content)).toEqual([OTHER_IMAGE]);
	});

	it("keeps a text-only skill command a plain string", async () => {
		const { customMessages } = await submit("/skill:test-skill no picture", []);

		expect(typeof customMessages[0]?.content).toBe("string");
	});

	it("carries the image while the agent is streaming", async () => {
		const { customMessages } = await submit("/skill:test-skill look at [image 1]", [IMAGE], true);

		expect(imageBlocks(customMessages[0]?.content)).toEqual([IMAGE]);
	});

	it("refuses a skill command whose placeholder has no payload", async () => {
		const { customMessages, prompts, showWarning } = await submit("/skill:test-skill look at [image 1]", []);

		expect(customMessages).toHaveLength(0);
		expect(prompts).toHaveLength(0);
		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(String(showWarning.mock.calls[0]?.[0])).toContain("[image 1]");
	});

	it("refuses a plain prompt whose placeholder has no payload", async () => {
		const { prompts, showWarning } = await submit("is this fixed? [image 1]", []);

		expect(prompts).toHaveLength(0);
		expect(showWarning).toHaveBeenCalledTimes(1);
	});

	it("passes the pasted image through the queued follow-up shortcut", async () => {
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], streaming: true });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "look at [image 1]";
		stub.editor.setText("");
		await controller.handleFollowUp();

		const sent = stub.prompts[0];
		expect(sent?.options?.images).toEqual([IMAGE]);
	});
});

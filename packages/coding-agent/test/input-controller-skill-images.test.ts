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
import { CustomEditor } from "@gajae-code/coding-agent/modes/components/custom-editor";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { TempDir } from "@gajae-code/utils";
import { defaultEditorTheme } from "../../tui/test/test-themes";

const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const OTHER_IMAGE = { type: "image" as const, data: "BBBB", mimeType: "image/png" };

type PendingImages = InteractiveModeContext["pendingImages"];

function createContext(opts: {
	skillCommands: Map<string, Skill>;
	pendingImages: PendingImages;
	streaming?: boolean;
	realEditor?: boolean;
	extensionRunner?: unknown;
	compacting?: boolean;
	activeBtw?: boolean;
}) {
	const customMessages: { content: unknown }[] = [];
	const prompts: { text: string; options: { images?: PendingImages } | undefined }[] = [];
	const followUps: { text: string; images: PendingImages | undefined }[] = [];
	const showWarning = vi.fn();

	// The real editor reports onChange("") when its buffer is emptied, which defers
	// a pendingImages reset to a microtask. A controller that reads the images
	// after an await would find them already gone.
	const stubEditor = {
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
	const editor = opts.realEditor ? new CustomEditor(defaultEditorTheme) : stubEditor;

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() },
		skillCommands: opts.skillCommands,
		session: {
			sessionId: "stub-session",
			isStreaming: opts.streaming ?? false,
			isCompacting: opts.compacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: opts.extensionRunner,
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
		hasActiveBtw: () => opts.activeBtw ?? false,
		handleBtwFollowUp: vi.fn(async () => "accepted" as const),
		queueCompactionMessage: vi.fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor: editor as typeof stubEditor, customMessages, prompts, followUps, showWarning };
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

	it("sends the images an input extension substituted, not the originals", async () => {
		const redacted = { ...IMAGE, data: "REDACTED" };
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ images: [redacted] })),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], extensionRunner });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.("/skill:test-skill look at [image 1]");

		expect(imageBlocks(stub.customMessages[0]?.content)).toEqual([redacted]);
	});

	it("keeps the draft in the composer when the real editor submits an unattached placeholder", async () => {
		const stub = createContext({ skillCommands, pendingImages: [], realEditor: true });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		const draft = "/skill:test-skill look at [image 1]";
		stub.ctx.editor.setText(draft);
		stub.ctx.editor.handleInput("\r");
		await Bun.sleep(20);

		expect(stub.customMessages).toHaveLength(0);
		expect(stub.showWarning).toHaveBeenCalledTimes(1);
		expect(stub.ctx.editor.getText()).toBe(draft);
	});

	it("rejects an unattached placeholder before queueing it during compaction", async () => {
		const stub = createContext({ skillCommands, pendingImages: [], compacting: true });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "/skill:test-skill look at [image 1]";
		await controller.handleFollowUp();

		expect(stub.ctx.queueCompactionMessage).not.toHaveBeenCalled();
		expect(stub.showWarning).toHaveBeenCalledTimes(1);
	});

	it("rejects an unattached placeholder before forwarding it to an active /btw", async () => {
		const stub = createContext({ skillCommands, pendingImages: [], activeBtw: true });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.("look at [image 1]");

		expect(stub.ctx.handleBtwFollowUp).not.toHaveBeenCalled();
		expect(stub.showWarning).toHaveBeenCalledTimes(1);
	});

	it("does not overwrite a newer draft when a rejected submission restores its text", async () => {
		const stub = createContext({ skillCommands, pendingImages: [], realEditor: true });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		stub.ctx.editor.setText("/skill:test-skill look at [image 1]");
		const submit = stub.ctx.editor.onSubmit?.("/skill:test-skill look at [image 1]");
		stub.ctx.editor.setText("newer draft");
		await submit;

		expect(stub.ctx.editor.getText()).toBe("newer draft");
	});

	it("applies an image-only extension replacement through the real runner", async () => {
		const { ExtensionRunner } = await import("@gajae-code/coding-agent/extensibility/extensions/runner");
		const { ExtensionRuntime } = await import("@gajae-code/coding-agent/extensibility/extensions/loader");
		const { SessionManager } = await import("@gajae-code/coding-agent/session/session-manager");
		const redacted = { ...IMAGE, data: "REDACTED" };
		const extension = {
			path: "image-only-extension",
			resolvedPath: "image-only-extension",
			label: "image-only-extension",
			handlers: new Map([["input", [async () => ({ images: [redacted] })]]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			functionHooks: new Map(),
		};
		const runner = new ExtensionRunner(
			[extension as never],
			new ExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			{} as never,
		);

		const result = await runner.emitInput("look at [image 1]", [IMAGE], "interactive");
		expect(result.images).toEqual([redacted]);
	});

	it("does not let a text-only extension rewrite pull in an unselected pending image", async () => {
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ text: "/skill:test-skill use [image 2]" })),
		};
		const stub = createContext({
			skillCommands,
			pendingImages: [IMAGE, OTHER_IMAGE],
			extensionRunner,
		});
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.("/skill:test-skill use [image 1]");

		const sentImages = stub.customMessages.flatMap(message => imageBlocks(message.content));
		expect(sentImages).not.toContainEqual(OTHER_IMAGE);
	});

	it("keeps the selected image when a text-only extension rewrite still names it", async () => {
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ text: "/skill:test-skill rewritten [image 1]" })),
		};
		const stub = createContext({
			skillCommands,
			pendingImages: [IMAGE, OTHER_IMAGE],
			extensionRunner,
		});
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.("/skill:test-skill use [image 1]");

		const sentImages = stub.customMessages.flatMap(message => imageBlocks(message.content));
		expect(sentImages).toEqual([IMAGE]);
	});

	it("does not read a placeholder inside a source path as an image reference", async () => {
		const stub = createContext({ skillCommands, pendingImages: [IMAGE] });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => 'describe [image 1] source="/tmp/[image 2].png"';
		await controller.handleFollowUp();

		expect(stub.showWarning).not.toHaveBeenCalled();
		expect(stub.prompts[0]?.options?.images).toEqual([IMAGE]);
	});

	it("runs input extensions on the queued follow-up shortcut and sends the replacement", async () => {
		const redacted = { ...IMAGE, data: "REDACTED" };
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ images: [redacted] })),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], streaming: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "look at [image 1]";
		await controller.handleFollowUp();

		expect(extensionRunner.emitInput).toHaveBeenCalledTimes(1);
		expect(stub.prompts[0]?.options?.images).toEqual([redacted]);
	});

	it("sends the replacement image with a skill command on the follow-up shortcut", async () => {
		const redacted = { ...IMAGE, data: "REDACTED" };
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ images: [redacted] })),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], streaming: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "/skill:test-skill look at [image 1]";
		await controller.handleFollowUp();

		expect(imageBlocks(stub.customMessages[0]?.content)).toEqual([redacted]);
	});

	it("rejects an attached image for an active /btw instead of sending only its placeholder", async () => {
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], activeBtw: true });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "look at [image 1]";
		await controller.handleFollowUp();

		expect(stub.ctx.handleBtwFollowUp).not.toHaveBeenCalled();
		expect(stub.showWarning).toHaveBeenCalledTimes(1);
	});

	it("keeps a newer draft and image when an input extension is slow on the follow-up shortcut", async () => {
		const release = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				return {};
			}),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], realEditor: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("older [image 1]");
		const submitted = controller.handleFollowUp();
		const newerImage = { ...IMAGE, data: "NEWER" };
		stub.ctx.pendingImages = [...stub.ctx.pendingImages, newerImage];
		stub.ctx.editor.setText("newer draft [image 2]");
		release.resolve();
		await submitted;

		expect(stub.ctx.editor.getText()).toBe("newer draft [image 2]");
		expect(stub.ctx.pendingImages).toContainEqual(newerImage);
	});

	it("keeps a newer draft when a slow extension precedes a queued skill command", async () => {
		const release = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				return {};
			}),
		};
		const stub = createContext({
			skillCommands,
			pendingImages: [IMAGE],
			streaming: true,
			realEditor: true,
			extensionRunner,
		});
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("/skill:test-skill look at [image 1]");
		const submitted = controller.handleFollowUp();
		stub.ctx.editor.setText("newer draft");
		release.resolve();
		await submitted;

		expect(stub.ctx.editor.getText()).toBe("newer draft");
		expect(imageBlocks(stub.customMessages[0]?.content)).toEqual([IMAGE]);
	});

	it("still reads a placeholder in an unrelated attribute such as resource=", async () => {
		const stub = createContext({ skillCommands, pendingImages: [], realEditor: true });
		const controller = new InputController(stub.ctx);
		controller.setupEditorSubmitHandler();
		await stub.editor.onSubmit?.('look at resource="[image 1]"');

		expect(stub.prompts).toHaveLength(0);
		expect(stub.showWarning).toHaveBeenCalledTimes(1);
	});

	it("does not bind a restored skill placeholder to a newer pending image", async () => {
		const stub = createContext({ skillCommands, pendingImages: [OTHER_IMAGE], realEditor: true });
		stub.ctx.compactionQueuedMessages = [{ text: "/skill:test-skill look at [image 1]", mode: "followUp" }];
		const controller = new InputController(stub.ctx);

		expect(controller.restoreLatestQueuedMessageToEditor()).toBe(1);
		expect(stub.ctx.editor.getText()).toBe("/skill:test-skill look at [image 1]");
		expect(stub.ctx.pendingImages).toEqual([]);
		expect(stub.showWarning).toHaveBeenCalledTimes(1);

		await controller.handleFollowUp();
		expect(stub.customMessages).toHaveLength(0);
	});

	it("keeps pending images when the restored message names none", () => {
		const stub = createContext({ skillCommands, pendingImages: [OTHER_IMAGE], realEditor: true });
		stub.ctx.compactionQueuedMessages = [{ text: "plain text", mode: "followUp" }];
		const controller = new InputController(stub.ctx);

		controller.restoreLatestQueuedMessageToEditor();
		expect(stub.ctx.pendingImages).toEqual([OTHER_IMAGE]);
		expect(stub.showWarning).not.toHaveBeenCalled();
	});

	it("keeps the composer when the same placeholder is retyped over a swapped image during a slow extension", async () => {
		const release = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				return {};
			}),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], realEditor: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("look at [image 1]");
		const submitted = controller.handleFollowUp();
		stub.ctx.pendingImages = [OTHER_IMAGE];
		stub.ctx.editor.setText("look at [image 1]");
		release.resolve();
		await submitted;

		expect(stub.ctx.editor.getText()).toBe("look at [image 1]");
		expect(stub.ctx.pendingImages).toEqual([OTHER_IMAGE]);
	});

	it("keeps the composer when the skill path runs after a swapped image during a slow extension", async () => {
		const release = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				return {};
			}),
		};
		const stub = createContext({ skillCommands, pendingImages: [IMAGE], realEditor: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("/skill:test-skill look at [image 1]");
		const submitted = controller.handleFollowUp();
		stub.ctx.pendingImages = [OTHER_IMAGE];
		release.resolve();
		await submitted;

		expect(stub.ctx.editor.getText()).toBe("/skill:test-skill look at [image 1]");
		expect(stub.ctx.pendingImages).toEqual([OTHER_IMAGE]);
	});

	it("queues the extension-rewritten text when Alt+Enter runs during compaction", async () => {
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ text: "rewritten by extension" })),
		};
		const stub = createContext({ skillCommands, pendingImages: [], compacting: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "original";
		await controller.handleFollowUp();

		expect(extensionRunner.emitInput).toHaveBeenCalledTimes(1);
		expect(stub.ctx.queueCompactionMessage).toHaveBeenCalledTimes(1);
		const queueCall = (stub.ctx.queueCompactionMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(queueCall?.[0]).toBe("rewritten by extension");
	});

	it("does not queue input an extension handled when Alt+Enter runs during compaction", async () => {
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => ({ handled: true })),
		};
		const stub = createContext({ skillCommands, pendingImages: [], compacting: true, extensionRunner });
		stub.ctx.addMessageToChat = vi.fn();
		const controller = new InputController(stub.ctx);
		stub.editor.getText = () => "original";
		await controller.handleFollowUp();

		expect(stub.ctx.queueCompactionMessage).not.toHaveBeenCalled();
	});

	it("keeps an image-bearing draft when compaction starts during a slow input extension", async () => {
		const release = Promise.withResolvers<void>();
		let stub: ReturnType<typeof createContext> | undefined;
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				(stub?.ctx.session as unknown as { isCompacting: boolean }).isCompacting = true;
				return {};
			}),
		};
		stub = createContext({ skillCommands, pendingImages: [IMAGE], realEditor: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("/skill:test-skill look at [image 1]");
		const submitted = controller.handleFollowUp();
		release.resolve();
		await submitted;

		expect(stub.ctx.queueCompactionMessage).not.toHaveBeenCalled();
		expect(stub.ctx.editor.getText()).toBe("/skill:test-skill look at [image 1]");
		expect(stub.ctx.pendingImages).toEqual([IMAGE]);
		expect(stub.ctx.showStatus).toHaveBeenCalledWith(
			"Compaction in progress. Retry after it completes to send images.",
		);
	});

	it("still queues a text-only draft when compaction starts during a slow input extension", async () => {
		const release = Promise.withResolvers<void>();
		let stub: ReturnType<typeof createContext> | undefined;
		const extensionRunner = {
			hasHandlers: (event: string) => event === "input",
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				await release.promise;
				(stub?.ctx.session as unknown as { isCompacting: boolean }).isCompacting = true;
				return {};
			}),
		};
		stub = createContext({ skillCommands, pendingImages: [], realEditor: true, extensionRunner });
		const controller = new InputController(stub.ctx);
		stub.ctx.editor.setText("plain follow-up");
		const submitted = controller.handleFollowUp();
		release.resolve();
		await submitted;

		expect(stub.ctx.queueCompactionMessage).toHaveBeenCalledTimes(1);
	});
});

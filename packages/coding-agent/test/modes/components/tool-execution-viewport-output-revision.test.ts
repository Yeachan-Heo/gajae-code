import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { EDIT_MODE_STRATEGIES, type PerFileDiffPreview } from "../../../src/edit";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { initTheme } from "../../../src/modes/theme/theme";

const ui = { requestRender() {}, terminal: { columns: 80 } } as unknown as TUI;

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	resetSettingsForTest();
});

const patch = [
	"*** Begin Patch",
	"*** Update File: preview.ts",
	"@@",
	"-const value = 1;",
	"+const value = 2;",
	"*** End Patch",
].join("\n");

const preview: PerFileDiffPreview[] = [
	{ path: "preview.ts", diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;" },
];

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 50; attempts++) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("Preview computation did not reach the expected state");
}

function deferredPreview(): PromiseWithResolvers<PerFileDiffPreview[] | null> {
	return Promise.withResolvers<PerFileDiffPreview[] | null>();
}

describe("ToolExecutionComponent visible preview revisions", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("reports one current semantic preview change and ignores an identical replacement", async () => {
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = deferredPreview();
			requests.push(request);
			return request.promise;
		});
		let visibleMutations = 0;
		const component = new ToolExecutionComponent(
			"apply_patch",
			{ input: "" },
			{ onVisibleTranscriptMutation: () => visibleMutations++ },
			undefined,
			ui,
			process.cwd(),
		);

		component.updateArgs({ input: patch });
		component.setArgsComplete();
		await waitFor(() => requests.length >= 3);
		requests.at(-1)!.resolve(preview);
		await waitFor(() => visibleMutations === 1);

		component.updateArgs({ input: patch });
		component.setArgsComplete();
		await waitFor(() => requests.length >= 4);
		requests.at(-1)!.resolve(preview);
		await Promise.resolve();
		expect(visibleMutations).toBe(1);
	});

	it("reports a changed preview while arguments are still streaming", async () => {
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = deferredPreview();
			requests.push(request);
			return request.promise;
		});
		let visibleMutations = 0;
		const component = new ToolExecutionComponent(
			"apply_patch",
			{ input: "" },
			{ onVisibleTranscriptMutation: () => visibleMutations++ },
			undefined,
			ui,
			process.cwd(),
		);

		component.updateArgs({ input: patch });
		await waitFor(() => requests.length >= 2);
		requests.at(-1)!.resolve(preview);
		await waitFor(() => visibleMutations === 1);
	});

	it("keeps the prior preview inert when a current apply_patch computation resolves absent", async () => {
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = deferredPreview();
			requests.push(request);
			return request.promise;
		});
		const onVisibleTranscriptMutation = vi.fn();
		const component = new ToolExecutionComponent(
			"apply_patch",
			{ input: patch },
			{ onVisibleTranscriptMutation },
			undefined,
			ui,
			process.cwd(),
		);

		await waitFor(() => requests.length === 1);
		requests[0]!.resolve(preview);
		await waitFor(() => onVisibleTranscriptMutation.mock.calls.length === 1);
		const visibleBefore = component.render(80);
		onVisibleTranscriptMutation.mockClear();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		component.updateArgs({ input: `${patch}\n` });
		await waitFor(() => requests.length === 2);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		requests[1]!.resolve(null);
		await Promise.resolve();

		expect(component.render(80)).toEqual(visibleBefore);
		expect(onVisibleTranscriptMutation).not.toHaveBeenCalled();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
	});

	it("keeps the prior preview inert when a current edit computation rejects", async () => {
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.patch, "computeDiffPreview").mockImplementation(() => {
			const request = deferredPreview();
			requests.push(request);
			return request.promise;
		});
		const onVisibleTranscriptMutation = vi.fn();
		const component = new ToolExecutionComponent(
			"edit",
			{ path: "preview.ts", oldText: "const value = 1;", newText: "const value = 2;" },
			{ onVisibleTranscriptMutation },
			{ mode: "patch" } as never,
			ui,
			process.cwd(),
		);

		await waitFor(() => requests.length === 1);
		requests[0]!.resolve(preview);
		await waitFor(() => onVisibleTranscriptMutation.mock.calls.length === 1);
		const visibleBefore = component.render(80);
		onVisibleTranscriptMutation.mockClear();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		component.updateArgs({ path: "preview.ts", oldText: "const value = 1;", newText: "const value = 3;" });
		await waitFor(() => requests.length === 2);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		requests[1]!.reject(new Error("preview unavailable"));
		await Promise.resolve();
		await Promise.resolve();

		expect(component.render(80)).toEqual(visibleBefore);
		expect(onVisibleTranscriptMutation).not.toHaveBeenCalled();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
	});

	it("does not report a stale preview and commits the superseding current request", async () => {
		const requests: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		vi.spyOn(EDIT_MODE_STRATEGIES.apply_patch, "computeDiffPreview").mockImplementation(() => {
			const request = deferredPreview();
			requests.push(request);
			return request.promise;
		});
		let visibleMutations = 0;
		const component = new ToolExecutionComponent(
			"apply_patch",
			{ input: "" },
			{ onVisibleTranscriptMutation: () => visibleMutations++ },
			undefined,
			ui,
			process.cwd(),
		);

		component.updateArgs({ input: patch });
		component.setArgsComplete();
		await waitFor(() => requests.length >= 3);
		const stale = requests.at(-1)!;
		component.updateArgs({ input: "" });
		component.setArgsComplete();
		await waitFor(() => requests.length >= 4);
		stale.resolve(preview);
		await Promise.resolve();
		expect(visibleMutations).toBe(0);

		component.updateArgs({ input: patch });
		component.setArgsComplete();
		await waitFor(() => requests.length >= 5);
		requests.at(-1)!.resolve(preview);
		await waitFor(() => visibleMutations === 1);
	});
});

describe("synchronous visible revisions", () => {
	it("does not report identical args or results", () => {
		const component = new ToolExecutionComponent("bash", { command: "printf ok" }, {}, undefined, ui, process.cwd());

		component.updateArgs({ command: "printf ok" });
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		expect(component.consumeVisibleTranscriptChange()).toBe(true);
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
	});

	it("handles cyclic and BigInt args without serialization", () => {
		const cyclic: { command: string; self?: unknown; value: bigint } = { command: "printf ok", value: 1n };
		cyclic.self = cyclic;
		const component = new ToolExecutionComponent("bash", cyclic, {}, undefined, ui, process.cwd());

		component.updateArgs(cyclic);
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		component.updateArgs({ command: "printf changed", value: 2n, self: cyclic });
		expect(component.consumeVisibleTranscriptChange()).toBe(true);
	});
});

describe("width-independent visible revisions", () => {
	it("does not report width-only reflow and reports the next semantic state change once", () => {
		const terminal = { columns: 120 };
		const widthAwareUi = { requestRender() {}, terminal } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "printf ok" },
			{},
			undefined,
			widthAwareUi,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "x".repeat(160) }] }, false);
		expect(component.consumeVisibleTranscriptChange()).toBe(true);

		terminal.columns = 20;
		component.setArgsComplete();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		terminal.columns = 120;
		component.setArgsComplete();
		expect(component.consumeVisibleTranscriptChange()).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "changed" }] }, false);
		expect(component.consumeVisibleTranscriptChange()).toBe(true);
	});
});

describe("Kitty image conversion invalidation", () => {
	it("restarts a same-source conversion after its removed index settles stale", async () => {
		const originalImage = Bun.Image;
		const originalProtocol = TERMINAL.imageProtocol;
		const conversions: Array<PromiseWithResolvers<string>> = [];
		class DeferredImage {
			png(): { toBase64(): Promise<string> } {
				return {
					toBase64: () => {
						const conversion = Promise.withResolvers<string>();
						conversions.push(conversion);
						return conversion.promise;
					},
				};
			}
		}
		(Bun as unknown as { Image: typeof Bun.Image }).Image = DeferredImage as never;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			const component = new ToolExecutionComponent("generate_image", {}, {}, undefined, ui, process.cwd());
			const result = { content: [{ type: "image", data: "source", mimeType: "image/webp" }] };
			component.updateResult(result, false);
			expect(conversions).toHaveLength(1);

			component.updateResult({ content: [] }, false);
			conversions[0]?.resolve("stale");
			await Promise.resolve();
			await Promise.resolve();

			component.updateResult(result, false);
			expect(conversions).toHaveLength(2);
			conversions[1]?.resolve("fresh");
			await Promise.resolve();
		} finally {
			(Bun as unknown as { Image: typeof Bun.Image }).Image = originalImage;
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("keeps a newer same-source tool conversion in flight when the older conversion rejects", async () => {
		const originalImage = Bun.Image;
		const originalProtocol = TERMINAL.imageProtocol;
		const conversions: Array<PromiseWithResolvers<string>> = [];
		class DeferredImage {
			png(): { toBase64(): Promise<string> } {
				return {
					toBase64: () => {
						const conversion = Promise.withResolvers<string>();
						conversions.push(conversion);
						return conversion.promise;
					},
				};
			}
		}
		(Bun as unknown as { Image: typeof Bun.Image }).Image = DeferredImage as never;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			const conversionUi = { requestRender() {}, terminal: { columns: 80 } } as unknown as TUI;
			const component = new ToolExecutionComponent("generate_image", {}, {}, undefined, conversionUi, process.cwd());
			const result = { content: [{ type: "image", data: "source", mimeType: "image/webp" }] };
			component.updateResult(result, false);
			component.updateResult({ content: [] }, false);
			component.updateResult(result, false);
			expect(conversions).toHaveLength(2);

			conversions[0]?.reject(new Error("stale"));
			await Promise.resolve();
			component.updateResult({ ...result, details: {} }, false);
			expect(conversions).toHaveLength(2);
			conversions[1]?.resolve("fresh");
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			(Bun as unknown as { Image: typeof Bun.Image }).Image = originalImage;
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("keeps a newer same-source assistant conversion when the older conversion rejects", async () => {
		const originalImage = Bun.Image;
		const originalProtocol = TERMINAL.imageProtocol;
		const conversions: Array<PromiseWithResolvers<string>> = [];
		class DeferredImage {
			png(): { toBase64(): Promise<string> } {
				return {
					toBase64: () => {
						const conversion = Promise.withResolvers<string>();
						conversions.push(conversion);
						return conversion.promise;
					},
				};
			}
		}
		(Bun as unknown as { Image: typeof Bun.Image }).Image = DeferredImage as never;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			await Settings.init({ inMemory: true });
			let imageUpdates = 0;
			const component = new AssistantMessageComponent(undefined, false, () => imageUpdates++);
			const images = [{ type: "image" as const, data: "source", mimeType: "image/webp" }];
			component.setToolResultImages("read-1", images);
			component.setToolResultImages("read-1", []);
			component.setToolResultImages("read-1", images);
			expect(conversions).toHaveLength(2);

			conversions[0]?.reject(new Error("stale"));
			await Promise.resolve();
			conversions[1]?.resolve("fresh");
			await Promise.resolve();
			await Promise.resolve();
			expect(imageUpdates).toBe(1);
		} finally {
			(Bun as unknown as { Image: typeof Bun.Image }).Image = originalImage;
			setTerminalImageProtocol(originalProtocol);
		}
	});
});

describe("Kitty image conversion disposal", () => {
	it("keeps tool and assistant image settlements inert after disposal", async () => {
		const originalImage = Bun.Image;
		const originalProtocol = TERMINAL.imageProtocol;
		const conversions: Array<PromiseWithResolvers<string>> = [];
		class DeferredImage {
			png(): { toBase64(): Promise<string> } {
				return {
					toBase64: () => {
						const conversion = Promise.withResolvers<string>();
						conversions.push(conversion);
						return conversion.promise;
					},
				};
			}
		}
		(Bun as unknown as { Image: typeof Bun.Image }).Image = DeferredImage as never;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			await Settings.init({ inMemory: true });
			const requestRender = vi.fn();
			const conversionUi = { requestRender, terminal: { columns: 80 } } as unknown as TUI;
			const tool = new ToolExecutionComponent("generate_image", {}, {}, undefined, conversionUi, process.cwd());
			tool.updateResult({ content: [{ type: "image", data: "source", mimeType: "image/webp" }] }, false);
			const imageUpdates = vi.fn();
			const assistant = new AssistantMessageComponent(undefined, false, imageUpdates);
			assistant.setToolResultImages("read-1", [{ type: "image", data: "assistant", mimeType: "image/webp" }]);
			expect(conversions).toHaveLength(2);

			tool.dispose();
			assistant.dispose();
			conversions[0]?.resolve("tool-png");
			conversions[1]?.reject(new Error("assistant failure"));
			await Promise.resolve();
			await Promise.resolve();

			expect(requestRender).not.toHaveBeenCalled();
			expect(imageUpdates).not.toHaveBeenCalled();
		} finally {
			(Bun as unknown as { Image: typeof Bun.Image }).Image = originalImage;
			setTerminalImageProtocol(originalProtocol);
		}
	});
});

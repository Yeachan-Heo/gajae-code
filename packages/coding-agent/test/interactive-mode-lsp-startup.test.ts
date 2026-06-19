import { describe, expect, it } from "bun:test";
import {
	getLspStartupWarningMessage,
	LSP_STARTUP_EVENT_CHANNEL,
	type LspStartupEvent,
} from "../src/lsp/startup-events";
import { EventBus } from "../src/utils/event-bus";

describe("InteractiveMode LSP startup events", () => {
	it("delivers startup completion events through the shared channel", () => {
		const eventBus = new EventBus();
		const received: LspStartupEvent[] = [];
		eventBus.on(LSP_STARTUP_EVENT_CHANNEL, event => received.push(event as LspStartupEvent));

		const event: LspStartupEvent = {
			type: "completed",
			servers: [{ name: "rust-analyzer", status: "ready", fileTypes: [".rs"] }],
		};
		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

		expect(received).toEqual([event]);
	});
	it("does not warn for optional rust-analyzer startup failures", () => {
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "rust-analyzer",
					status: "error",
					fileTypes: [".rs"],
					error: "LSP server exited (code 1): error: Unknown binary 'rust-analyzer' in official toolchain 'stable-x86_64-unknown-linux-gnu'.",
				},
			],
		};

		expect(getLspStartupWarningMessage(event)).toBeNull();
	});

	it("still warns for non-optional startup failures without leaking raw error detail", () => {
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "typescript-language-server",
					status: "error",
					fileTypes: [".ts"],
					error: "private path /home/alice/project failed",
				},
			],
		};

		expect(getLspStartupWarningMessage(event)).toBe(
			"LSP startup failed for typescript-language-server. It will retry lazily on write.",
		);
	});
});

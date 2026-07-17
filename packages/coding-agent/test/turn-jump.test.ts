import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { Container, Text } from "@gajae-code/tui";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { associateSessionMessageViewportAnchorId } from "../src/session/session-manager";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function createController(
	messages: AgentMessage[],
	revealViewportAnchor = vi.fn((_id: string, _alignment: string) => true),
) {
	const ctx = {
		session: { messages },
		ui: { revealViewportAnchor },
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { controller: new InputController(ctx), revealViewportAnchor };
}

function registerUserAnchors(messages: AgentMessage[]): void {
	for (const [index, message] of messages.entries()) {
		associateSessionMessageViewportAnchorId(message, `user-${index}`);
	}
}

describe("transcript turn actions", () => {
	it("jumps previous, previous, then next through user turns", async () => {
		const messages = [userMessage("one"), userMessage("two"), userMessage("three")];
		registerUserAnchors(messages);
		const { controller, revealViewportAnchor } = createController(messages);

		expect(controller.actionRegistry.isAvailable("app.transcript.prevTurn")).toBe(true);
		expect(await controller.actionRegistry.execute("app.transcript.prevTurn")).toBe(true);
		expect(await controller.actionRegistry.execute("app.transcript.prevTurn")).toBe(true);
		expect(await controller.actionRegistry.execute("app.transcript.nextTurn")).toBe(true);
		expect(revealViewportAnchor.mock.calls).toEqual([
			["user-2", "top"],
			["user-1", "top"],
			["user-2", "top"],
		]);
	});

	it("preserves the active turn when a new user turn is added", async () => {
		const messages = [userMessage("one"), userMessage("two")];
		registerUserAnchors(messages);
		const { controller, revealViewportAnchor } = createController(messages);

		await controller.actionRegistry.execute("app.transcript.prevTurn");
		await controller.actionRegistry.execute("app.transcript.prevTurn");
		const newMessage = userMessage("three");
		messages.push(newMessage);
		associateSessionMessageViewportAnchorId(newMessage, "user-2");
		await controller.actionRegistry.execute("app.transcript.prevTurn");

		expect(revealViewportAnchor.mock.calls.at(-1)).toEqual(["user-0", "top"]);
	});

	it("is unavailable when no user-message anchors are registered", () => {
		const { controller } = createController([]);

		expect(controller.actionRegistry.isAvailable("app.transcript.prevTurn")).toBe(false);
		expect(controller.actionRegistry.isAvailable("app.transcript.nextTurn")).toBe(false);
	});

	it("only changes viewport position, not component render output", async () => {
		const messages = [userMessage("one"), userMessage("two")];
		registerUserAnchors(messages);
		const transcript = new Container();
		for (const [index] of messages.entries()) {
			const row = new Text(`turn ${index}`, 0, 0);
			transcript.addChild(row);
			transcript.setViewportAnchorSource(row, { id: `user-${index}` });
		}
		const before = transcript.renderWithViewportAnchors(40).lines;
		const { controller } = createController(messages);

		await controller.actionRegistry.execute("app.transcript.prevTurn");

		expect(transcript.renderWithViewportAnchors(40).lines).toEqual(before);
	});

	it("does not advance position when an anchor cannot be revealed", async () => {
		const messages = [userMessage("one"), userMessage("two")];
		registerUserAnchors(messages);
		const revealViewportAnchor = vi.fn((_id: string, _alignment: string) => false);
		const { controller } = createController(messages, revealViewportAnchor);

		await controller.actionRegistry.execute("app.transcript.prevTurn");
		revealViewportAnchor.mockReturnValue(true);
		await controller.actionRegistry.execute("app.transcript.prevTurn");

		expect(revealViewportAnchor.mock.calls).toEqual([
			["user-1", "top"],
			["user-1", "top"],
		]);
	});
});

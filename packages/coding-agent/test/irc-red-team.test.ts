import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { Container, ImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";

const SIXEL_START = "\x1bPq";
const SIXEL_END = "\x1b\\";
const SIXEL_PLACEHOLDER = "[SIXEL image hidden while IRC sidebar is visible]";
const artifactDir = path.join(os.tmpdir(), `gjc-irc-red-team-artifacts-${process.pid}`);
await fs.mkdir(artifactDir, { recursive: true });
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalProtocol = TERMINAL.imageProtocol;
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

beforeAll(async () => {
	await initTheme();
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Expected red-claw theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	vi.useRealTimers();
	terminal.imageProtocol = originalProtocol;
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

function ircMessage(observationId: string, timestamp: number, text: string): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		details: { observationId, from: "peer", to: "0-Main", message: text },
		attribution: "agent",
		timestamp,
	};
}

function eventContext(setting: { enabled: boolean }) {
	const chatContainer = new Container();
	const ledger = new IrcObservationLedger();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		chatContainer,
		settings: { get: () => setting.enabled },
		captureIrcArrivalSnapshot: () => ({
			panelVisible: setting.enabled,
			panelRequestedVisible: setting.enabled,
			sidebarAvailable: true,
			resolvedToggleKey: "Alt+I",
		}),
		ircLedger: ledger,
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.removeRenderedIrcInlineComponents = observationId => helpers.removeRenderedIrcInlineComponents(observationId);
	ctx.resetRenderedIrcInlineComponents = () => helpers.resetRenderedIrcInlineComponents();
	const addMessageToChat = vi.fn((message: CustomMessage) => helpers.addMessageToChat(message));
	ctx.addMessageToChat = addMessageToChat;
	const addLiveIrcObservationToChat = vi.fn((message, arrival) =>
		helpers.addLiveIrcObservationToChat(message, arrival),
	);
	ctx.addLiveIrcObservationToChat = addLiveIrcObservationToChat;
	return { ctx, chatContainer, ledger, addMessageToChat, addLiveIrcObservationToChat };
}

function visibleSplit(component: BashExecutionComponent): IrcSplitViewComponent {
	const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
	split.setVisible(true);
	return split;
}

describe("IRC visualization red-team", () => {
	it("keeps same-millisecond/same-customType observations distinct, dedupes persisted delivery, and records both", async () => {
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger, addLiveIrcObservationToChat } = eventContext(setting);
		const controller = new EventController(ctx);
		const first = ircMessage("red-one", 1234, "first");
		const second = ircMessage("red-two", 1234, "second");

		await controller.handleEvent({ type: "irc_message", message: first });
		await controller.handleEvent({ type: "irc_message", message: second });
		await controller.handleEvent({ type: "message_start", message: first });

		expect(addLiveIrcObservationToChat).toHaveBeenCalledTimes(2);
		expect(chatContainer.children).toHaveLength(4);
		expect(ledger.getSidebarRecords().map(record => record.text)).toEqual(["first", "second"]);
	});

	it("removes rendered IRC components on a sidebar-session reset and allows a fresh observation", async () => {
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger } = eventContext(setting);
		const controller = new EventController(ctx);
		const split = new IrcSplitViewComponent(chatContainer, ledger, theme);
		split.setVisible(true);
		const resetIrcSidebarSession = () => {
			ledger.reset();
			controller.resetIrcObservations();
			split.setVisible(false);
		};

		await controller.handleEvent({ type: "irc_message", message: ircMessage("before-reset", 1, "before reset") });
		expect(chatContainer.children).toHaveLength(2);

		resetIrcSidebarSession();
		expect(chatContainer.children).toHaveLength(0);
		expect(ledger.getSidebarRecords()).toEqual([]);

		await controller.handleEvent({ type: "irc_message", message: ircMessage("after-reset", 2, "after reset") });
		expect(chatContainer.children).toHaveLength(2);
		expect(ledger.getSidebarRecords().map(record => record.text)).toEqual(["after reset"]);
	});

	it("captures immutable event-time policy across a live setting flip", async () => {
		vi.useFakeTimers({ now: 0 });
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger } = eventContext(setting);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: ircMessage("before", 0, "persistent") });
		setting.enabled = true;
		await controller.handleEvent({ type: "irc_message", message: ircMessage("after", 1, "ephemeral") });

		expect(ledger.getSidebarRecords().map(record => record.mode)).toEqual(["persistent", "ephemeral"]);
		vi.advanceTimersByTime(10_000);
		expect(ledger.getInlineProjection(Date.now()).map(record => record.observationId)).toEqual(["before"]);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("replaces a SIXEL sequence whose visible collapsed slice starts inside it exactly once, with footer and no DCS", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new BashExecutionComponent("emit sixel", ui, false);
		const output = [
			...Array.from({ length: 18 }, (_, index) => `ordinary ${index}`),
			`${SIXEL_START}payload-begins`,
			"payload-continues",
			`payload-ends${SIXEL_END}`,
			...Array.from({ length: 5 }, (_, index) => `tail ${index}`),
		].join("\n");
		component.setComplete(0, false, { output });
		const raw = visibleSplit(component).render(160).join("\n");
		await fs.writeFile(path.join(artifactDir, "collapsed-sixel-visible.ansi"), raw);
		const plain = Bun.stripANSI(raw);

		expect(plain.split(SIXEL_PLACEHOLDER).length - 1).toBe(1);
		expect(plain).toMatch(/more lines/u);
		expect(raw).not.toContain("\x1bP");
	});

	it("with rapid visibility toggles, never leaks raw DCS into visible renders or stale cached output", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new BashExecutionComponent("emit sixel", ui, false);
		component.setComplete(0, false, { output: `${SIXEL_START}cached${SIXEL_END}` });
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		const frames: string[] = [];
		for (let index = 0; index < 20; index++) {
			split.setVisible(true);
			frames.push(split.render(100).join("\n"));
			split.setVisible(false);
			frames.push(split.render(100).join("\n"));
		}
		await fs.writeFile(path.join(artifactDir, "toggle-spam.ansi"), frames.join("\n---FRAME---\n"));
		expect(frames.filter((_, index) => index % 2 === 0).every(frame => !frame.includes("\x1bP"))).toBe(true);
		expect(frames.filter((_, index) => index % 2 === 1).every(frame => frame.includes("\x1bP"))).toBe(true);
	});
});

export const ircRedTeamArtifactDir = artifactDir;

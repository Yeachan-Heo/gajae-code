import { beforeAll, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { BTW_HANDOFF_MESSAGE_TYPE, renderBtwHandoffMessage } from "@gajae-code/coding-agent/session/btw-contract";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { Container } from "@gajae-code/tui";

beforeAll(() => initTheme());

function renderHandoff(details: unknown): string {
	const chatContainer = new Container();
	const ctx = {
		chatContainer,
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		session: {},
	} as unknown as InteractiveModeContext;
	const message: CustomMessage<unknown> = {
		role: "custom",
		customType: BTW_HANDOFF_MESSAGE_TYPE,
		content: renderBtwHandoffMessage([{ question: "SIDE_QUESTION", answer: "SIDE_ANSWER" }]),
		display: true,
		details,
		attribution: "user",
		timestamp: Date.now(),
	};
	new UiHelpers(ctx).addMessageToChat(message);
	return Bun.stripANSI(chatContainer.render(120).join("\n"));
}

describe("btw-handoff transcript rendering", () => {
	it("shows a compact marker with the exchange count instead of the model-facing payload", () => {
		const rendered = renderHandoff({ exchangeCount: 2 });

		expect(rendered).toContain("Handed off /btw side chat (2 exchanges)");
		expect(rendered).not.toContain("SIDE_QUESTION");
		expect(rendered).not.toContain("<btw-handoff");
	});

	it("renders the marker without a count when details are missing", () => {
		const rendered = renderHandoff(undefined);

		expect(rendered).toContain("Handed off /btw side chat");
		expect(rendered).not.toContain("exchange");
	});
});

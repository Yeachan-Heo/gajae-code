import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { Message, UserMessage } from "@gajae-code/ai/core";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container } from "@gajae-code/tui";

beforeAll(() => initTheme());

const photo = { type: "image" as const, mimeType: "image/jpeg", data: "blob:sha256:00" };

function renderUser(
	content: Exclude<UserMessage["content"], string>,
	role: "user" | "developer" = "user",
): { rendered: string; history: string[] } {
	const chatContainer = new Container();
	const history: string[] = [];
	const helpers: UiHelpers = new UiHelpers({
		chatContainer,
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		session: {},
		editor: { addToHistory: (text: string) => history.push(text) },
		getUserMessageText: (message: Message) => helpers.getUserMessageText(message),
	} as unknown as InteractiveModeContext);
	helpers.addMessageToChat({ role, content, timestamp: Date.now() }, { populateHistory: true });
	return { rendered: Bun.stripANSI(chatContainer.render(120).join("\n")), history };
}

describe("user message images in the transcript", () => {
	it("marks an image a remote client attached without naming it in the text", () => {
		const { rendered, history } = renderUser([{ type: "text", text: "is this visible?" }, photo]);

		expect(rendered).toContain("is this visible?");
		expect(rendered).toContain("[image: image/jpeg]");
		expect(history).toEqual(["is this visible?"]);
	});

	it("shows an image-only message instead of dropping it", () => {
		const { rendered, history } = renderUser([photo, { ...photo, mimeType: "image/png" }]);

		expect(rendered).toContain("[image: image/jpeg] [image: image/png]");
		expect(history).toEqual([]);
	});

	it("adds no marker for images the TUI prompt already references", () => {
		const { rendered } = renderUser([{ type: "text", text: "compare [image 1] with [image 2]" }, photo, photo]);

		expect(rendered).toContain("compare [image 1] with [image 2]");
		expect(rendered).not.toContain("[image: ");
	});

	it("marks only the images beyond the distinct references in the text", () => {
		const { rendered } = renderUser([{ type: "text", text: "see [image 1], again [image 1]" }, photo, photo]);

		expect(rendered).toContain("see [image 1], again [image 1]");
		expect(rendered.match(/\[image: image\/jpeg\]/g)).toHaveLength(1);
	});

	it("leaves developer messages with images out of the transcript, as live rendering does", () => {
		const { rendered } = renderUser([photo], "developer");

		expect(rendered).not.toContain("[image: ");
	});
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DisconnectConfirmation, disconnectConfirmTitle } from "../src/SessionConnection";

const noop = () => {};
const render = (props: { running: boolean; queued: number; background?: number }) =>
	renderToStaticMarkup(<DisconnectConfirmation {...props} pending={false} onConfirm={noop} onCancel={noop} />);

describe("Disconnect confirmation", () => {
	test("background work alone is named, and stopping it is the dangerous action", () => {
		const markup = render({ running: false, queued: 0, background: 2 });
		expect(markup).toContain("Disconnecting ends 2 background jobs or tasks in this conversation.");
		expect(markup).toContain("Stop and disconnect");
		expect(markup).toContain('class="button danger"');
		expect(markup).not.toContain("queued message");
		expect(disconnectConfirmTitle(true)).toBe("Disconnect while it is working?");
	});

	test("one background job reads in the singular next to a running turn and queued messages", () => {
		const markup = render({ running: true, queued: 1, background: 1 });
		expect(markup).toContain("Disconnecting stops the current turn, as Stop does.");
		expect(markup).toContain("Disconnecting ends 1 background job or task in this conversation.");
		expect(markup).toContain("1 queued message goes back to the message box.");
	});

	test("queued messages alone keep the plain Disconnect action", () => {
		const markup = render({ running: false, queued: 2 });
		expect(markup).toContain("2 queued messages go back to the message box.");
		expect(markup).not.toContain("Stop and disconnect");
		expect(markup).not.toContain("background");
		expect(disconnectConfirmTitle(false)).toBe("Disconnect with queued messages?");
	});
});

import { describe, expect, it } from "bun:test";
import { BridgeExtensionUIContext, type BridgeUiRequestPayload } from "../../src/modes/bridge/bridge-ui-context";
import { UiRequestBroker } from "../../src/modes/shared/agent-wire/ui-request-broker";
import type { BridgeUiResult } from "../../src/modes/shared/agent-wire/ui-result";
import { uiValue } from "../../src/modes/shared/agent-wire/ui-result";

describe("BridgeExtensionUIContext", () => {
	it("routes core select/confirm/input through the broker", async () => {
		const emitted: Array<{ id: string; request: BridgeUiRequestPayload }> = [];
		const broker = new UiRequestBroker<BridgeUiRequestPayload, BridgeUiResult<unknown>>({
			emitRequest: (id, request) => emitted.push({ id, request }),
		});
		const controller = broker.claimController();
		if (controller.status !== "claimed") throw new Error("controller was not claimed");
		const ui = new BridgeExtensionUIContext({ broker, emit: () => {} });

		const select = ui.select("Pick", ["A", "B"]);
		expect(emitted[0]?.request).toEqual({ kind: "select", title: "Pick", options: ["A", "B"], timeout: undefined });
		expect(broker.respond(emitted[0]!.id, controller.ownerToken, uiValue("B"))).toEqual({ status: "accepted" });
		expect(await select).toBe("B");

		const confirm = ui.confirm("Confirm", "Proceed?");
		expect(broker.respond(emitted[1]!.id, controller.ownerToken, uiValue(true))).toEqual({ status: "accepted" });
		expect(await confirm).toBe(true);

		const input = ui.input("Name", "placeholder");
		expect(broker.respond(emitted[2]!.id, controller.ownerToken, uiValue("GJC"))).toEqual({ status: "accepted" });
		expect(await input).toBe("GJC");
	});

	it("emits declarative advanced surfaces and typed unsupported failures", () => {
		const emitted: BridgeUiRequestPayload[] = [];
		const broker = new UiRequestBroker<BridgeUiRequestPayload, BridgeUiResult<unknown>>({
			emitRequest: () => {},
		});
		const ui = new BridgeExtensionUIContext({ broker, emit: payload => emitted.push(payload) });

		ui.notify("hello", "info");
		ui.setStatus("status", "ready");
		ui.setWidget("todos", ["one"], { placement: "aboveEditor" });
		ui.setWidget("custom", (() => ({ render: () => [], invalidate: () => {} })) as never);
		ui.setEditorComponent(undefined);
		ui.onTerminalInput(() => {});

		expect(emitted).toEqual([
			{ kind: "notify", message: "hello", type: "info" },
			{ kind: "status", key: "status", text: "ready" },
			{ kind: "widget", key: "todos", lines: ["one"], placement: "aboveEditor" },
			{
				kind: "unsupported",
				capability: "ui.widget.component",
				reason: "Component factory widgets are local-only and not serializable",
			},
			{
				kind: "unsupported",
				capability: "ui.editor.component",
				reason: "Custom editor components are local-only and not serializable",
			},
			{
				kind: "unsupported",
				capability: "ui.terminal_input",
				reason: "Raw terminal input is not supported by the bridge protocol yet",
			},
		]);
	});
});

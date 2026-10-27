import { describe, expect, it, spyOn } from "bun:test";
import {
	EXTENSION_INTERACTION_LIMITS,
	type ExtensionInteractionAddress,
	ExtensionInteractionError,
	type ExtensionInteractionPayload,
	type ExtensionInteractionPurpose,
	ExtensionInteractionService,
} from "../src/sdk/extension-interaction";

function fixture(sessionId = "isolated-session") {
	const service = new ExtensionInteractionService(sessionId);
	const { connectionId } = service.connect();
	const address = (): ExtensionInteractionAddress => ({
		sessionId,
		connectionId,
		requestId: service.snapshot().pending[0]!.requestId,
	});
	return { service, connectionId, address };
}

function errorCode(action: () => unknown, code: ExtensionInteractionError["code"]) {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(ExtensionInteractionError);
		expect((error as ExtensionInteractionError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("portable extension interactions", () => {
	it("round-trips select, confirm, input and editor through the existing UI context", async () => {
		const { service, address } = fixture();
		const selection = service.ui.select("Choose", ["first", "second"], {
			initialIndex: 1,
			helpText: "Pick one",
			wrapFocused: true,
		});
		expect(service.snapshot().pending[0]!.payload).toEqual({
			kind: "select",
			title: "Choose",
			options: ["first", "second"],
			initialIndex: 1,
			helpText: "Pick one",
		});
		errorCode(() => service.respond(address(), "forged"), "invalid-result");
		errorCode(() => service.respond(address(), true), "invalid-result");
		service.respond(address(), "second");
		expect(await selection).toBe("second");

		const confirmation = service.ui.confirm("Confirm", "Continue?");
		errorCode(() => service.respond(address(), "yes"), "invalid-result");
		service.respond(address(), false);
		expect(await confirmation).toBe(false);
		const input = service.ui.input("Name", "Placeholder");
		service.respond(address(), "");
		expect(await input).toBe("");
		const editor = service.ui.editor("Edit", "initial", undefined, { promptStyle: true });
		expect(service.snapshot().pending[0]!.payload).toEqual({
			kind: "editor",
			title: "Edit",
			prefill: "initial",
			promptStyle: true,
		});
		service.respond(address(), "line one\nline two");
		expect(await editor).toBe("line one\nline two");
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});

	it("rejects unavailable UI explicitly rather than returning false/undefined or discarding notifications", async () => {
		const service = new ExtensionInteractionService("offline");
		await expect(service.ui.confirm("Approve", "Proceed?")).rejects.toMatchObject({ code: "unavailable" });
		await expect(service.ui.select("Choose", ["a"])).rejects.toMatchObject({ code: "unavailable" });
		errorCode(() => service.ui.notify("invisible"), "unavailable");
		service.connect();
		service.dispose();
		await expect(service.ui.input("Name")).rejects.toMatchObject({ code: "disposed" });
	});

	it("preserves requests on reconnect while revoking the previous renderer's authority", async () => {
		const { service, address, connectionId } = fixture();
		const answer = service.ui.input("Name");
		const oldAddress = address();
		service.disconnect(connectionId);
		errorCode(() => service.respond(oldAddress, "late"), "stale-connection");
		await expect(service.ui.confirm("Offline", "Approve?")).rejects.toMatchObject({ code: "unavailable" });
		const reconnect = service.connect();
		expect(reconnect.state.pending[0]!.requestId).toBe(oldAddress.requestId);
		expect(reconnect.connectionId).not.toBe(connectionId);
		errorCode(() => service.disconnect(connectionId), "stale-connection");
		errorCode(() => service.cancel(oldAddress), "stale-connection");
		const newAddress = { ...oldAddress, connectionId: reconnect.connectionId };
		service.respond(newAddress, "restored");
		expect(await answer).toBe("restored");
		errorCode(() => service.respond(newAddress, "duplicate"), "stale-request");
		errorCode(() => service.cancel(newAddress), "stale-request");
		service.dispose();
	});

	it("settles only the validated request when an address getter changes its target", async () => {
		for (const action of ["respond", "cancel"] as const) {
			const { service, connectionId } = fixture();
			try {
				const first = service.request({ kind: "input", title: "Validated" });
				const second = service.request({ kind: "confirm", title: "Other", message: "Proceed?" });
				const [firstRequest, secondRequest] = service.snapshot().pending;
				let reads = 0;
				const address: ExtensionInteractionAddress = {
					sessionId: firstRequest!.sessionId,
					connectionId,
					get requestId() {
						return reads++ === 0 ? firstRequest!.requestId : secondRequest!.requestId;
					},
				};
				if (action === "respond") {
					expect(service.respond(address, "answer")).toEqual({ grantsExecutionPermission: false });
				} else {
					service.cancel(address);
				}
				expect(reads).toBe(1);
				expect(service.snapshot().pending.map(request => request.requestId)).toEqual([secondRequest!.requestId]);
				expect(await first).toEqual(
					action === "respond" ? { status: "answered", value: "answer" } : { status: "cancelled", reason: "user" },
				);
				service.dispose();
				expect(await second).toEqual({ status: "cancelled", reason: "disposed" });
			} finally {
				service.dispose();
			}
		}
	});

	it("makes cancellation observable and refuses stale answers", async () => {
		const { service, address } = fixture();
		const request = service.request({ kind: "input", title: "Name" });
		const target = address();
		service.cancel(target);
		expect(await request).toEqual({ status: "cancelled", reason: "user" });
		errorCode(() => service.respond(target, "late"), "stale-request");
		const confirm = service.ui.confirm("Confirm", "Proceed?");
		service.cancel(address());
		expect(await confirm).toBe(false);
		service.dispose();
	});

	it("cancels on abort, handles pre-abort and timeout, and releases timers on successful response", async () => {
		const { service, address } = fixture();
		const controller = new AbortController();
		const aborted = service.request({ kind: "input", title: "Abort" }, { signal: controller.signal });
		const stale = address();
		controller.abort();
		expect(await aborted).toEqual({ status: "cancelled", reason: "aborted" });
		errorCode(() => service.respond(stale, "late"), "stale-request");
		expect(await service.request({ kind: "input", title: "Already aborted" }, { signal: controller.signal })).toEqual(
			{ status: "cancelled", reason: "aborted" },
		);
		let timeouts = 0;
		const timedOut = service.request(
			{ kind: "input", title: "Timeout" },
			{ timeout: 0, onTimeout: () => timeouts++ },
		);
		expect(await timedOut).toEqual({ status: "cancelled", reason: "timeout" });
		expect(timeouts).toBe(1);
		const completed = service.request({ kind: "input", title: "Fast" }, { timeout: 10, onTimeout: () => timeouts++ });
		service.respond(address(), "done");
		expect(await completed).toEqual({ status: "answered", value: "done" });
		await Bun.sleep(20);
		expect(timeouts).toBe(1);
		const failedCallback = service.request(
			{ kind: "input", title: "Callback" },
			{
				timeout: 0,
				onTimeout: () => {
					throw new Error("timeout callback failed");
				},
			},
		);
		await expect(failedCallback).rejects.toThrow("timeout callback failed");
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});

	it("isolates concurrent requests and immutable session ownership across session switching", async () => {
		const first = fixture("session-a");
		const second = fixture("session-b");
		const a = first.service.request({ kind: "input", title: "A" });
		const b = second.service.ui.input("B");
		const old = first.address();
		errorCode(() => second.service.respond(old, "foreign"), "wrong-session");
		errorCode(
			() => second.service.respond({ ...old, sessionId: "session-b", connectionId: second.connectionId }, "foreign"),
			"stale-request",
		);
		first.service.dispose();
		expect(await a).toEqual({ status: "cancelled", reason: "disposed" });
		errorCode(() => first.service.respond(old, "late"), "disposed");
		second.service.respond(second.address(), "successor");
		expect(await b).toBe("successor");
		const pending = [second.service.ui.input("one"), second.service.ui.editor("two")];
		expect(second.service.snapshot().pending).toHaveLength(2);
		second.service.dispose();
		expect(await Promise.all(pending)).toEqual([undefined, undefined]);
		expect(second.service.snapshot()).toMatchObject({ disposed: true, connected: false, pending: [] });
	});

	it("supports workflow consent without granting execution permission or autoapproval", async () => {
		const { service, address } = fixture();
		const approval = service.request(
			{ kind: "confirm", title: "Plan", message: "Approve workflow plan?" },
			{},
			"workflow-approval",
		);
		expect(service.snapshot().pending[0]!.purpose).toBe("workflow-approval");
		expect(service.respond(address(), true)).toEqual({ grantsExecutionPermission: false });
		expect(await approval).toEqual({ status: "answered", value: true });
		errorCode(
			() =>
				service.request(
					{ kind: "confirm", title: "Shell", message: "Execute?" },
					{},
					"execution-permission" as ExtensionInteractionPurpose,
				),
			"invalid-request",
		);
		const unapproved = service.ui.confirm("No answer", "Approve?");
		expect(service.snapshot().pending).toHaveLength(1);
		service.cancel(address());
		expect(await unapproved).toBe(false);
		service.dispose();
	});

	it("exposes isolated state and notification events without leaking responder credentials", () => {
		const { service, connectionId } = fixture();
		const events: string[] = [];
		const unsubscribe = service.subscribe(state => events.push(JSON.stringify(state)));
		service.ui.notify("first", "warning");
		service.ui.notify("second", "error");
		expect(events).toHaveLength(2);
		expect(events.join("\n")).not.toContain(connectionId);
		expect(service.snapshot().lastNotification).toEqual({ sequence: 2, message: "second", type: "error" });
		const state = service.snapshot();
		if (state.lastNotification) Object.assign(state.lastNotification, { message: "mutated" });
		expect(service.snapshot().lastNotification?.message).toBe("second");
		expect(service.connect().state.lastNotification?.message).toBe("second");
		unsubscribe();
		const count = events.length;
		service.ui.notify("third");
		expect(events).toHaveLength(count);
		service.dispose();
	});

	it("copies request payloads and cleans up even when a listener throws", async () => {
		const { service, address } = fixture();
		const choices = ["a", "b"];
		let delivered = 0;
		service.subscribe(() => {
			throw new Error("renderer disconnected unexpectedly");
		});
		service.subscribe(() => {
			delivered++;
		});
		const answer = service.request({ kind: "select", title: "Choose", options: choices });
		choices[0] = "mutated";
		const state = service.snapshot();
		Object.assign(state.pending[0]!.payload, { title: "mutated" });
		expect(service.snapshot().pending[0]!.payload.title).toBe("Choose");
		service.respond(address(), "a");
		expect(await answer).toEqual({ status: "answered", value: "a" });
		expect(delivered).toBe(2);
		service.dispose();
	});

	it("refuses terminal factories, host controls and callback-only selector semantics explicitly", async () => {
		const { service } = fixture();
		const calls = [
			() => service.ui.onTerminalInput(() => undefined),
			() => service.ui.setStatus("x", "status"),
			() => service.ui.setWorkingMessage("busy"),
			() => service.ui.setWidget("x", ["text"]),
			() => service.ui.setFooter(undefined),
			() => service.ui.setHeader(undefined),
			() => service.ui.setTitle("title"),
			() => service.ui.setEditorText("x"),
			() => service.ui.pasteToEditor("x"),
			() => service.ui.getEditorText(),
			() => service.ui.setEditorComponent(undefined),
			() => service.ui.theme,
			() => service.ui.getToolsExpanded(),
			() => service.ui.setToolsExpanded(true),
		];
		for (const call of calls) errorCode(call, "terminal-only");
		const asyncCalls = [
			service.ui.custom(async () => {
				throw new Error("Factory must not run");
			}),
			service.ui.getAllThemes(),
			service.ui.getTheme("dark"),
			service.ui.setTheme("dark"),
			service.ui.select("Choose", ["a"], {
				onExternalEditor: () => {
					throw new Error("must not run");
				},
			}),
			service.ui.select("Choose", ["custom"], { customInput: { optionLabel: "custom", onSubmit: () => {} } }),
		];
		for (const call of asyncCalls)
			await expect(call).rejects.toMatchObject({ code: "terminal-only", alternative: expect.any(String) });
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});

	it("bounds retained requests, listeners, notifications and answers without evicting waiters", async () => {
		const { service, address } = fixture();
		const oversized = "x".repeat(EXTENSION_INTERACTION_LIMITS.textBytes + 1);
		errorCode(() => service.notify(oversized), "invalid-request");
		errorCode(() => service.request({ kind: "editor", title: "Large", prefill: oversized }), "invalid-request");
		const pending = Array.from({ length: EXTENSION_INTERACTION_LIMITS.pending }, () =>
			service.request({ kind: "input", title: "Waiting" }),
		);
		errorCode(() => service.request({ kind: "input", title: "Overflow" }), "capacity-exceeded");
		errorCode(() => service.respond(address(), oversized), "invalid-result");
		expect(service.snapshot().pending).toHaveLength(EXTENSION_INTERACTION_LIMITS.pending);
		const subscriptions = Array.from({ length: EXTENSION_INTERACTION_LIMITS.listeners }, () =>
			service.subscribe(() => {}),
		);
		errorCode(() => service.subscribe(() => {}), "capacity-exceeded");
		subscriptions[0]!();
		service.subscribe(() => {});
		service.dispose();
		expect(
			(await Promise.all(pending)).every(result => result.status === "cancelled" && result.reason === "disposed"),
		).toBe(true);
	});

	it("does not duplicate newer states or call removed listeners during reentrant delivery", () => {
		const { service } = fixture();
		const revisions: number[] = [];
		service.subscribe(state => {
			if (state.lastNotification?.message === "first") service.notify("second");
		});
		service.subscribe(state => revisions.push(state.revision));
		service.notify("first");
		expect(revisions).toEqual([service.snapshot().revision]);
		let removedCalls = 0;
		let remove = () => {};
		service.subscribe(() => remove());
		remove = service.subscribe(() => removedCalls++);
		service.notify("third");
		expect(removedCalls).toBe(0);
		service.dispose();
	});

	it("removes abort listeners after response, cancellation, timeout and disposal", async () => {
		for (const finish of ["response", "cancel", "timeout", "dispose"] as const) {
			const { service, address } = fixture();
			const controller = new AbortController();
			const remove = spyOn(controller.signal, "removeEventListener");
			try {
				const pending = service.request(
					{ kind: "input", title: finish },
					{
						signal: controller.signal,
						timeout: finish === "timeout" ? 0 : undefined,
					},
				);
				if (finish === "response") service.respond(address(), "answer");
				if (finish === "cancel") service.cancel(address());
				if (finish === "dispose") service.dispose();
				await pending;
				expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
				controller.abort();
				expect(service.snapshot().pending).toEqual([]);
			} finally {
				remove.mockRestore();
				service.dispose();
			}
		}
	});

	it("validates malformed payloads and timeout boundaries before creating pending work", () => {
		const { service } = fixture();
		for (const payload of [
			{ kind: "select", title: "Choose", options: [] },
			{ kind: "select", title: "Choose", options: Array(1) },
			{ kind: "select", title: "Choose", options: ["a"], initialIndex: 1 },
			{ kind: "input", title: 1 },
			{ kind: "confirm", title: "Approve", message: false },
			{ kind: "editor", title: "Edit", promptStyle: "yes" },
			{ kind: "shell", title: "Execute" },
		])
			errorCode(() => service.request(payload as ExtensionInteractionPayload), "invalid-request");
		for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			errorCode(() => service.request({ kind: "input", title: "Timeout" }, { timeout }), "invalid-request");
		}
		errorCode(() => service.notify("message", "fatal" as "info"), "invalid-request");
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});
});

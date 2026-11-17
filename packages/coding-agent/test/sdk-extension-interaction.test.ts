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

	for (const action of ["respond", "cancel"] as const) {
		for (const rotation of ["disconnect", "reconnect"] as const) {
			it(`refuses ${action} when a requestId getter triggers ${rotation}`, async () => {
				const { service, connectionId } = fixture();
				try {
					const pending = service.request({ kind: "input", title: "Owned request" });
					const request = service.snapshot().pending[0]!;
					let currentConnection = connectionId;
					let reads = 0;
					const address: ExtensionInteractionAddress = {
						sessionId: request.sessionId,
						connectionId,
						get requestId() {
							reads++;
							if (rotation === "disconnect") service.disconnect(connectionId);
							else currentConnection = service.connect().connectionId;
							return request.requestId;
						},
					};
					errorCode(
						() => (action === "respond" ? service.respond(address, "revoked") : service.cancel(address)),
						"stale-connection",
					);
					expect(reads).toBe(1);
					expect(service.snapshot().pending.map(item => item.requestId)).toEqual([request.requestId]);
					if (rotation === "disconnect") currentConnection = service.connect().connectionId;
					service.respond({ ...request, connectionId: currentConnection }, "current renderer");
					expect(await pending).toEqual({ status: "answered", value: "current renderer" });
				} finally {
					service.dispose();
				}
			});
		}
	}

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
			const remove = spyOn(EventTarget.prototype, "removeEventListener");
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

	it("bounds the detached payload rather than caller-controlled serialization", async () => {
		const { service, address } = fixture();
		let deliveries = 0;
		service.subscribe(() => deliveries++);
		const large = "x".repeat(2 * 1024 * 1024);
		const inherited = Object.assign(Object.create({ toJSON: () => ({}) }), {
			kind: "input",
			title: large,
		}) as ExtensionInteractionPayload;
		const nested = Object.assign([large], { toJSON: () => [] });
		const inheritedNested = Object.setPrototypeOf(
			[large],
			Object.assign(Object.create(Array.prototype), {
				toJSON: () => [],
			}),
		);
		for (const payload of [
			inherited,
			{ kind: "select", title: "Choose", options: nested },
			{ kind: "select", title: "Choose", options: inheritedNested },
			{ kind: "input", title: "Name", toJSON: () => ({}) },
			{ kind: "input", title: "Name", extra: large },
		] as ExtensionInteractionPayload[]) {
			errorCode(() => service.request(payload), "invalid-request");
		}
		expect(service.snapshot().pending).toEqual([]);
		expect(deliveries).toBe(0);

		const base = Buffer.byteLength(JSON.stringify({ kind: "input", title: "" }));
		const limit = EXTENSION_INTERACTION_LIMITS.payloadBytes;
		const title = "é".repeat(Math.floor((limit - base) / 2)) + "x".repeat((limit - base) % 2);
		const payload = { kind: "input" as const, title };
		const pending = service.request(payload);
		payload.title = "changed";
		expect(service.snapshot().pending[0]!.payload.title).toBe(title);
		errorCode(() => service.request({ kind: "input", title: `${title}x` }), "invalid-request");
		expect(deliveries).toBe(1);
		service.respond(address(), "ok");
		expect(await pending).toEqual({ status: "answered", value: "ok" });
		service.dispose();
	});

	it("reads payload getters once, redacts errors, and respects reentrant admission", async () => {
		const { service, address } = fixture();
		let deliveries = 0;
		service.subscribe(() => deliveries++);
		let reads = 0;
		const pending = service.request({
			kind: "input",
			get title() {
				reads++;
				return reads === 1 ? "first" : "x".repeat(2 * 1024 * 1024);
			},
		});
		expect(reads).toBe(1);
		expect(service.snapshot().pending[0]!.payload.title).toBe("first");
		service.respond(address(), "ok");
		await pending;
		const before = deliveries;
		try {
			service.request({
				kind: "input",
				get title(): string {
					throw new Error("private accessor detail");
				},
			});
			throw new Error("Expected invalid request");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionInteractionError);
			expect((error as ExtensionInteractionError).code).toBe("invalid-request");
			expect((error as Error).message).not.toContain("private accessor detail");
		}
		expect(service.snapshot().pending).toEqual([]);
		expect(deliveries).toBe(before);

		const reentrant = {
			kind: "input" as const,
			get title() {
				service.disconnect(addressConnection);
				return "disconnected";
			},
		};
		const { connectionId: addressConnection } = service.connect();
		const beforeDisconnect = deliveries;
		errorCode(() => service.request(reentrant), "unavailable");
		expect(deliveries).toBe(beforeDisconnect + 1);
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});

	it("rechecks capacity after a payload getter reenters admission", async () => {
		const { service } = fixture();
		const pending: Promise<unknown>[] = [];
		let reads = 0;
		const payload = {
			kind: "input" as const,
			get title() {
				reads++;
				for (let i = 0; i < EXTENSION_INTERACTION_LIMITS.pending; i++) {
					pending.push(service.request({ kind: "input", title: "inner" }));
				}
				return "outer";
			},
		};
		errorCode(() => service.request(payload), "capacity-exceeded");
		expect(reads).toBe(1);
		expect(service.snapshot().pending).toHaveLength(EXTENSION_INTERACTION_LIMITS.pending);
		expect(service.snapshot().pending.every(request => request.payload.title === "inner")).toBe(true);
		service.dispose();
		await Promise.all(pending);
	});

	it("snapshots options before admission and rejects accessor failures without exposing them", async () => {
		for (const key of ["timeout", "signal", "onTimeout"] as const) {
			for (const action of ["dispose", "disconnect", "throw"] as const) {
				const { service, connectionId } = fixture();
				let reads = 0;
				const options = {
					get [key]() {
						reads++;
						if (action === "dispose") service.dispose();
						if (action === "disconnect") service.disconnect(connectionId);
						if (action === "throw") throw new Error("private option error");
						return undefined;
					},
				};
				try {
					service.request({ kind: "input", title: "outer" }, options);
					throw new Error("Expected admission failure");
				} catch (error) {
					expect(error).toBeInstanceOf(ExtensionInteractionError);
					expect((error as ExtensionInteractionError).code).toBe(
						action === "throw" ? "invalid-request" : action === "dispose" ? "disposed" : "unavailable",
					);
					expect((error as Error).message).not.toContain("private option error");
				}
				expect(reads).toBe(1);
				expect(service.snapshot().pending).toEqual([]);
				service.dispose();
			}
		}

		const { service, address } = fixture();
		const controller = new AbortController();
		let timeoutReads = 0;
		let signalReads = 0;
		let callbackReads = 0;
		let callbacks = 0;
		const pending = service.request(
			{ kind: "input", title: "snapshot" },
			{
				get timeout() {
					return timeoutReads++ === 0 ? 60_000 : 0;
				},
				get signal() {
					return signalReads++ === 0 ? controller.signal : new AbortController().signal;
				},
				get onTimeout() {
					callbackReads++;
					return () => callbacks++;
				},
			},
		);
		expect([timeoutReads, signalReads, callbackReads]).toEqual([1, 1, 1]);
		service.respond(address(), "done");
		expect(await pending).toEqual({ status: "answered", value: "done" });
		controller.abort();
		expect(callbacks).toBe(0);
		let timeoutCallbackReads = 0;
		const timed = service.request(
			{ kind: "input", title: "timeout snapshot" },
			{
				timeout: 0,
				get onTimeout() {
					timeoutCallbackReads++;
					return timeoutCallbackReads === 1
						? () => callbacks++
						: () => {
								throw new Error("changed callback");
							};
				},
			},
		);
		expect(await timed).toEqual({ status: "cancelled", reason: "timeout" });
		expect(timeoutCallbackReads).toBe(1);
		expect(callbacks).toBe(1);
		expect(service.snapshot().pending).toEqual([]);
		const overridden = new AbortController();
		overridden.signal.addEventListener = () => {
			throw new Error("private add");
		};
		overridden.signal.removeEventListener = () => {
			throw new Error("private remove");
		};
		const cancellable = service.request({ kind: "input", title: "native signal" }, { signal: overridden.signal });
		overridden.abort();
		expect(await cancellable).toEqual({ status: "cancelled", reason: "aborted" });
		const lateAbort = new AbortController();
		expect(
			await service.request(
				{ kind: "input", title: "pre-aborted" },
				{
					signal: lateAbort.signal,
					get onTimeout() {
						lateAbort.abort();
						return undefined;
					},
				},
			),
		).toEqual({ status: "cancelled", reason: "aborted" });
		errorCode(
			() =>
				service.request(
					{ kind: "input", title: "invalid signal" },
					{
						signal: {} as AbortSignal,
					},
				),
			"invalid-request",
		);
		expect(service.snapshot().pending).toEqual([]);
		service.dispose();
	});

	it("rechecks capacity after an options getter reenters admission", async () => {
		const { service } = fixture();
		const pending: Promise<unknown>[] = [];
		let reads = 0;
		errorCode(
			() =>
				service.request(
					{ kind: "input", title: "outer" },
					{
						get timeout() {
							reads++;
							for (let i = 0; i < EXTENSION_INTERACTION_LIMITS.pending; i++)
								pending.push(service.request({ kind: "input", title: "inner" }));
							return undefined;
						},
					},
				),
			"capacity-exceeded",
		);
		expect(reads).toBe(1);
		expect(service.snapshot().pending).toHaveLength(EXTENSION_INTERACTION_LIMITS.pending);
		service.dispose();
		expect(await Promise.all(pending)).toEqual(
			Array.from({ length: EXTENSION_INTERACTION_LIMITS.pending }, () => ({
				status: "cancelled",
				reason: "disposed",
			})),
		);
	});

	it("handles abort and disposal during signal registration without leaving listeners or timers", async () => {
		for (const action of ["abort", "dispose", "disconnect"] as const) {
			const { service, connectionId } = fixture();
			const controller = new AbortController();
			const add = EventTarget.prototype.addEventListener;
			const remove = spyOn(EventTarget.prototype, "removeEventListener");
			const register = spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
				this: EventTarget,
				type,
				listener,
				options,
			) {
				if (this === controller.signal && type === "abort") {
					if (action === "abort") controller.abort();
					if (action === "dispose") service.dispose();
					if (action === "disconnect") service.disconnect(connectionId);
				}
				return add.call(this, type, listener, options);
			});
			let timeouts = 0;
			try {
				if (action === "disconnect") {
					errorCode(
						() =>
							service.request(
								{ kind: "input", title: action },
								{
									signal: controller.signal,
									timeout: 0,
									onTimeout: () => timeouts++,
								},
							),
						"unavailable",
					);
				} else {
					const pending = service.request(
						{ kind: "input", title: action },
						{
							signal: controller.signal,
							timeout: 0,
							onTimeout: () => timeouts++,
						},
					);
					expect(await pending).toEqual({
						status: "cancelled",
						reason: action === "abort" ? "aborted" : "disposed",
					});
				}
				expect(service.snapshot().pending).toEqual([]);
				expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
				expect(timeouts).toBe(0);
			} finally {
				register.mockRestore();
				remove.mockRestore();
				service.dispose();
			}
		}
	});

	it("preserves settlement when signal registration attaches, reenters and throws", async () => {
		for (const action of ["abort", "dispose", "pending"] as const) {
			for (const throwOnRemove of [false, true]) {
				const { service } = fixture();
				const controller = new AbortController();
				const nativeAdd = EventTarget.prototype.addEventListener;
				const nativeRemove = EventTarget.prototype.removeEventListener;
				let attached: unknown;
				let removed = false;
				const remove = spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (
					this: EventTarget,
					type,
					listener,
					options,
				) {
					nativeRemove.call(this, type, listener, options);
					if (this === controller.signal && type === "abort" && listener === attached) {
						removed = true;
						if (throwOnRemove) throw new Error("private cleanup error");
					}
				});
				const register = spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
					this: EventTarget,
					type,
					listener,
					options,
				) {
					nativeAdd.call(this, type, listener, options);
					if (this === controller.signal && type === "abort") {
						attached = listener;
						if (action === "abort") controller.abort();
						if (action === "dispose") service.dispose();
						throw new Error("private registration error");
					}
				});
				try {
					const request = () => service.request({ kind: "input", title: action }, { signal: controller.signal });
					if (action === "pending") {
						errorCode(request, "invalid-request");
					} else {
						expect(await request()).toEqual({
							status: "cancelled",
							reason: action === "abort" ? "aborted" : "disposed",
						});
					}
					expect(attached).not.toBeNull();
					expect(removed).toBe(true);
					expect(service.snapshot().pending).toEqual([]);
				} finally {
					register.mockRestore();
					remove.mockRestore();
					service.dispose();
				}
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

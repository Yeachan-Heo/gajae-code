import { describe, expect, it, spyOn } from "bun:test";
import { type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

const rect = (column = 0, row = 0, width = 2, height = 1) => ({ column, row, width, height });
const bytes = (value: string) => new TextEncoder().encode(value);
const request = (
	ownerId: string,
	r = rect(),
	erase = "ERASE",
	onInvalidated?: NonNullable<Parameters<TUI["acquireRasterLease"]>[0]["onInvalidated"]>,
): Parameters<TUI["acquireRasterLease"]>[0] => ({
	ownerId,
	rect: r,
	erase: { type: "raster-erase" as const, bytes: bytes(erase) },
	onInvalidated,
});

async function setup(showHardwareCursor?: boolean) {
	const terminal = new VirtualTerminal(10, 4);
	const tui = new TUI(terminal, showHardwareCursor);
	return { terminal, tui };
}

describe("TUI raster lease public boundary", () => {
	it("rejects invalid geometry and allows one overlapping lease only", async () => {
		const { tui } = await setup();
		const invalid = await tui.acquireRasterLease(request("bad", rect(9, 0, 2, 1)));
		expect(invalid.status).toBe("rejected");
		if (invalid.status !== "rejected") throw new Error("expected invalid geometry rejection");
		expect(invalid.reason).toBe("invalid-geometry");
		const first = await tui.acquireRasterLease(request("one"));
		expect(first.status).toBe("acquired");
		const conflict = await tui.acquireRasterLease(request("two", rect(1, 0, 2, 1)));
		expect(conflict.status).toBe("rejected");
		if (conflict.status !== "rejected") throw new Error("expected owner conflict rejection");
		expect(conflict.reason).toBe("owner-conflict");
		if (first.status === "acquired")
			expect(
				(
					await tui.submitTerminalOutput({
						operation: { type: "raster-probe", bytes: bytes("P") },
						token: first.token,
					})
				).status,
			).toBe("written");
	});

	it("rejects stale identity tokens without writing", async () => {
		const { tui, terminal } = await setup();
		const acquired = await tui.acquireRasterLease(request("owner"));
		if (acquired.status !== "acquired") throw new Error("lease not acquired");
		const stale = { ...acquired.token, rect: { ...acquired.token.rect } };
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: { type: "raster-erase", bytes: bytes("X") },
			token: stale,
		});
		expect(ack.status).toBe("stale-token");
		expect(terminal.getWriteLog()).toEqual([]);
	});

	it("writes multipart records as one terminal write", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("multipart"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: { type: "raster-multipart-batch", records: [bytes("A"), bytes("B"), bytes("C")] },
			token: lease.token,
		});
		expect(ack.status).toBe("written");
		expect(terminal.getWriteLog()).toEqual(["ABC"]);
	});
	it("writes multipart cursor guards atomically when no barrier is required", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("cursor-guard"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				prefix: bytes("SAVE"),
				records: [bytes("IMAGE")],
				suffix: bytes("RESTORE"),
			},
			token: lease.token,
		});
		expect(ack.status).toBe("written");
		expect(terminal.getWriteLog()).toEqual(["SAVEIMAGERESTORE"]);
	});
	it("restores tracked cursor visibility without moving it after multipart output", async () => {
		const { tui, terminal } = await setup(true);
		const lease = await tui.acquireRasterLease(request("cursor-reanchor"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				records: [bytes("IMAGE")],
				restoreCursorVisibility: true,
			},
			token: lease.token,
		});
		expect(ack.status).toBe("written");
		const output = terminal.getWriteLog().join("");
		expect(output).toStartWith("IMAGE");
		expect(output).not.toContain("\x1b[1;1H");
		expect(output).toEndWith("\x1b[?25h");
	});
	it("guards raster invalidation so erase placement cannot steal an active cursor", async () => {
		const { tui, terminal } = await setup(true);
		const component: Component = { render: () => [`input${CURSOR_MARKER}`], invalidate() {} };
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const lease = await tui.acquireRasterLease(request("active-cursor-erase"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();

		const ack = await tui.invalidateRasterLease({ token: lease.token, cause: "explicit" });
		expect(ack.status).toBe("written");
		const output = terminal.getWriteLog().join("");
		expect(output).toContain("\x1b[?2026h\x1b7\x1b[?25lERASE\x1b8");
		expect(output).not.toContain("\x1b[1;6H");
		expect(output).toEndWith("\x1b[?25h\x1b[?2026l");
		tui.stop();
	});
	it("writes prefix, awaits callback, then writes records within one queued operation", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("prefix-order"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		const order: string[] = [];
		(terminal as VirtualTerminal & { flush: () => Promise<boolean> }).flush = async () => {
			order.push("flush");
			return true;
		};
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			originalWrite(data);
			order.push(data === "P" ? "prefix" : "records");
		};
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				prefix: bytes("P"),
				afterPrefix: async () => {
					order.push("afterPrefix");
					return true;
				},
				records: [bytes("R")],
			},
			token: lease.token,
		});
		expect(ack.status).toBe("written");
		expect(order).toEqual(["prefix", "flush", "afterPrefix", "records"]);
		expect(terminal.getWriteLog()).toEqual(["P", "R"]);
	});
	it("replays only the post-barrier prefix and restores the cursor on success", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("barrier-cursor"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				prefix: bytes("SAVE+PLACE"),
				afterPrefix: async () => true,
				replayPrefix: bytes("PLACE"),
				records: [bytes("IMAGE")],
				suffix: bytes("RESTORE"),
				abortSuffix: bytes("RESTORE"),
			},
			token: lease.token,
		});
		expect(ack.status).toBe("written");
		expect(terminal.getWriteLog()).toEqual(["SAVE+PLACE", "PLACEIMAGERESTORE"]);
	});
	it("restores the cursor when a multipart barrier aborts", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("barrier-abort"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				prefix: bytes("SAVE+PLACE"),
				afterPrefix: async () => false,
				records: [bytes("IMAGE")],
				abortSuffix: bytes("RESTORE"),
			},
			token: lease.token,
		});
		expect(ack.status).toBe("failed");
		expect(terminal.getWriteLog()).toEqual(["SAVE+PLACE", "RESTORE"]);
	});
	it("does not write records when the prefix callback returns false or throws", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("prefix-failure"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		for (const afterPrefix of [
			async () => false,
			async () => {
				throw new Error("boom");
			},
		]) {
			terminal.clearWriteLog();
			const ack = await tui.submitTerminalOutput({
				operation: { type: "raster-multipart-batch", prefix: bytes("P"), afterPrefix, records: [bytes("R")] },
				token: lease.token,
			});
			expect(ack.status).toBe("failed");
			expect(terminal.getWriteLog()).toEqual(["P"]);
		}
	});
	it("flush failure does not invoke callback or write records", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("prefix-flush-failure"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		let callbackCalled = false;
		(terminal as VirtualTerminal & { flush: () => Promise<boolean> }).flush = async () => false;
		const ack = await tui.submitTerminalOutput({
			operation: {
				type: "raster-multipart-batch",
				prefix: bytes("P"),
				afterPrefix: async () => {
					callbackCalled = true;
					return true;
				},
				records: [bytes("R")],
			},
			token: lease.token,
		});
		expect(ack.status).toBe("failed");
		expect(callbackCalled).toBe(false);
		expect(terminal.getWriteLog()).toEqual(["P"]);
	});
	it("queues multipart records normally", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("multipart-queue"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.clearWriteLog();
		const pending = tui.submitTerminalOutput({
			operation: { type: "raster-multipart-batch", records: [bytes("P"), bytes("R")] },
			token: lease.token,
		});
		const interleaved = tui.queueTerminalOutput("I");
		expect(await pending).toMatchObject({ status: "written" });
		expect(await interleaved).toMatchObject({ status: "written" });
		expect(terminal.getWriteLog()).toEqual(["PR", "I"]);
	});

	it("invalidates on generic render with erase first and callback once", async () => {
		const { tui, terminal } = await setup();
		let calls = 0;
		const lease = await tui.acquireRasterLease(request("pet", rect(), "ERASE", () => calls++));
		expect(lease.status).toBe("acquired");
		const component: Component = { render: () => ["PAYLOAD"], invalidate() {} };
		tui.addChild(component);
		terminal.clearWriteLog();
		tui.start();
		await terminal.waitForRender();
		const output = terminal.getWriteLog().join("");
		expect(output.indexOf("ERASE")).toBeGreaterThanOrEqual(0);
		expect(output.indexOf("PAYLOAD")).toBeGreaterThan(output.indexOf("ERASE"));
		expect(calls).toBe(1);
		tui.stop();
	});
	it("clips a differential render around an active raster lease", async () => {
		const { tui, terminal } = await setup();
		let line = "abcdefghij";
		let calls = 0;
		const component: Component = { render: () => [line], invalidate() {} };
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const lease = await tui.acquireRasterLease(request("pet", rect(8, 0, 2, 1), "ERASE", () => calls++));
		expect(lease.status).toBe("acquired");
		terminal.clearWriteLog();
		line = "ABCDEFGHIJ";
		tui.requestRender();
		await terminal.waitForRender();

		const output = terminal.getWriteLog().join("");
		expect(output).not.toContain("ERASE");
		expect(output).not.toContain("\x1b[2K");
		expect(output).toContain("\x1b[1G\x1b[8X");
		expect(output).not.toContain("\r\n");
		expect(output).toContain("\x1b[?2026h\x1b[?25l");
		expect(output).toContain("\x1b[1;1H");
		expect(output).toContain("ABCDEFGH");
		expect(output).not.toContain("IJ");
		expect(calls).toBe(0);
		tui.stop();
	});
	it("keeps a raster lease while streaming appends content inside the viewport", async () => {
		const { tui, terminal } = await setup();
		let lines = ["first"];
		let calls = 0;
		const component: Component = { render: () => lines, invalidate() {} };
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const lease = await tui.acquireRasterLease(request("pet", rect(8, 3, 2, 1), "ERASE", () => calls++));
		expect(lease.status).toBe("acquired");
		terminal.clearWriteLog();
		lines = ["first", "second"];
		tui.requestRender();
		await terminal.waitForRender();

		const output = terminal.getWriteLog().join("");
		expect(output).not.toContain("ERASE");
		expect(calls).toBe(0);
		tui.stop();
	});
	it("repaints streaming overflow around the lease without erasing or re-uploading it", async () => {
		const { tui, terminal } = await setup();
		let lines = ["one", "two", "three", "four"];
		let calls = 0;
		const component: Component = { render: () => lines, invalidate() {} };
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const lease = await tui.acquireRasterLease(request("pet", rect(8, 3, 2, 1), "ERASE", () => calls++));
		expect(lease.status).toBe("acquired");
		terminal.clearWriteLog();
		lines = [...lines, "five"];
		tui.requestRender();
		await terminal.waitForRender();

		const output = terminal.getWriteLog().join("");
		expect(output).not.toContain("ERASE");
		expect(output).not.toContain("\r\n");
		expect(output).toContain("\x1b[1G\x1b[8X");
		expect(output).toContain("\x1b[1;1H");
		expect(output).toContain("\x1b[4;1H");
		expect(calls).toBe(0);
		tui.stop();
	});
	it("repaints rewritten streaming output without scrolling an active raster", async () => {
		const { tui, terminal } = await setup();
		let lines = ["one", "two", "three", "four"];
		const component: Component = { render: () => lines, invalidate() {} };
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const lease = await tui.acquireRasterLease(request("pet", rect(8, 3, 2, 1)));
		expect(lease.status).toBe("acquired");
		terminal.clearWriteLog();
		lines = ["ONE", "two", "three", "four", "five"];
		tui.requestRender();
		await terminal.waitForRender();

		const output = terminal.getWriteLog().join("");
		expect(output).not.toContain("ERASE");
		expect(output).not.toContain("\r\n");
		expect(output).toContain("\x1b[1;1H");
		expect(output).toContain("\x1b[4;1H");
		tui.stop();
	});

	it("rejects malformed and stale lifecycle notifications without touching pending cleanup", async () => {
		const { tui, terminal } = await setup();
		const lease = await tui.acquireRasterLease(request("owner"));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.failNextWrites();
		await tui.invalidateRasterLease({ token: lease.token, cause: "explicit" });
		const generation = tui.terminalGeneration;
		terminal.clearWriteLog();
		for (const event of [
			{ kind: "bad", source: "tui", terminalGeneration: generation },
			{ kind: "availability-restored", source: "bad", terminalGeneration: generation },
			{ kind: "availability-restored", source: "tui", terminalGeneration: null },
			{ kind: "availability-restored", source: "tui", terminalGeneration: -1 },
			{ kind: "availability-restored", source: "tui", terminalGeneration: 1.5 },
		] as unknown[]) {
			await expect(
				tui.notifyTerminalLifecycle(event as Parameters<TUI["notifyTerminalLifecycle"]>[0]),
			).rejects.toThrow(TypeError);
		}
		expect(
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: generation,
			}),
		).toEqual({ attempted: 1, written: 1, stillPending: 0 });
		expect(terminal.getWriteLog()).toHaveLength(1);
		expect(terminal.getWriteLog()[0]).toContain("\x1b[?25lERASE\x1b8");
	});

	it("rejects same-owner active and cleanup-pending conflicts", async () => {
		const { tui, terminal } = await setup();
		tui.start();
		const first = await tui.acquireRasterLease(request("owner", rect(0, 0, 2, 1)));
		if (first.status !== "acquired") throw new Error("lease not acquired");
		terminal.failNextWrites();
		await tui.invalidateRasterLease({ token: first.token, cause: "explicit" });
		const pending = await tui.acquireRasterLease(request("owner", rect(5, 0, 2, 1)));
		expect(pending.status).toBe("rejected");
	});

	it("retains failed cleanup, blocks reacquire, then reports retry counts", async () => {
		const { tui, terminal } = await setup();
		let calls = 0;
		const lease = await tui.acquireRasterLease(request("owner", rect(), "ERASE", () => calls++));
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		terminal.failNextWrites();
		expect((await tui.invalidateRasterLease({ token: lease.token, cause: "explicit" })).status).toBe("failed");
		const unavailable = await tui.acquireRasterLease(request("new"));
		expect(unavailable.status).toBe("rejected");
		if (unavailable.status !== "rejected") throw new Error("expected terminal unavailable rejection");
		expect(unavailable.reason).toBe("terminal-unavailable");
		tui.start();
		const firstGeneration = tui.terminalGeneration;
		terminal.failNextWrites();
		await Promise.resolve();
		expect(
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: firstGeneration,
			}),
		).toEqual({ attempted: 0, written: 0, stillPending: 0 });
		const unavailableAfterRetry = await tui.acquireRasterLease(request("new"));
		expect(unavailableAfterRetry.status).toBe("rejected");
		if (unavailableAfterRetry.status !== "rejected") throw new Error("expected terminal unavailable rejection");
		expect(unavailableAfterRetry.reason).toBe("terminal-unavailable");
		const component: Component = { render: () => ["PAYLOAD"], invalidate() {} };
		tui.addChild(component);
		terminal.clearWriteLog();
		tui.start();
		await Promise.resolve();
		tui.requestRender(true);
		await terminal.waitForRender();
		expect(
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: tui.terminalGeneration,
			}),
		).toEqual({ attempted: 0, written: 0, stillPending: 0 });
		expect(calls).toBe(1);
		expect((await tui.acquireRasterLease(request("new"))).status).toBe("acquired");
		await terminal.waitForRender();
		const output = terminal.getWriteLog().join("");
		expect(output.indexOf("ERASE")).toBeGreaterThanOrEqual(0);
		expect(output.indexOf("PAYLOAD")).toBeGreaterThan(output.indexOf("ERASE"));
	});

	it("retries two cleanup records independently and releases only recovered dependent FIFO work", async () => {
		const { tui, terminal } = await setup();
		const firstLease = await tui.acquireRasterLease(request("a", rect(0, 0, 2, 1), "A"));
		const secondLease = await tui.acquireRasterLease(request("b", rect(3, 0, 2, 1), "B"));
		if (firstLease.status !== "acquired" || secondLease.status !== "acquired") {
			throw new Error("leases not acquired");
		}
		terminal.failNextWrites();
		await tui.invalidateRasterLease({ token: firstLease.token, cause: "explicit" });
		await tui.invalidateRasterLease({ token: secondLease.token, cause: "explicit" });
		const first = tui.submitTerminalOutput({
			operation: { type: "generic-render", bytes: bytes("a-dependent"), rect: rect(0, 0, 2, 1) },
		});
		const second = tui.submitTerminalOutput({
			operation: { type: "generic-render", bytes: bytes("b-dependent"), rect: rect(3, 0, 2, 1) },
		});
		expect((await first).status).toBe("failed");
		expect((await second).status).toBe("failed");
		terminal.clearWriteLog();
		const originalWrite = terminal.write.bind(terminal);
		const writeSpy = spyOn(terminal, "write").mockImplementation(data => {
			if (data.includes("\x1b[?25lB\x1b8")) throw new Error("injected terminal write failure");
			originalWrite(data);
		});
		expect(
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: tui.terminalGeneration,
			}),
		).toEqual({ attempted: 2, written: 1, stillPending: 1 });
		expect(terminal.getWriteLog().filter(value => value === "a-dependent" || value === "b-dependent")).toEqual([
			"a-dependent",
		]);
		expect(terminal.getWriteLog()).toContain("a-dependent");
		expect(terminal.getWriteLog()).not.toContain("b-dependent");
		writeSpy.mockRestore();
	});
	it("automatically recovers FIFO disjoint cleanup before stale explicit lifecycle calls", async () => {
		const { tui, terminal } = await setup();
		const seen: string[] = [];
		for (const owner of ["a", "b"]) {
			const got = await tui.acquireRasterLease(
				request(owner, owner === "a" ? rect(0, 0, 2, 1) : rect(3, 0, 2, 1), owner.toUpperCase(), () =>
					seen.push(owner),
				),
			);
			if (got.status !== "acquired") throw new Error("lease not acquired");
			terminal.failNextWrites();
			await tui.invalidateRasterLease({ token: got.token, cause: "explicit" });
			tui.start();
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: tui.terminalGeneration,
			});
		}
		expect(seen).toEqual(["a", "b"]);
		expect(
			terminal
				.getWriteLog()
				.filter(value => value.includes("A") || value.includes("B"))
				.map(value => (value.includes("A") ? "A" : "B")),
		).toEqual(["A", "B"]);
		expect(
			await tui.notifyTerminalLifecycle({
				kind: "availability-restored",
				source: "tui",
				terminalGeneration: tui.terminalGeneration,
			}),
		).toEqual({ attempted: 0, written: 0, stillPending: 0 });
	});
});

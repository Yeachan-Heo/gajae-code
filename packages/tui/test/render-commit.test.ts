import { describe, expect, it, vi } from "bun:test";
import { Text } from "../src/components/text";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class SecondWriteFailureTerminal extends VirtualTerminal {
	#writes = 0;
	readonly attempts: string[] = [];

	override write(data: string): void {
		this.#writes += 1;
		this.attempts.push(data);
		if (this.#writes === 2) throw new Error("second renderer write failed");
		super.write(data);
	}
}
class FirstWriteFailureTerminal extends VirtualTerminal {
	override write(_data: string): void {
		throw new Error("shared renderer write failed");
	}
}

class CursorComponent implements Component {
	invalidate(): void {}

	render(): string[] {
		return [`cursor${CURSOR_MARKER}`];
	}
}

function createLifetimePayload(throws: boolean): { callback: () => void; payload: Uint8Array } {
	const payload = new Uint8Array(1024 * 1024);
	return {
		payload,
		callback: () => {
			payload[0]++;
			if (throws) throw new Error("lifetime preparation failure");
		},
	};
}

class LifetimeTUI extends TUI {
	// Positive control for the original enqueue-scope arrow's retained `this`.
	// Never invoked: the test checks its outgoing references, not its behavior.
	createRetainingControl(callback: () => void): () => void {
		return () => {
			this.requestRender();
			callback();
		};
	}
}

interface PreparationLifetimeFixture {
	mode: "cancel" | "complete" | "throw" | "stop" | "owner" | "dispose";
	preparationMemoryOwner: LifetimeTUI;
	preparationMemoryCallback: () => void;
	preparationMemoryPayload: Uint8Array;
	preparationMemoryHandle: () => void;
	preparationMemoryControl: () => void;
	generation: number;
	early: Promise<boolean>;
}

function expectPreparationReferencePaths(count: number, retained: boolean): void {
	// Bun's typed Inspector snapshot exposes JSC's four-word node/edge records:
	// WebKit Source/JavaScriptCore/heap/HeapSnapshotBuilder.cpp documents the layout;
	// runtime/JSLexicalEnvironment.cpp emits the captured-variable edges.
	// Inspect the local closure -> entry -> callback/cancel graph, NOT reachability
	// from GC roots. Module/global scopes, prototypes and VM structures are outside
	// this contract. All targets deliberately stay strongly rooted in the fixtures.
	const snapshot: Bun.HeapSnapshot = Bun.generateHeapSnapshot();
	expect(snapshot.type).toBe("Inspector");
	expect(snapshot.nodes.length % 4).toBe(0);
	expect(snapshot.edges.length % 4).toBe(0);
	const classes = new Map<number, string>();
	for (let index = 0; index < snapshot.nodes.length; index += 4) {
		classes.set(snapshot.nodes[index], snapshot.nodeClassNames[snapshot.nodes[index + 2]]);
	}
	const outgoing = new Map<number, number[]>();
	const fixtures = new Map<number, Map<string, number>>();
	for (let index = 0; index < snapshot.edges.length; index += 4) {
		const from = snapshot.edges[index];
		const to = snapshot.edges[index + 1];
		const type = snapshot.edgeTypes[snapshot.edges[index + 2]];
		const name = snapshot.edgeNames[snapshot.edges[index + 3]];
		if (type === "Property" && name?.startsWith("preparationMemory")) {
			let fields = fixtures.get(from);
			if (!fields) {
				fields = new Map();
				fixtures.set(from, fields);
			}
			fields.set(name, to);
		}
		const fromClass = classes.get(from);
		if (
			(fromClass === "Function" && classes.get(to) === "JSLexicalEnvironment") ||
			fromClass === "JSLexicalEnvironment" ||
			(fromClass === "Object" && type === "Property" && (name === "callback" || name === "cancel"))
		) {
			let targets = outgoing.get(from);
			if (!targets) {
				targets = [];
				outgoing.set(from, targets);
			}
			targets.push(to);
		}
	}
	const reachable = (start: number): Set<number> => {
		const seen = new Set<number>([start]);
		for (const from of seen) {
			for (const to of outgoing.get(from) ?? []) seen.add(to);
		}
		return seen;
	};
	expect(fixtures.size).toBe(count);
	for (const fields of fixtures.values()) {
		expect(fields.size).toBe(5);
		const handle = reachable(fields.get("preparationMemoryHandle")!);
		const control = reachable(fields.get("preparationMemoryControl")!);
		for (const name of ["preparationMemoryOwner", "preparationMemoryCallback", "preparationMemoryPayload"]) {
			const target = fields.get(name)!;
			// Fail closed if this engine's graph cannot expose a known retaining arrow.
			expect(control.has(target)).toBe(true);
			expect(handle.has(target)).toBe(retained);
		}
	}
}

describe("generation-scoped render commits", () => {
	it("severs retired cancellation paths to callbacks, payloads and owners without relying on collection", async () => {
		const fixtures: PreparationLifetimeFixture[] = [];
		try {
			for (const mode of ["cancel", "complete", "throw", "stop", "owner", "dispose"] as const) {
				const terminal = new VirtualTerminal(40, 8);
				const tui = new LifetimeTUI(terminal);
				const { callback, payload } = createLifetimePayload(mode === "throw");
				fixtures.push({
					mode,
					preparationMemoryOwner: tui,
					preparationMemoryCallback: callback,
					preparationMemoryPayload: payload,
					preparationMemoryHandle: () => {},
					preparationMemoryControl: tui.createRetainingControl(callback),
					generation: 0,
					early: Promise.resolve(false),
				});
				tui.start();
				await terminal.waitForRender();
			}
			// No await between enqueue, the pending graph and synchronous retirement:
			// another fixture's preparation must not run before its chosen lifecycle.
			for (const fixture of fixtures) {
				const tui = fixture.preparationMemoryOwner;
				fixture.generation = tui.requestRenderWithGeneration() + 1;
				fixture.preparationMemoryHandle = tui.enqueueBeforeRender(fixture.preparationMemoryCallback);
			}
			expectPreparationReferencePaths(fixtures.length, true);
			for (const fixture of fixtures) {
				const tui = fixture.preparationMemoryOwner;
				// Snapshot cost must not consume a commit waiter's timeout budget.
				fixture.early = tui.waitForRenderCommit(fixture.generation);
				if (fixture.mode === "cancel") fixture.preparationMemoryHandle();
				else if (fixture.mode === "stop") tui.stop();
				else if (fixture.mode === "owner") {
					tui.setRenderPreparationLifecycleCallbacks({ invalidate() {}, beforeStart() {} });
				} else if (fixture.mode === "dispose") tui.dispose();
			}
			for (const fixture of fixtures) {
				const tui = fixture.preparationMemoryOwner;
				if (fixture.mode !== "stop" && fixture.mode !== "dispose") {
					expect(await tui.waitForRenderCommit(tui.requestRenderWithGeneration(true))).toBe(true);
				}
				const committed = fixture.mode === "cancel" || fixture.mode === "complete";
				expect(await fixture.early).toBe(committed);
				expect(await tui.waitForRenderCommit(fixture.generation)).toBe(committed);
				expect(fixture.preparationMemoryPayload[0]).toBe(
					fixture.mode === "complete" || fixture.mode === "throw" ? 1 : 0,
				);
			}
			expectPreparationReferencePaths(fixtures.length, false);
			for (const fixture of fixtures) {
				fixture.preparationMemoryHandle();
				fixture.preparationMemoryHandle();
				fixture.preparationMemoryOwner.stop();
				fixture.preparationMemoryOwner.dispose();
				fixture.preparationMemoryHandle();
				fixture.preparationMemoryHandle();
			}
		} finally {
			for (const fixture of fixtures) {
				fixture.preparationMemoryOwner.stop();
				fixture.preparationMemoryOwner.dispose();
			}
		}
	});

	it("retires 1000 nested lifecycle holes without changing current or historical outcomes", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const history: Array<{ generation: number; committed: boolean }> = [];
		const retainedHandles: Array<() => void> = [];
		let failedRanges = 0;
		tui.start();
		await terminal.waitForRender();
		try {
			for (let cycle = 0; cycle < 1000; cycle++) {
				let nested = 0;
				let current = 0;
				let calls = 0;
				let cancel = () => {};
				let early: Promise<boolean> | undefined;
				tui.enqueueBeforeRender(() => {
					const preceding = tui.requestRenderWithGeneration();
					cancel = tui.enqueueBeforeRender(() => {
						calls++;
					});
					nested = preceding + 1;
					early = tui.waitForRenderCommit(nested);
					current = tui.requestRenderWithGeneration();
				});
				tui.requestRender(true);
				const { promise, resolve } = Promise.withResolvers<void>();
				process.nextTick(resolve);
				await promise;
				expect(await tui.waitForRenderCommit(current)).toBe(true);
				expect(calls).toBe(0);
				expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 1, holes: 1, failedRanges });
				const committed = cycle % 4 < 2;
				if (cycle % 4 === 0) {
					cancel();
					cancel();
				} else if (cycle % 4 === 2) {
					tui.stop();
					tui.start();
					failedRanges++;
				} else if (cycle % 4 === 3) {
					tui.setRenderPreparationLifecycleCallbacks({ invalidate() {}, beforeStart() {} });
					failedRanges++;
				}
				const final = tui.requestRenderWithGeneration(true);
				expect(await tui.waitForRenderCommit(final)).toBe(true);
				expect(await early).toBe(committed);
				expect(await tui.waitForRenderCommit(nested)).toBe(committed);
				expect(calls).toBe(cycle % 4 === 1 ? 1 : 0);
				retainedHandles.push(cancel);
				cancel();
				cancel();
				history.push({ generation: nested, committed }, { generation: current, committed: true });
				expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 0, holes: 0, failedRanges });
				terminal.clearWriteLog();
			}
			for (const cancel of retainedHandles) {
				cancel();
				cancel();
			}
			for (const { generation, committed } of history) {
				expect(await tui.waitForRenderCommit(generation)).toBe(committed);
			}
			expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 0, holes: 0, failedRanges: 500 });
		} finally {
			tui.stop();
			tui.dispose();
		}
	}, 20_000);

	it("quiesces a pending normal timer on dispose without stop and rejects later scheduling", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.addChild(new Text("initial", 0, 0));
		tui.start();
		await terminal.waitForRender();
		vi.useFakeTimers();
		const timers = vi.spyOn(globalThis, "setTimeout");
		const stale = vi.fn();
		try {
			tui.enqueueBeforeRender(stale);
			await new Promise<void>(resolve => process.nextTick(resolve));
			expect(timers).toHaveBeenCalled();
			tui.dispose();
			await Promise.resolve();
			const writes = terminal.getWriteLog();
			timers.mockClear();
			vi.advanceTimersByTime(1000);
			tui.requestRender();
			tui.requestRender(true);
			tui.requestRender(false, "input");
			tui.requestLayoutRender();
			tui.enqueueBeforeRender(stale);
			await new Promise<void>(resolve => process.nextTick(resolve));
			vi.advanceTimersByTime(1000);
			expect(timers).not.toHaveBeenCalled();
			expect(stale).not.toHaveBeenCalled();
			expect(terminal.getWriteLog()).toEqual(writes);
			expect(await tui.waitForRenderCommit(tui.requestRenderWithGeneration())).toBe(false);
		} finally {
			timers.mockRestore();
			vi.useRealTimers();
			// Deliberately do not call stop(): disposal must quiesce the scheduler itself.
		}
	});

	it("compacts retired batches across failures, owner replacement and restart without losing late outcomes", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.addChild(new Text("retirement", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const failed: number[] = [];
		const successful: number[] = [];
		try {
			for (let cycle = 0; cycle < 12; cycle++) {
				const base = tui.requestRenderWithGeneration();
				const early: Promise<boolean>[] = [];
				for (let index = 1; index <= 32; index++) {
					tui.enqueueBeforeRender(() => {
						throw new Error("retired batch");
					});
					failed.push(base + index);
					early.push(tui.waitForRenderCommit(base + index));
				}
				if (cycle % 3 === 0) {
					tui.setRenderPreparationLifecycleCallbacks({ invalidate() {}, beforeStart() {} });
				} else if (cycle % 3 === 1) {
					tui.stop();
					tui.start();
				}
				const committed = tui.requestRenderWithGeneration(true);
				expect(await tui.waitForRenderCommit(committed)).toBe(true);
				successful.push(committed);
				expect(await Promise.all(early)).toEqual(Array(32).fill(false));
				// Every contiguous failed batch occupies one range, not 32 exclusions.
				expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 0, holes: 0, failedRanges: cycle + 1 });
			}
			for (const generation of failed) expect(await tui.waitForRenderCommit(generation)).toBe(false);
			for (const generation of successful) expect(await tui.waitForRenderCommit(generation)).toBe(true);
			// Historical failures are not reintroduced into the next frame's pending set.
			expect(await tui.waitForRenderCommit(tui.requestRenderWithGeneration(true))).toBe(true);
			expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 0, holes: 0, failedRanges: 12 });
		} finally {
			tui.stop();
		}
	});

	it("uses the normal frame clock and reads only the prepared component state", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		let value = "old";
		const reads: string[] = [];
		tui.addChild({
			invalidate() {},
			render() {
				reads.push(value);
				return [value];
			},
		});
		tui.start();
		await terminal.waitForRender();
		reads.length = 0;
		try {
			tui.enqueueBeforeRender(() => {
				value = "normal prepared";
				tui.requestRender();
			});
			const generation = tui.requestRenderWithGeneration();
			await new Promise<void>(resolve => process.nextTick(resolve));
			expect(reads).toEqual([]);
			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(reads).toEqual(["normal prepared"]);
			expect(terminal.getWriteLog().join("")).toContain("normal prepared");
		} finally {
			tui.stop();
		}
	});

	it("invalidates pending and captured work on terminal loss and rejects enqueue while stopped", async () => {
		class AvailabilityTerminal extends VirtualTerminal {
			live = true;
			override get available(): boolean {
				return this.live;
			}
		}
		const terminal = new AvailabilityTerminal(40, 8);
		const tui = new TUI(terminal);
		const invalidate = vi.fn();
		const stale = vi.fn();
		tui.setRenderPreparationLifecycleCallbacks({ invalidate, beforeStart() {} });
		tui.start();
		await terminal.waitForRender();
		tui.enqueueBeforeRender(() => {
			terminal.live = false;
		});
		tui.enqueueBeforeRender(stale);
		const generation = tui.requestRenderWithGeneration(true);
		expect(await tui.waitForRenderCommit(generation)).toBe(false);
		expect(invalidate).toHaveBeenCalledTimes(1);
		tui.enqueueBeforeRender(stale);
		terminal.live = true;
		tui.start();
		await terminal.waitForRender();
		expect(stale).not.toHaveBeenCalled();
		tui.stop();
	});

	it("fences a render queued behind held raster ingress when disposed", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const text = new Text("initial", 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();
		const lease = await tui.acquireRasterLease({
			ownerId: "dispose-held-raster",
			rect: { column: 0, row: 0, width: 2, height: 1 },
			erase: { type: "raster-erase", bytes: new TextEncoder().encode("DISPOSE_ERASE") },
		});
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		const ingressGate = Promise.withResolvers<void>();
		const ingressStarted = Promise.withResolvers<void>();
		let disposed = false;
		const held = tui.submitTerminalOutput({
			token: lease.token,
			operation: {
				type: "raster-multipart-batch",
				prefix: new TextEncoder().encode("DISPOSE_PREFIX"),
				afterPrefix: async () => {
					ingressStarted.resolve();
					await ingressGate.promise;
					return true;
				},
				records: [new TextEncoder().encode("DISPOSE_RASTER")],
				abortSuffix: new TextEncoder().encode("DISPOSE_STALE_ABORT"),
			},
		});
		try {
			await ingressStarted.promise;
			terminal.clearWriteLog();
			text.setText("DISPOSE_STALE_RENDER");
			const generation = tui.requestRenderWithGeneration(true, "test.dispose-held-raster");
			const committed = tui.waitForRenderCommit(generation);
			// Let the forced frame capture its write closure behind the held ingress.
			const renderQueued = Promise.withResolvers<void>();
			process.nextTick(renderQueued.resolve);
			await renderQueued.promise;
			tui.dispose();
			disposed = true;
			expect(await committed).toBe(false);
			ingressGate.resolve();
			expect((await held).status).toBe("failed");
			await terminal.waitForRender();
			const output = terminal.getWriteLog().join("");
			expect(output).not.toContain("DISPOSE_STALE_RENDER");
			expect(output).not.toContain("DISPOSE_STALE_ABORT");
			expect(output).not.toContain("DISPOSE_RASTER");
		} finally {
			ingressGate.resolve();
			await held;
			if (!disposed) tui.stop();
		}
	});

	it("fences a render queued behind held raster ingress across terminal loss and restart", async () => {
		class AvailabilityTerminal extends VirtualTerminal {
			live = true;
			override get available(): boolean {
				return this.live;
			}
		}
		const terminal = new AvailabilityTerminal(40, 8);
		const tui = new TUI(terminal);
		const text = new Text("initial", 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();
		const lease = await tui.acquireRasterLease({
			ownerId: "loss-held-raster",
			rect: { column: 0, row: 0, width: 2, height: 1 },
			erase: { type: "raster-erase", bytes: new TextEncoder().encode("LOSS_ERASE") },
		});
		if (lease.status !== "acquired") throw new Error("lease not acquired");
		const ingressGate = Promise.withResolvers<void>();
		const ingressStarted = Promise.withResolvers<void>();
		const held = tui.submitTerminalOutput({
			token: lease.token,
			operation: {
				type: "raster-multipart-batch",
				prefix: new TextEncoder().encode("LOSS_PREFIX"),
				afterPrefix: async () => {
					ingressStarted.resolve();
					await ingressGate.promise;
					return true;
				},
				records: [new TextEncoder().encode("LOSS_RASTER")],
				abortSuffix: new TextEncoder().encode("LOSS_STALE_ABORT"),
			},
		});
		try {
			await ingressStarted.promise;
			terminal.clearWriteLog();
			text.setText("LOSS_STALE_RENDER");
			const generation = tui.requestRenderWithGeneration(true, "test.loss-held-raster");
			const committed = tui.waitForRenderCommit(generation);
			// Let the forced frame capture its write closure behind the held ingress.
			const renderQueued = Promise.withResolvers<void>();
			process.nextTick(renderQueued.resolve);
			await renderQueued.promise;
			terminal.live = false;
			const invalidatedGeneration = tui.requestRenderWithGeneration(true, "test.loss-held-raster.invalidate");
			expect(await committed).toBe(false);
			expect(await tui.waitForRenderCommit(invalidatedGeneration)).toBe(false);
			text.setText("LOSS_FRESH_RENDER");
			terminal.live = true;
			tui.start();
			terminal.clearWriteLog();
			ingressGate.resolve();
			expect((await held).status).toBe("failed");
			await terminal.waitForRender();
			const output = terminal.getWriteLog().join("");
			expect(output).not.toContain("LOSS_STALE_RENDER");
			expect(output).not.toContain("LOSS_STALE_ABORT");
			expect(output).not.toContain("LOSS_RASTER");
			expect(output).toContain("LOSS_FRESH_RENDER");
		} finally {
			ingressGate.resolve();
			await held;
			tui.stop();
		}
	});

	it("does not call beforeStart when terminal setup fails", () => {
		class FailedStartTerminal extends VirtualTerminal {
			override start(): void {
				throw new Error("setup failed");
			}
		}
		const tui = new TUI(new FailedStartTerminal(40, 8));
		const beforeStart = vi.fn();
		tui.setRenderPreparationLifecycleCallbacks({ invalidate() {}, beforeStart });
		expect(() => tui.start()).toThrow("setup failed");
		expect(beforeStart).not.toHaveBeenCalled();
		tui.dispose();
	});

	it("prepares the first start frame and discards work from a throwing beforeStart", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const reads: string[] = [];
		let value = "old";
		tui.addChild({
			invalidate() {},
			render() {
				reads.push(value);
				return [value];
			},
		});
		const stale = vi.fn();
		tui.setRenderPreparationLifecycleCallbacks({
			invalidate() {},
			beforeStart() {
				expect(tui.terminalAvailable).toBe(true);
				tui.enqueueBeforeRender(() => {
					value = "first frame fresh";
				});
			},
		});
		tui.start();
		await terminal.waitForRender();
		expect(reads).toEqual(["first frame fresh"]);
		tui.stop();
		tui.setRenderPreparationLifecycleCallbacks({
			invalidate() {},
			beforeStart() {
				tui.enqueueBeforeRender(stale);
				throw new Error("beforeStart failure");
			},
		});
		tui.start();
		tui.requestRender(true);
		await terminal.waitForRender();
		expect(stale).not.toHaveBeenCalled();
		tui.stop();
	});

	for (const queuedWrite of [false, true]) {
		it(`keeps nested preparation out of the current high-water commit (queued write: ${queuedWrite})`, async () => {
			const terminal = new VirtualTerminal(40, 8);
			const tui = new TUI(terminal);
			const text = new Text("initial", 0, 0);
			tui.addChild(text);
			tui.start();
			await terminal.waitForRender();
			let nestedGeneration = 0;
			let currentGeneration = 0;
			let nestedRan = false;
			let nestedSettled = false;
			let nestedWait: Promise<boolean> | undefined;
			try {
				tui.enqueueBeforeRender(() => {
					const preceding = tui.requestRenderWithGeneration();
					tui.enqueueBeforeRender(() => {
						nestedRan = true;
						text.setText("next preparation");
					});
					nestedGeneration = preceding + 1;
					text.setText("current preparation");
					currentGeneration = tui.requestRenderWithGeneration();
					nestedWait = tui.waitForRenderCommit(nestedGeneration).then(result => {
						nestedSettled = true;
						return result;
					});
					if (queuedWrite) void tui.queueTerminalCleanup("");
				});
				tui.requestRender(true);
				await new Promise<void>(resolve => process.nextTick(resolve));
				expect(await tui.waitForRenderCommit(currentGeneration)).toBe(true);
				expect(terminal.getWriteLog().join("")).toContain("current preparation");
				expect(nestedRan).toBe(false);
				expect(nestedSettled).toBe(false);
				expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 1, holes: 1, failedRanges: 0 });
				let lateSettled = false;
				const lateWait = tui.waitForRenderCommit(nestedGeneration).then(result => {
					lateSettled = true;
					return result;
				});
				await Promise.resolve();
				expect(lateSettled).toBe(false);
				expect(await nestedWait).toBe(true);
				expect(await lateWait).toBe(true);
				expect(nestedRan).toBe(true);
				expect(terminal.getWriteLog().join("")).toContain("next preparation");
				expect(tui.getRenderPreparationStateForTest()).toEqual({ pending: 0, holes: 0, failedRanges: 0 });
			} finally {
				tui.stop();
			}
		});
	}

	it("cancels captured entries and isolates throwing preparation without an extra request-only frame", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		let value = "initial";
		const renders: string[] = [];
		tui.addChild({
			invalidate() {},
			render() {
				renders.push(value);
				return [value];
			},
		});
		tui.start();
		await terminal.waitForRender();
		renders.length = 0;
		const cancelled = vi.fn();
		let cancel = () => {};
		let failedGeneration = 0;
		try {
			tui.enqueueBeforeRender(() => {
				cancel();
				cancel();
			});
			cancel = tui.enqueueBeforeRender(cancelled);
			const preceding = tui.requestRenderWithGeneration();
			tui.enqueueBeforeRender(() => {
				throw new Error("preparation test failure");
			});
			failedGeneration = preceding + 1;
			tui.enqueueBeforeRender(() => {
				value = "prepared";
				tui.requestRenderWithGeneration();
			});
			const generation = tui.requestRenderWithGeneration(true);
			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(cancelled).not.toHaveBeenCalled();
			expect(renders).toEqual(["prepared"]);
			expect(await tui.waitForRenderCommit(failedGeneration, 25)).toBe(false);
			expect(renders).toEqual(["prepared"]);
		} finally {
			tui.stop();
		}
	});

	it("invalidates the captured snapshot across synchronous stop/start and rearms only fresh work", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const text = new Text("initial", 0, 0);
		tui.addChild(text);
		const stale = vi.fn();
		const invalidate = vi.fn();
		const beforeStart = vi.fn(() => tui.enqueueBeforeRender(() => text.setText("fresh restart")));
		tui.setRenderPreparationLifecycleCallbacks({ invalidate, beforeStart });
		tui.start();
		await terminal.waitForRender();
		try {
			tui.enqueueBeforeRender(() => {
				tui.stop();
				tui.start();
			});
			tui.enqueueBeforeRender(stale);
			tui.requestRender(true);
			await new Promise<void>(resolve => process.nextTick(resolve));
			await terminal.waitForRender();
			expect(stale).not.toHaveBeenCalled();
			expect(invalidate).toHaveBeenCalledTimes(1);
			expect(beforeStart).toHaveBeenCalledTimes(2);
			expect(terminal.getWriteLog().join("")).toContain("fresh restart");
		} finally {
			tui.stop();
		}
	});

	it("drops old-owner and disposed work even when invalidation throws", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		await terminal.waitForRender();
		const stale = vi.fn();
		const fresh = vi.fn();
		const invalidate = vi.fn(() => {
			throw new Error("invalidation test failure");
		});
		tui.setRenderPreparationLifecycleCallbacks({ invalidate, beforeStart() {} });
		tui.enqueueBeforeRender(stale);
		tui.setRenderPreparationLifecycleCallbacks({ invalidate() {}, beforeStart() {} });
		tui.enqueueBeforeRender(fresh);
		expect(await tui.waitForRenderCommit(tui.requestRenderWithGeneration(true))).toBe(true);
		expect(stale).not.toHaveBeenCalled();
		expect(fresh).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		tui.enqueueBeforeRender(stale);
		tui.setRenderPreparationLifecycleCallbacks(undefined);
		tui.enqueueBeforeRender(stale);
		tui.dispose();
		tui.enqueueBeforeRender(stale);
		tui.start();
		await new Promise<void>(resolve => process.nextTick(resolve));
		expect(stale).not.toHaveBeenCalled();
		tui.stop();
	});

	it("resolves after the requested generation writes successfully", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.addChild(new Text("resume-progress", 1, 0));

		const generation = tui.requestRenderWithGeneration(false, "test.resume-progress");
		expect(await tui.waitForRenderCommit(generation)).toBe(true);
		expect(terminal.getWriteLog().join(" ")).toContain("resume-progress");

		tui.stop();
	});
	it("does not commit a failed shared frame in either framing mode", async () => {
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
				const terminal = new FirstWriteFailureTerminal(40, 8);
				const tui = new TUI(terminal);
				tui.addChild(new Text("failed-frame", 1, 0));
				const overlay = vi.fn(() => "\x1b[?25l");
				tui.setPostRenderEmitter(overlay);
				try {
					tui.start();
					const generation = tui.requestRenderWithGeneration(true, "test.shared-write-failure");
					expect(await tui.waitForRenderCommit(generation)).toBe(false);
					expect(tui.terminalAvailable).toBe(false);
					expect(overlay).not.toHaveBeenCalled();
				} finally {
					tui.stop();
				}
			}
		} finally {
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});
	it("commits the shared frame when optional IME reanchoring fails in both framing modes", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		setTerminalImageProtocol(null);

		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
				const terminal = new SecondWriteFailureTerminal(40, 8);
				const tui = new TUI(terminal, false);
				tui.addChild(new CursorComponent());
				try {
					tui.start();
					const generation = tui.requestRenderWithGeneration(false, "test.ime-cursor-failure");
					expect(await tui.waitForRenderCommit(generation)).toBe(true);
					expect(tui.terminalAvailable).toBe(false);
				} finally {
					tui.stop();
				}
			}
		} finally {
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});

	it("keeps the standalone IME cursor write outside synchronized framing", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		setTerminalImageProtocol(null);
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.addChild(new CursorComponent());

		try {
			tui.start();
			await terminal.waitForRender();
			const writes = terminal.getWriteLog();
			const sharedFrameIndex = writes.findIndex(
				write => write.startsWith("\x1b[?2026h") && write.endsWith("\x1b[?2026l"),
			);
			expect(sharedFrameIndex).toBeGreaterThanOrEqual(0);
			expect(writes[sharedFrameIndex + 1]).not.toContain("\x1b[?2026h");
			expect(writes[sharedFrameIndex + 1]).not.toContain("\x1b[?2026l");
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});

	it("commits the shared frame when optional overlay delivery fails in both framing modes", async () => {
		const previousSync = Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
		const previousImageProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);

		try {
			for (const synchronizedOutput of [undefined, "0"]) {
				if (synchronizedOutput === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
				else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = synchronizedOutput;
				const terminal = new SecondWriteFailureTerminal(40, 8);
				const tui = new TUI(terminal, true);
				tui.addChild(new Text("overlay-frame", 1, 0));
				tui.setPostRenderEmitter(() => "\x1b[?25l");
				try {
					tui.start();
					const generation = tui.requestRenderWithGeneration(false, "test.overlay-failure");
					expect(await tui.waitForRenderCommit(generation)).toBe(true);
					expect(tui.terminalAvailable).toBe(false);
					const attemptsAfterFailure = terminal.attempts.length;
					const retryGeneration = tui.requestRenderWithGeneration(true, "test.overlay-failure-no-replay");
					expect(await tui.waitForRenderCommit(retryGeneration)).toBe(false);
					expect(terminal.attempts).toHaveLength(attemptsAfterFailure);
				} finally {
					tui.stop();
				}
			}
		} finally {
			setTerminalImageProtocol(previousImageProtocol);
			if (previousSync === undefined) delete Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT;
			else Bun.env.GJC_TUI_SYNCHRONIZED_OUTPUT = previousSync;
		}
	});

	it("fails open immediately after the renderer is stopped", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.stop();

		const generation = tui.requestRenderWithGeneration(false, "test.stopped");
		expect(await tui.waitForRenderCommit(generation)).toBe(false);
	});
});

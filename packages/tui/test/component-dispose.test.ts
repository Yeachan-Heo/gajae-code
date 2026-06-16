import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, Container, Loader, type TUI } from "@gajae-code/tui";

/** Component that records how many times dispose() was called. */
class DisposeSpy implements Component {
	disposeCount = 0;
	invalidate(): void {}
	render(_width: number): string[] {
		return ["spy"];
	}
	dispose(): void {
		this.disposeCount += 1;
	}
}

describe("Container disposal lifecycle (W2 / F11)", () => {
	it("disposes children on clear() and removeChild(), once each", () => {
		const container = new Container();
		const a = new DisposeSpy();
		const b = new DisposeSpy();
		container.addChild(a);
		container.addChild(b);

		container.removeChild(a);
		expect(a.disposeCount).toBe(1);
		expect(b.disposeCount).toBe(0);

		container.clear();
		expect(b.disposeCount).toBe(1);
	});

	it("does NOT dispose on detachChild()/detachAll() (detach != dispose)", () => {
		const container = new Container();
		const a = new DisposeSpy();
		const b = new DisposeSpy();
		container.addChild(a);
		container.addChild(b);

		container.detachChild(a);
		expect(a.disposeCount).toBe(0);
		expect(container.children).not.toContain(a);

		container.detachAll();
		expect(b.disposeCount).toBe(0);
		expect(container.children.length).toBe(0);
	});

	it("recursively disposes nested children via dispose()", () => {
		const outer = new Container();
		const inner = new Container();
		const leaf = new DisposeSpy();
		inner.addChild(leaf);
		outer.addChild(inner);

		outer.dispose();
		expect(leaf.disposeCount).toBe(1);
	});

	it("dispose() is idempotent (no double child-dispose)", () => {
		const container = new Container();
		const a = new DisposeSpy();
		container.addChild(a);

		container.dispose();
		container.dispose();
		expect(a.disposeCount).toBe(1);
	});

	it("supports rebuild-from-map: detachAll + re-add reused instances never disposes them", () => {
		// Mirrors the hook-widget / pending-component rebuild pattern: persistent
		// instances live in a map and are re-rendered into a container repeatedly.
		// The container must DETACH (not dispose) on each rebuild; disposal is the
		// owner's job on explicit removal.
		const container = new Container();
		const persistent = new DisposeSpy();
		for (let rebuild = 0; rebuild < 5; rebuild++) {
			container.detachAll();
			container.addChild(persistent);
		}
		expect(persistent.disposeCount).toBe(0);

		container.removeChild(persistent);
		expect(persistent.disposeCount).toBe(1);
	});
});

describe("Loader timer cleanup on disposing clear (W2 / F12 mechanism)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops the animation interval when its container is cleared", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const container = new Container();
		// Time-varying spinner colorizer forces a text change every tick, so each
		// interval tick requests a render (mirrors the tool-execution spinner that
		// previously leaked and re-rendered the whole transcript forever).
		let tick = 0;
		const loader = new Loader(
			ui,
			frame => `${frame}${tick++}`,
			msg => msg,
			"loading",
		);
		container.addChild(loader);

		vi.advanceTimersByTime(64);
		const beforeClear = requestRender.mock.calls.length;
		expect(beforeClear).toBeGreaterThan(0);

		container.clear(); // disposes the loader -> stop() -> clearInterval

		vi.advanceTimersByTime(400);
		expect(requestRender.mock.calls.length).toBe(beforeClear);

		// dispose() is idempotent / safe to call again.
		loader.dispose();
		vi.advanceTimersByTime(400);
		expect(requestRender.mock.calls.length).toBe(beforeClear);
	});
});

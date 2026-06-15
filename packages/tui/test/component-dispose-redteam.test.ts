import { afterEach, describe, expect, it, vi } from "bun:test";
import { Box, type Component, Container, Loader, type TUI } from "@gajae-code/tui";

class ProbeComponent implements Component {
	disposeCount = 0;
	readonly childContainer?: Container;

	constructor(
		private readonly label: string,
		childContainer?: Container,
	) {
		this.childContainer = childContainer;
	}

	invalidate(): void {
		this.childContainer?.invalidate();
	}

	render(width: number): string[] {
		const ownLine = `${this.label}:${width}`;
		const childLines = this.childContainer?.render(width) ?? [];
		return [ownLine, ...childLines];
	}

	dispose(): void {
		this.disposeCount += 1;
		this.childContainer?.dispose();
	}
}

describe("component disposal lifecycle red-team", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("dispose releases resources without emptying children and detached/readded children still render", () => {
		const container = new Container();
		const detachedThenReadded = new ProbeComponent("reuse");
		const stable = new ProbeComponent("stable");

		container.addChild(detachedThenReadded);
		container.detachChild(detachedThenReadded);
		expect(detachedThenReadded.disposeCount).toBe(0);
		container.addChild(stable);
		container.addChild(detachedThenReadded);

		container.dispose();

		expect(container.children).toHaveLength(2);
		expect(stable.disposeCount).toBe(1);
		expect(detachedThenReadded.disposeCount).toBe(1);
		expect(container.render(12)).toEqual(["stable:12", "reuse:12"]);
	});

	it("detachChild and detachAll remove children without disposing them", () => {
		const container = new Container();
		const one = new ProbeComponent("one");
		const two = new ProbeComponent("two");
		const three = new ProbeComponent("three");

		container.addChild(one);
		container.addChild(two);
		container.addChild(three);
		container.detachChild(two);
		container.detachAll();

		expect(one.disposeCount).toBe(0);
		expect(two.disposeCount).toBe(0);
		expect(three.disposeCount).toBe(0);
		expect(container.children).toHaveLength(0);
	});

	it("removeChild and clear dispose present children exactly once and repeated calls stay safe", () => {
		const container = new Container();
		const removed = new ProbeComponent("removed");
		const cleared = new ProbeComponent("cleared");

		container.addChild(removed);
		container.addChild(cleared);

		container.removeChild(removed);
		container.removeChild(removed);
		expect(removed.disposeCount).toBe(1);

		container.clear();
		container.clear();
		expect(cleared.disposeCount).toBe(1);
		expect(removed.disposeCount).toBe(1);
		expect(container.children).toHaveLength(0);
	});

	it("outer clear recursively disposes nested Box and its grandchildren", () => {
		const outer = new Container();
		const box = new Box(0, 0);
		const grandchild = new ProbeComponent("grandchild");
		box.addChild(grandchild);
		outer.addChild(box);

		outer.clear();

		expect(outer.children).toHaveLength(0);
		expect(grandchild.disposeCount).toBe(1);
	});

	it("Box.clear stops a nested Loader interval", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const box = new Box(0, 0);
		let colorTick = 0;
		const loader = new Loader(
			ui,
			frame => `${frame}:${colorTick++}`,
			message => `${message}:${colorTick++}`,
			"busy",
		);
		box.addChild(loader);

		vi.advanceTimersByTime(64);
		const beforeClear = requestRender.mock.calls.length;
		expect(beforeClear).toBeGreaterThan(0);

		box.clear();
		vi.advanceTimersByTime(400);
		expect(requestRender.mock.calls.length).toBe(beforeClear);
	});

	it("disposed child containers can be reattached without losing render structure", () => {
		const outer = new Container();
		const inner = new Container();
		const leaf = new ProbeComponent("leaf");
		inner.addChild(leaf);
		outer.addChild(inner);

		outer.dispose();
		expect(inner.children).toHaveLength(1);
		expect(leaf.disposeCount).toBe(1);

		const freshParent = new Container();
		freshParent.addChild(inner);

		expect(freshParent.render(20)).toEqual(["leaf:20"]);
		expect(inner.children).toHaveLength(1);
	});
});

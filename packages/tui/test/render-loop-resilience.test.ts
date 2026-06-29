import { describe, expect, it } from "bun:test";
import { type Component, Container } from "@gajae-code/tui";

/** Component whose render() always throws, mirroring a tool renderer fed an undefined field. */
class ThrowingComponent implements Component {
	invalidate(): void {}
	render(_width: number): string[] {
		// The exact shape of the original crash: a string op on undefined.
		const value = undefined as unknown as string;
		return [value.trim()];
	}
}

/** Minimal fixed-line component. */
class FixedLines implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

describe("render loop resilience: a throwing child must not crash the frame", () => {
	it("isolates a throwing child and keeps rendering the rest of the tree", () => {
		const container = new Container();
		container.addChild(new FixedLines(["before"]));
		container.addChild(new ThrowingComponent());
		container.addChild(new FixedLines(["after"]));

		let out: string[] = [];
		expect(() => {
			out = container.render(80);
		}).not.toThrow();

		// Siblings still rendered.
		expect(out).toContain("before");
		expect(out).toContain("after");
		// The throwing child contributed a visible fallback line instead of taking down the frame.
		expect(out.some(l => l.includes("render error"))).toBe(true);
	});

	it("survives a throwing child nested inside a child container", () => {
		const inner = new Container();
		inner.addChild(new ThrowingComponent());
		inner.addChild(new FixedLines(["inner-tail"]));

		const outer = new Container();
		outer.addChild(new FixedLines(["outer-head"]));
		outer.addChild(inner);

		let out: string[] = [];
		expect(() => {
			out = outer.render(80);
		}).not.toThrow();

		expect(out).toContain("outer-head");
		expect(out).toContain("inner-tail");
		expect(out.some(l => l.includes("render error"))).toBe(true);
	});
});

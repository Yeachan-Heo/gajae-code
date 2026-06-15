import { describe, expect, it } from "bun:test";
import { type Component, Container } from "@gajae-code/tui";

class FixedLines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

describe("Container spread-safe red-team composition", () => {
	it("renders an empty container as an empty array", () => {
		const container = new Container();

		expect(container.render(80)).toEqual([]);
	});

	it("preserves order and count when empty child outputs are interleaved", () => {
		const container = new Container();
		container.addChild(new FixedLines([]));
		container.addChild(new FixedLines(["alpha", "beta"]));
		container.addChild(new FixedLines([]));
		container.addChild(new FixedLines(["gamma"]));
		container.addChild(new FixedLines([]));
		container.addChild(new FixedLines(["delta", "epsilon"]));

		const output = container.render(80);

		expect(output).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
		expect(output).toHaveLength(5);
	});

	it("composes a single one-million-line child without RangeError", () => {
		const lineCount = 1_000_000;
		const lines = Array.from({ length: lineCount }, (_value, index) => `line-${index}`);
		const container = new Container();
		container.addChild(new FixedLines(lines));

		const output = container.render(80);

		expect(output).toHaveLength(lineCount);
		expect(output[0]).toBe("line-0");
		expect(output[lineCount - 1]).toBe(`line-${lineCount - 1}`);
	});

	it("composes 1000 small children in child and line order", () => {
		const container = new Container();
		for (let childIndex = 0; childIndex < 1000; childIndex++) {
			container.addChild(
				new FixedLines([`child-${childIndex}-line-0`, `child-${childIndex}-line-1`, `child-${childIndex}-line-2`]),
			);
		}

		const output = container.render(80);

		expect(output).toHaveLength(3000);
		expect(output[0]).toBe("child-0-line-0");
		expect(output[1]).toBe("child-0-line-1");
		expect(output[2]).toBe("child-0-line-2");
		expect(output[2997]).toBe("child-999-line-0");
		expect(output[2998]).toBe("child-999-line-1");
		expect(output[2999]).toBe("child-999-line-2");
	});

	it("clamps zero and negative widths while still composing child output", () => {
		const zeroWidthContainer = new Container();
		zeroWidthContainer.addChild(new FixedLines(["zero-a", "zero-b"]));

		const negativeWidthContainer = new Container();
		negativeWidthContainer.addChild(new FixedLines(["negative-a"]));
		negativeWidthContainer.addChild(new FixedLines(["negative-b", "negative-c"]));

		expect(zeroWidthContainer.render(0)).toEqual(["zero-a", "zero-b"]);
		expect(negativeWidthContainer.render(-5)).toEqual(["negative-a", "negative-b", "negative-c"]);
	});
});

import { visibleWidth, visibleWidthExceeds, wrapTextWithAnsi, truncateToWidth, sliceWithWidth, extractSegments, Ellipsis } from "../src/utils";
import { matchesKey } from "../src/keys";

const ITERATIONS = 2000;

const samples = {
	plain: "hello world this is a plain ASCII string with some words",
	ansi: "\x1b[31mred text\x1b[0m and \x1b[4munderlined content\x1b[24m with emoji 😅😅",
	links: "prefix \x1b]8;;https://example.com\x07link\x1b]8;;\x07 suffix",
	paddedAnsi: `${" ".repeat(96)}\x1b[0m`,
	wide: "日本語のテキストとemoji 🚀✨ mixed with ascii",
	wrapped: "This is a long line that should wrap multiple times when rendered with ANSI \x1b[32mcolors\x1b[0m and tabs\tbetween words.",
};

const wrapWidth = 40;

function bench(name: string, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		fn();
	}
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	const perOp = (elapsed / ITERATIONS).toFixed(6);
	console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op)`);
	return elapsed;
}

console.log(`Text layout benchmark (${ITERATIONS} iterations)\n`);

bench("visibleWidth/plain", () => {
	visibleWidth(samples.plain);
});

bench("visibleWidth/ansi", () => {
	visibleWidth(samples.ansi);
});

bench("visibleWidthExceeds/paddedAnsi", () => {
	visibleWidthExceeds(samples.paddedAnsi, 100);
});

bench("truncateToWidth/ansi", () => {
	truncateToWidth(samples.ansi, 32, Ellipsis.Unicode, true);
});

bench("wrapTextWithAnsi/ansi", () => {
	wrapTextWithAnsi(samples.wrapped, wrapWidth);
});

bench("sliceWithWidth/ansi", () => {
	sliceWithWidth(samples.ansi, 3, 18, true);
});

bench("extractSegments/ansi", () => {
	extractSegments(samples.ansi, 10, 20, 15, true);
});

bench("matchesKey", () => {
	matchesKey("\x1b[A", "up");
	matchesKey("\x1b[1;5C", "ctrl+right");
	matchesKey("\x1b[1;2D", "shift+left");
});

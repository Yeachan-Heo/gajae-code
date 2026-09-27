// A/B adapter: keyboard decoding and terminal-cell text layout hot paths.
import { matchesKey, parseKey, type KeyId } from "../../tui/src/keys";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui/src/utils";
import { runAbSuite } from "./ab-adapter";

const keyCorpus: Array<{ data: string; keyId: KeyId; alternate: KeyId }> = [
	{ data: "a", keyId: "a", alternate: "ctrl+a" },
	{ data: "z", keyId: "z", alternate: "alt+z" },
	{ data: "\x03", keyId: "ctrl+c", alternate: "ctrl+z" },
	{ data: "\x1b[A", keyId: "up", alternate: "down" },
	{ data: "\x1b[B", keyId: "down", alternate: "up" },
	{ data: "\x1b[C", keyId: "right", alternate: "left" },
	{ data: "\x1b[D", keyId: "left", alternate: "right" },
	{ data: "\r", keyId: "enter", alternate: "shift+enter" },
	{ data: "\t", keyId: "tab", alternate: "shift+tab" },
	{ data: "\x7f", keyId: "backspace", alternate: "delete" },
	{ data: "\x1b", keyId: "escape", alternate: "enter" },
	{ data: "\x1b[3~", keyId: "delete", alternate: "backspace" },
	{ data: "\x1b[H", keyId: "home", alternate: "end" },
	{ data: "\x1b[F", keyId: "end", alternate: "home" },
];

const lineCorpus = Array.from({ length: 32 }, (_, index) => {
	const body = `row ${index}: ${"plain words ".repeat(2 + (index % 5))}日本語 e\u0301 🙂`;
	switch (index % 4) {
		case 0:
			return body;
		case 1:
			return `\x1b[38;5;${31 + (index % 6)}m${body}\x1b[0m`;
		case 2:
			return `${body}\t${"tail ".repeat(3)}`;
		default:
			return `${body} ${"x".repeat(72 + index)}`;
	}
});

let checksum = 0;
const cases = [
	{
		id: "K01",
		run: async () => {
			let value = 0;
			for (const { data } of keyCorpus) value += (await parseKey(data))?.length ?? 0;
			checksum += value;
		},
	},
	{
		id: "K02",
		run: async () => {
			let value = 0;
			for (const { data, keyId, alternate } of keyCorpus) {
				value += (await matchesKey(data, keyId)) ? 1 : 0;
				value += (await matchesKey(data, alternate)) ? 1 : 0;
			}
			checksum += value;
		},
	},
	{
		id: "K03",
		run: async () => {
			let value = 0;
			for (const line of lineCorpus) value += await visibleWidth(line);
			checksum += value;
		},
	},
	{
		id: "K04",
		run: async () => {
			let value = 0;
			for (const line of lineCorpus) {
				const wrapped = await wrapTextWithAnsi(line, 36);
				value += wrapped.length + (wrapped[0]?.length ?? 0);
			}
			checksum += value;
		},
	},
	{
		id: "K05",
		run: async () => {
			let value = 0;
			for (const line of lineCorpus) value += (await truncateToWidth(line, 48)).length;
			checksum += value;
		},
	},
];

await runAbSuite("keystroke", cases, 100);

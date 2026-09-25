import { describe, expect, it } from "bun:test";
import {
	Ellipsis,
	extractSegments,
	matchesKey as matchesNativeKey,
	matchesKittySequence,
	matchesLegacySequence,
	parseKey as parseNativeKey,
	parseKittySequence,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@gajae-code/natives";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GOLDEN_ROOT = join(import.meta.dir, "../../natives/test/fixtures/goldens");
const RECORD_GOLDENS = process.env.GJC_RECORD_TEXT_KEYS_GOLDENS === "1";

const TEXT_CORPUS = [
	{
		id: "plain-ascii-wrap",
		text: "alpha beta gamma",
		tabWidth: 3,
		wrapWidths: [5, 8],
	},
	{
		id: "tabs-and-trailing-space",
		text: "a\tb  c\t",
		tabWidth: 4,
		wrapWidths: [4, 7],
	},
	{
		id: "ansi-sgr-and-reset",
		text: "\x1b[1;38;2;240;20;80mRED wide界 text\x1b[22;39m plain",
		tabWidth: 3,
		wrapWidths: [6, 10],
	},
	{
		id: "osc8-hyperlink",
		text: "docs \x1b]8;;https://example.test/한글\x07https://example.test/한글\x1b]8;;\x1b\\ tail",
		tabWidth: 3,
		wrapWidths: [12, 20],
	},
	{
		id: "cjk-wide-cells",
		text: "日本語の端末幅測定と漢字",
		tabWidth: 3,
		wrapWidths: [5, 9],
	},
	{
		id: "emoji-graphemes",
		text: "A👩🏽‍💻 B 🇰🇷 ✅ 1️⃣ 👨‍👩‍👧‍👦",
		tabWidth: 3,
		wrapWidths: [4, 8],
	},
	{
		id: "hangul-jamo",
		text: "한글 ㄱㅎ ㅤ 끝",
		tabWidth: 3,
		wrapWidths: [4, 8],
	},
	{
		id: "combining-and-decomposed-hangul",
		text: "e\u0301 a\u0327 각",
		tabWidth: 3,
		wrapWidths: [2, 5],
	},
	{
		id: "inline-math-with-cjk",
		text: "비정상성: $C$와 $\\kappa$는 제도",
		tabWidth: 3,
		wrapWidths: [8, 12],
	},
] as const;

const KEY_SEQUENCE_CORPUS = [
	{ id: "plain-letter", data: "a", kitty: false, keyIds: ["a", "ctrl+a"] },
	{ id: "ctrl-c", data: "\x03", kitty: false, keyIds: ["ctrl+c", "c"] },
	{ id: "backspace-bs-08", data: "\x08", kitty: false, keyIds: ["backspace", "ctrl+h"] },
	{ id: "backspace-del-7f", data: "\x7f", kitty: false, keyIds: ["backspace", "ctrl+backspace"] },
	{ id: "tab-and-enter", data: "\t", kitty: false, keyIds: ["tab", "ctrl+i"] },
	{ id: "escape", data: "\x1b", kitty: false, keyIds: ["escape", "ctrl+["] },
	{ id: "shift-tab", data: "\x1b[Z", kitty: false, keyIds: ["shift+tab", "tab"] },
	{ id: "legacy-arrow-csi", data: "\x1b[A", kitty: false, keyIds: ["up", "alt+up"] },
	{ id: "legacy-arrow-ss3", data: "\x1bOD", kitty: false, keyIds: ["left", "ctrl+left"] },
	{ id: "legacy-page-up", data: "\x1b[5~", kitty: false, keyIds: ["pageUp", "pageDown"] },
	{ id: "legacy-f1", data: "\x1bOP", kitty: false, keyIds: ["f1", "ctrl+f1"] },
	{ id: "alt-enter-lf", data: "\x1b\n", kitty: false, keyIds: ["alt+enter", "ctrl+alt+j"] },
	{ id: "alt-backspace", data: "\x1b\x7f", kitty: true, keyIds: ["alt+backspace", "backspace"] },
	{ id: "alt-space-mixed-mode", data: "\x1b ", kitty: true, keyIds: ["alt+space", "space"] },
	{ id: "alt-navigation-alias", data: "\x1bb", kitty: false, keyIds: ["alt+left", "alt+b"] },
	{ id: "alt-navigation-alias-mixed-mode", data: "\x1bb", kitty: true, keyIds: ["alt+left", "alt+b"] },
	{ id: "alt-navigation-uppercase-legacy", data: "\x1bB", kitty: false, keyIds: ["alt+left", "alt+shift+b"] },
	{ id: "alt-navigation-uppercase-mixed-mode", data: "\x1bB", kitty: true, keyIds: ["alt+left", "alt+shift+b"] },
	{ id: "ctrl-alt-a-mixed-mode", data: "\x1b\x01", kitty: true, keyIds: ["ctrl+alt+a"] },
	{ id: "ctrl-dash-legacy", data: "\x1f", kitty: false, keyIds: ["ctrl+-", "ctrl+_"] },
	{ id: "kitty-cyrillic-layout", data: "\x1b[1089::99u", kitty: true, keyIds: ["c"] },

	{ id: "meta-wrapped-arrow", data: "\x1b\x1b[A", kitty: true, keyIds: ["alt+up", "up"] },
	{ id: "kitty-dvorak-ctrl-k", data: "\x1b[107::118;5u", kitty: true, keyIds: ["ctrl+k", "ctrl+v"] },
	{ id: "kitty-dvorak-ctrl-slash", data: "\x1b[47::91;5u", kitty: true, keyIds: ["ctrl+/", "ctrl+["] },
	{ id: "kitty-korean-dubeolsik", data: "\x1b[12621;5u", kitty: true, keyIds: ["ctrl+v", "ctrl+b"] },
	{ id: "kitty-super-p", data: "\x1b[112;9u", kitty: true, keyIds: ["super+p", "p"] },
	{ id: "kitty-release-backspace", data: "\x1b[127;1:3u", kitty: true, keyIds: ["backspace"] },
	{ id: "kitty-repeat-backspace", data: "\x1b[127;1:2u", kitty: true, keyIds: ["backspace"] },
	{ id: "kitty-unsupported-event", data: "\x1b[112;1:4u", kitty: true, keyIds: ["p"] },
	{ id: "kitty-numlock-digit", data: "\x1b[57400;129u", kitty: true, keyIds: ["1", "end"] },
	{ id: "kitty-numlock-keypad-unmodified", data: "\x1b[57400u", kitty: true, keyIds: ["1", "end"] },
	{ id: "kitty-keypad-operator", data: "\x1b[57413;5u", kitty: true, keyIds: ["ctrl++", "+"] },
	{ id: "kitty-ctrl-shift-enter", data: "\x1b[13;6u", kitty: true, keyIds: ["ctrl+shift+enter", "alt+enter"] },
	{ id: "mok-super-p", data: "\x1b[27;9;112~", kitty: false, keyIds: ["super+p", "ctrl+p"] },
	{ id: "mok-alt-i", data: "\x1b[27;3;105~", kitty: true, keyIds: ["alt+i", "alt+shift+i"] },
	{ id: "unsupported-modifier", data: "\x1b[99;17u", kitty: true, keyIds: ["c"] },
	{ id: "malformed-csi", data: "\x1b[97;4294967297u", kitty: true, keyIds: ["a"] },
] as const;

function captureText(): unknown[] {
	return TEXT_CORPUS.map(({ id, text, tabWidth, wrapWidths }) => ({
		id,
		input: { text, tabWidth, wrapWidths },
		visibleWidth: visibleWidth(text, tabWidth),
		wraps: wrapWidths.map(width => ({ width, lines: wrapTextWithAnsi(text, width, tabWidth) })),
		truncations: [0, 1, 3, 8].flatMap(width =>
			[Ellipsis.Unicode, Ellipsis.Ascii, Ellipsis.Omit].flatMap(ellipsis =>
			[false, true].map(pad => ({
				width,
				ellipsis,
				pad,
				text: truncateToWidth(text, width, ellipsis, pad, tabWidth),
			})),
			),
		),
		slice: sliceWithWidth(text, 1, 5, false, tabWidth),
		segments: extractSegments(text, 2, 4, 5, true, tabWidth),
	}));
}

function captureKeys(): unknown[] {
	return KEY_SEQUENCE_CORPUS.map(({ id, data, kitty, keyIds }) => ({
		id,
		input: { data, kitty, keyIds },
		parsedKey: parseNativeKey(data, kitty) ?? null,
		matches: keyIds.map(keyId => ({ keyId, matches: matchesNativeKey(data, keyId, kitty) })),
		parsedKitty: parseKittySequence(data) ?? null,
		legacyBackspaceMatch: id === "backspace-bs-08" ? matchesLegacySequence(data, "backspace") : null,
		kittyMatch:
			id === "kitty-dvorak-ctrl-k"
				? matchesKittySequence(data, 107, 4)
				: id === "kitty-super-p"
					? matchesKittySequence(data, 112, 8)
					: id === "kitty-cyrillic-layout"
						? matchesKittySequence(data, 99, 0)
						: null,
	}));
}

function applyGoldenPatch(record: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.replace(/\[(\d+)\]/gu, ".$1").split(".");
	let parent: unknown = record;
	for (const segment of segments.slice(0, -1)) {
		if (!parent || typeof parent !== "object") throw new Error(`Invalid golden patch path ${path}`);
		parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
	}
	const key = segments.at(-1);
	if (!key || !parent || typeof parent !== "object") throw new Error(`Invalid golden patch path ${path}`);
	if (Array.isArray(parent)) {
		const index = Number(key);
		if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`Invalid golden patch index ${path}`);
		parent[index] = value;
	} else {
		if (!Object.hasOwn(parent, key)) throw new Error(`Unknown golden patch field ${path}`);
		(parent as Record<string, unknown>)[key] = value;
	}
}

async function assertGolden(name: "text" | "keys", actual: unknown[]): Promise<void> {
	const path = join(GOLDEN_ROOT, name, "native-pre-sync.json");
	if (RECORD_GOLDENS) {
		await mkdir(join(GOLDEN_ROOT, name), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify(
				{
					schema: 1,
					recordedFrom: "pi-natives 0.17.6 before the pinned text.rs/keys.rs re-sync",
					corpus: actual,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		return;
	}

	const golden = JSON.parse(await readFile(path, "utf8")) as { schema: number; corpus: Array<Record<string, unknown> & { id: string }> };
	const acceptedPath = join(GOLDEN_ROOT, "accepted-divergences.json");
	const accepted = JSON.parse(await readFile(acceptedPath, "utf8")) as {
		schema: number;
		divergences: Array<{
			module: string;
			caseId: string;
			fields?: Record<string, unknown>;
			patches?: Array<{ path: string; value: unknown }>;
			reason: string;
		}>;
		nonAdoptions: Array<{ module: string; caseId: string; reason: string }>;
	};
	expect(golden.schema).toBe(1);
	expect(accepted.schema).toBe(1);
	const expected = structuredClone(golden.corpus);
	for (const divergence of accepted.divergences.filter(entry => entry.module === name)) {
		const record = expected.find(entry => entry.id === divergence.caseId);
		if (!record || !divergence.reason.trim()) {
			throw new Error(`Invalid accepted divergence ${name}/${divergence.caseId}`);
		}
		for (const [field, value] of Object.entries(divergence.fields ?? {})) {
			if (!Object.hasOwn(record, field)) throw new Error(`Unknown divergence field ${field} in ${name}/${divergence.caseId}`);
			record[field] = value;
		}
		for (const patch of divergence.patches ?? []) applyGoldenPatch(record, patch.path, patch.value);
	}
	for (const nonAdoption of accepted.nonAdoptions.filter(entry => entry.module === name)) {
		if (!expected.some(entry => entry.id === nonAdoption.caseId) || !nonAdoption.reason.trim()) {
			throw new Error(`Invalid non-adoption record ${name}/${nonAdoption.caseId}`);
		}
	}
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

describe("native text and key re-sync goldens", () => {
	it("preserves pre-sync text output across wrap, width, truncation, ANSI, CJK, emoji, and jamo cases", async () => {
		await assertGolden("text", captureText());
	});

	it("preserves pre-sync native output for the TUI key-sequence corpus", async () => {
		await assertGolden("keys", captureKeys());
	});
});

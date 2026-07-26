import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKeyId } from "@gajae-code/tui";
import {
	defaultClipboardPasteImageKeysForPlatform,
	defaultMessageQueueKeysForPlatform,
	formatAccessibleKeyHint,
	formatKeyHint,
	KEYBINDINGS,
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
} from "../src/config/keybindings";

function keysForPlatform(id: Keybinding, platform: NodeJS.Platform): KeyId[] {
	const defaults =
		id === "app.message.queue"
			? defaultMessageQueueKeysForPlatform(platform)
			: id === "app.clipboard.pasteImage"
				? defaultClipboardPasteImageKeysForPlatform(platform)
				: KEYBINDINGS[id].defaultKeys;
	return typeof defaults === "string" ? [defaults] : [...defaults];
}

const WINDOWS_RUNTIME_SHORTCUTS: Array<{ id: Keybinding; windows: KeyId[]; darwin: KeyId[] }> = (
	Object.keys(KEYBINDINGS) as Keybinding[]
).flatMap(id => {
	const windows = keysForPlatform(id, "win32");
	// Suspend delegates to POSIX job control and InputController deliberately
	// reports it unavailable on win32. Empty defaults are registry catalog entries,
	// not shipped default chords, so parity must not manufacture bindings for them.
	if (id === "app.suspend" || windows.length === 0) return [];
	return [{ id, windows, darwin: keysForPlatform(id, "darwin") }];
});

const DOC_PATH = join(import.meta.dir, "../../../docs/keybindings.md");

describe("docs/keybindings.md current-surface audit", () => {
	it("documents every registry action ID (no drift)", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const missing = Object.keys(KEYBINDINGS).filter(id => !doc.includes(`\`${id}\``));
		expect(missing).toEqual([]);
	});
});

describe("Windows-to-Darwin declared default parity", () => {
	it("gives every shipped Windows chord a Darwin equivalent except POSIX suspend", () => {
		for (const id of Object.keys(KEYBINDINGS) as Keybinding[]) {
			const windows = keysForPlatform(id, "win32");
			if (windows.length === 0 || id === "app.suspend") continue;
			expect(keysForPlatform(id, "darwin").length, `${id}: missing Darwin equivalent`).toBeGreaterThan(0);
		}
		expect(keysForPlatform("app.suspend", "darwin")).toEqual(keysForPlatform("app.suspend", "win32"));
	});

	it("maps the only platform-varying defaults explicitly", () => {
		expect(WINDOWS_RUNTIME_SHORTCUTS.find(({ id }) => id === "app.message.queue")).toEqual({
			id: "app.message.queue",
			windows: ["alt+q"],
			darwin: ["alt+q"],
		});
		expect(WINDOWS_RUNTIME_SHORTCUTS.find(({ id }) => id === "app.clipboard.pasteImage")).toEqual({
			id: "app.clipboard.pasteImage",
			windows: ["alt+v"],
			darwin: ["ctrl+v"],
		});
		expect(formatKeyHint("alt+q", { platform: "darwin" })).toBe("⌥Q");
		expect(formatAccessibleKeyHint("alt+q", { platform: "darwin" })).toBe("⌥Q (Option+Q)");
		expect(formatKeyHint("ctrl+v", { platform: "darwin" })).toBe("⌃V");
		expect(formatAccessibleKeyHint("ctrl+v", { platform: "darwin" })).toBe("⌃V (Control+V)");
		expect(WINDOWS_RUNTIME_SHORTCUTS.filter(({ windows, darwin }) => windows.join() !== darwin.join())).toEqual([
			{
				id: "app.clipboard.pasteImage",
				windows: ["alt+v"],
				darwin: ["ctrl+v"],
			},
		]);
	});

	it("keeps every declared Windows and Darwin equivalent canonical and valid in Darwin renderers", () => {
		for (const { id, windows, darwin } of WINDOWS_RUNTIME_SHORTCUTS) {
			for (const key of [...windows, ...darwin]) {
				expect(parseKeyId(key)?.keyId, `${id}: non-canonical ${key}`).toBe(key);
			}
			for (const key of darwin) {
				const concise = formatKeyHint(key, { platform: "darwin" });
				const accessible = formatAccessibleKeyHint(key, { platform: "darwin" });
				expect(concise, `${id}: invalid concise label for ${key}`).not.toBe("Invalid keybinding");
				expect(accessible, `${id}: invalid accessible label for ${key}`).not.toBe("Invalid keybinding");
				expect(concise.length).toBeGreaterThan(0);
				expect(accessible).toContain(concise);
			}
		}
	});

	it("preserves Darwin defaults plus effective remap and unbound behavior for every covered action", () => {
		const darwinDefaults = Object.fromEntries(
			WINDOWS_RUNTIME_SHORTCUTS.map(({ id, darwin }) => [id, darwin]),
		) as KeybindingsConfig;
		const defaults = KeybindingsManager.inMemory(darwinDefaults);

		for (const { id, darwin } of WINDOWS_RUNTIME_SHORTCUTS) {
			expect(defaults.getKeys(id), `${id}: Darwin default`).toEqual(darwin);

			const remapped = KeybindingsManager.inMemory({ [id]: "f12" });
			expect(remapped.getKeys(id), `${id}: remap`).toEqual(["f12"]);
			remapped.setUserBindings({ [id]: [] });
			expect(remapped.getKeys(id), `${id}: unbound`).toEqual([]);
		}
	});
});

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	defaultClipboardPasteImageKeysForPlatform,
	defaultMessageQueueKeysForPlatform,
	KEYBINDINGS,
} from "../src/config/keybindings";

import { APP_ACTION_METADATA } from "../src/modes/action-registry";

const DOC_PATH = path.resolve(import.meta.dir, "../../../docs/keybindings.md");
const SECTION_START = "### Application context (`app.*`)";
const SECTION_END = "### Global engine context (`tui.global.*`)";

const DOCUMENTATION_PLATFORMS = ["darwin", "win32", "linux"] as const;

function defaultKeys(
	value: (typeof KEYBINDINGS)[keyof typeof KEYBINDINGS],
	bindingId: keyof typeof KEYBINDINGS,
): string {
	const defaultsByPlatform = DOCUMENTATION_PLATFORMS.map(platform => {
		switch (bindingId) {
			case "app.message.queue":
				return defaultMessageQueueKeysForPlatform(platform);
			case "app.clipboard.pasteImage":
				return defaultClipboardPasteImageKeysForPlatform(platform);
			default: {
				const keys = value.defaultKeys;
				return (Array.isArray(keys) ? keys : [keys]).join(", ") || "_(none)_";
			}
		}
	});
	const groups = new Map<string, string[]>();
	for (const [index, keys] of defaultsByPlatform.entries()) {
		const platform = DOCUMENTATION_PLATFORMS[index]!;
		groups.set(keys, [...(groups.get(keys) ?? []), platform]);
	}
	return groups.size === 1
		? defaultsByPlatform[0]!
		: [...groups].map(([keys, platforms]) => `${keys} (${platforms.join("/")})`).join(" / ");
}

/** Canonical application-action table shared by docs and drift tests. */
export function generateHotkeysDocsTable(): string {
	return [
		"| Action ID | Default | Domains |",
		"| --- | --- | --- |",
		...APP_ACTION_METADATA.map(action => {
			const binding = KEYBINDINGS[action.bindingId ?? action.id];
			return `| \`${action.id}\` | ${defaultKeys(binding, action.bindingId ?? action.id)} | ${action.domains.join(", ")} |`;
		}),
	].join("\n");
}

export function generateKeybindingsDocument(source = readFileSync(DOC_PATH, "utf8")): string {
	const start = source.indexOf(SECTION_START);
	const end = source.indexOf(SECTION_END);
	if (start < 0 || end < 0 || end <= start) throw new Error("Application keybinding section not found");
	return `${source.slice(0, start)}${SECTION_START}\n\n${generateHotkeysDocsTable()}\n\n${source.slice(end)}`;
}

if (import.meta.main) {
	const expected = generateKeybindingsDocument();
	if (process.argv.includes("--check")) {
		if (readFileSync(DOC_PATH, "utf8") !== expected) {
			console.error(
				`${path.relative(process.cwd(), DOC_PATH)} is out of date; run bun scripts/generate-hotkeys-docs.ts`,
			);
			process.exitCode = 1;
		}
	} else {
		writeFileSync(DOC_PATH, expected);
	}
}

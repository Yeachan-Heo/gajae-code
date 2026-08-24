import { describe, expect, it } from "bun:test";
import { TUI_KEYBINDINGS, type KeyId } from "@gajae-code/tui";
import { defaultForegroundFoldKeysForPlatform, KEYBINDINGS } from "../src/config/keybindings";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor) throw new Error("process.platform descriptor is unavailable");
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return callback();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

function defaults(definition: { defaultKeys: KeyId | readonly KeyId[] }): readonly KeyId[] {
	return typeof definition.defaultKeys === "string" ? [definition.defaultKeys] : definition.defaultKeys;
}

describe("foreground fold default chord", () => {
	it("uses both the fallback and Command chord on Darwin", () => {
		expect(withPlatform("darwin", () => defaultForegroundFoldKeysForPlatform())).toEqual([
			"alt+shift+b",
			"super+b",
		]);
	});

	it.each(["linux", "win32"] as const)("uses only the fallback chord on %s", platform => {
		expect(withPlatform(platform, () => defaultForegroundFoldKeysForPlatform())).toEqual(["alt+shift+b"]);
	});

	it("registers the platform-aware defaults for the action", () => {
		expect(KEYBINDINGS["app.tool.backgroundFold"].defaultKeys).toEqual(
			defaultForegroundFoldKeysForPlatform(),
		);
	});

	it("keeps every foreground fold default free across app and TUI registries", () => {
		const foldDefaults = new Set<KeyId>([
			...defaultForegroundFoldKeysForPlatform("darwin"),
			...defaultForegroundFoldKeysForPlatform("linux"),
		]);
		const collisions: string[] = [];

		for (const [id, definition] of Object.entries(KEYBINDINGS)) {
			if (id === "app.tool.backgroundFold") continue;
			for (const key of defaults(definition)) {
				if (foldDefaults.has(key)) collisions.push(`KEYBINDINGS.${id}=${key}`);
			}
		}
		for (const [id, definition] of Object.entries(TUI_KEYBINDINGS)) {
			for (const key of defaults(definition)) {
				if (foldDefaults.has(key)) collisions.push(`TUI_KEYBINDINGS.${id}=${key}`);
			}
		}

		expect(collisions).toEqual([]);
	});
});

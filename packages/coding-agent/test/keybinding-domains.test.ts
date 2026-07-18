import { describe, expect, it } from "bun:test";
import { generateHotkeysDocsTable } from "../scripts/generate-hotkeys-docs";
import { type AppKeybinding, KEYBINDINGS } from "../src/config/keybindings";
import { APP_ACTION_METADATA } from "../src/modes/action-registry";

const appBindings = Object.keys(KEYBINDINGS).filter((id): id is AppKeybinding => id.startsWith("app."));
const metadataById = new Map(APP_ACTION_METADATA.map(action => [action.id, action]));

function defaultKeys(id: AppKeybinding): string[] {
	const keys = KEYBINDINGS[id].defaultKeys;
	return Array.isArray(keys) ? keys : [keys];
}

describe("application keybinding domains", () => {
	it("registers every application keybinding", () => {
		expect(appBindings.filter(id => !metadataById.has(id))).toEqual([]);
		expect(APP_ACTION_METADATA.filter(action => !(action.id in KEYBINDINGS))).toEqual([]);
	});

	it("rejects default chord collisions within a focus domain", () => {
		const owners = new Map<string, AppKeybinding[]>();
		for (const action of APP_ACTION_METADATA) {
			for (const domain of action.domains)
				for (const key of defaultKeys(action.id)) {
					if (!key) continue;
					const identity = `${domain}:${key}`;
					owners.set(identity, [...(owners.get(identity) ?? []), action.id]);
				}
		}
		expect([...owners.entries()].filter(([, ids]) => ids.length > 1)).toEqual([]);
	});

	it("allows known cross-domain chord reuse", () => {
		for (const key of ["ctrl+p", "ctrl+s", "ctrl+r", "ctrl+d"]) {
			const actions = APP_ACTION_METADATA.filter(action => defaultKeys(action.id).includes(key));
			expect(new Set(actions.flatMap(action => action.domains)).size).toBeGreaterThan(1);
		}
	});

	it("generates a row for every registered action", () => {
		const table = generateHotkeysDocsTable();
		for (const action of APP_ACTION_METADATA) expect(table).toContain(`\`${action.id}\``);
	});
});

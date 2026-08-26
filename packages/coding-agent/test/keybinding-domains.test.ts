import { describe, expect, it } from "bun:test";
import { type KeyId, parseKeyId } from "@gajae-code/tui";
import { generateHotkeysDocsTable } from "../scripts/generate-hotkeys-docs";
import { type AppKeybinding, KEYBINDINGS } from "../src/config/keybindings";
import { APP_ACTION_METADATA } from "../src/modes/action-registry";
import { AVAILABILITY_GATED_NAV_PALETTE_ACTIONS } from "../src/modes/controllers/input-controller";

/** Chords introduced by this TUI/UX change, with their sole intended owner. */
const NEWLY_SHIPPED_CHORD_OWNERS: ReadonlyArray<readonly [KeyId, AppKeybinding]> = [
	["alt+shift+t", "app.todo.toggle"],
	["alt+shift+s", "app.session.tree"],
	["alt+shift+f", "app.session.fork"],
	["alt+shift+r", "app.session.resume"],
];

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

	it("labels the legacy fork action by its message-branch behavior", () => {
		expect(metadataById.get("app.session.fork")?.title).toBe("Branch from message");
		expect(KEYBINDINGS["app.session.fork"].description).toBe("Branch from message");
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

	it("gates exactly the six documented navigation ids", () => {
		// Literal contract: deriving this from the production list would let an
		// accidentally removed id slip through unnoticed.
		const expected: readonly AppKeybinding[] = [
			"app.message.sendNow",
			"app.queue.togglePane",
			"app.session.dashboard",
			"app.transcript.browse",
			"app.transcript.nextTurn",
			"app.transcript.prevTurn",
		];
		// Compare as plain strings: the production list's narrow union would
		// otherwise drive inference and defeat the point of a literal expectation.
		const asStrings = (ids: readonly AppKeybinding[]): string[] => [...ids].sort();
		expect(asStrings(AVAILABILITY_GATED_NAV_PALETTE_ACTIONS)).toEqual(asStrings(expected));
	});

	it("keeps every availability-gated navigation palette id registered and default-free", () => {
		for (const id of AVAILABILITY_GATED_NAV_PALETTE_ACTIONS) {
			// A gated id must be a real registered action, or the palette would list
			// an entry whose label lookup has no source.
			expect(metadataById.has(id)).toBe(true);
			expect(id in KEYBINDINGS).toBe(true);
			expect(KEYBINDINGS[id].description.length).toBeGreaterThan(0);
			// Shipping a default chord for one of these is the deferred part-(b)
			// change, not this one: the remap loops exist precisely so a user
			// binding works while defaults stay empty.
			expect(defaultKeys(id)).toEqual([]);
		}
	});

	it("excludes intentionally-unbound and product-pending ids from the gate set", () => {
		// The global "every metadata id is reachable" claim was dropped because
		// these two cannot satisfy it: followUp is deliberately unbound and
		// mode.cycle duplicates app.plan.toggle pending a product decision.
		const gated = new Set<AppKeybinding>(AVAILABILITY_GATED_NAV_PALETTE_ACTIONS);
		expect(gated.has("app.message.followUp")).toBe(false);
		expect(gated.has("app.mode.cycle")).toBe(false);
	});

	it("claims each newly shipped alt+shift chord for exactly one owner across every keybinding layer", () => {
		// KEYBINDINGS spreads TUI_KEYBINDINGS, so iterating it covers the app layer
		// and the TUI editor/input/select layers in one pass. The pre-existing
		// collision test only compares APP_ACTION_METADATA entries against each
		// other, so a chord already claimed by a TUI editor binding would slip past.
		const ownersByChord = new Map<string, string[]>();
		for (const [id, binding] of Object.entries(KEYBINDINGS)) {
			const keys = Array.isArray(binding.defaultKeys) ? binding.defaultKeys : [binding.defaultKeys];
			for (const key of keys) {
				if (!key) continue;
				ownersByChord.set(key, [...(ownersByChord.get(key) ?? []), id]);
			}
		}

		for (const [chord, expectedOwner] of NEWLY_SHIPPED_CHORD_OWNERS) {
			expect(ownersByChord.get(chord)).toEqual([expectedOwner]);
			// Canonical form: a non-canonical spelling would never match at runtime.
			expect(parseKeyId(chord)?.keyId).toBe(chord);
		}
	});
});

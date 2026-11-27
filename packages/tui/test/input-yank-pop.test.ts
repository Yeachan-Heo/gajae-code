import { describe, expect, it } from "bun:test";
import { Input } from "../src/components/input";
import { SecretInput } from "../src/components/secret-input";

interface TestInput {
	handleInput: (key: string) => void;
	submit: () => string;
	cleanup: () => void;
}

const factories: ReadonlyArray<readonly [string, () => TestInput]> = [
	[
		"Input",
		() => {
			const input = new Input();
			let submitted = "";
			input.onSubmit = value => {
				submitted = value;
			};
			return {
				handleInput: key => input.handleInput(key),
				submit: () => {
					input.handleInput("\r");
					return submitted;
				},
				cleanup: () => {},
			};
		},
	],
	[
		"SecretInput",
		() => {
			const input = new SecretInput();
			let submitted = "";
			input.onSubmit = value => {
				submitted = value.consume();
			};
			return {
				handleInput: key => input.handleInput(key),
				submit: () => {
					input.handleInput("\r");
					return submitted;
				},
				cleanup: () => input.dispose(),
			};
		},
	],
];

const kill = "\x15";
const yank = "\x19";
const pop = "\x1by";
const undo = "\x1f";
const combiningSetup = ["B", kill, "\u0301", kill, "e", yank];
const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
	["preserves the prefix on yank-pop", [...combiningSetup, pop], "eB"],
	["cycles back to the composed value", [...combiningSetup, pop, pop], "é"],
	["cycles repeatedly from the same pre-yank state", [...combiningSetup, pop, pop, pop], "eB"],
	["keeps ASCII replacement unchanged", ["B", kill, "Z", kill, "e", yank, pop], "eB"],
	["preserves suffix and insertion cursor", ["B", kill, "\u0301", kill, "eQ", "\x1b[D", yank, pop, "X"], "eBXQ"],
	["undoes a pop to the composed yank", [...combiningSetup, pop, undo], "é"],
	["does not pop after undoing the yank", [...combiningSetup, undo, pop], "e"],
	["uses the latest of two yanks", ["B", kill, "C", kill, "e", yank, "x", yank, pop], "eCxB"],
	["uses the latest yank after moving the cursor", ["B", kill, "C", kill, "ab", yank, "\x01", yank, pop], "BabC"],
	["ends the chain when typing", [...combiningSetup, "x", pop], "éx"],
	["ends the chain when moving the cursor", [...combiningSetup, "\x1b[D", pop], "é"],
	["ends the chain on paste", [...combiningSetup, "\x1b[200~zz\x1b[201~", pop], "ézz"],
	["does not pop a single ring entry", ["B", kill, "e", yank, pop, pop, undo], "e"],
	["backspaces the replacement without deleting the prefix", [...combiningSetup, pop, "\x7f"], "e"],
	["keeps composed backspace behavior", [...combiningSetup, "\x7f"], ""],
	["keeps composed forward-delete behavior", [...combiningSetup, "\x1b[D", "\x1b[3~"], ""],
];

for (const [name, create] of factories) {
	describe(`${name} yank-pop`, () => {
		for (const [label, keys, expected] of cases) {
			it(label, () => {
				const input = create();
				try {
					for (const key of keys) input.handleInput(key);
					expect(input.submit()).toBe(expected);
				} finally {
					input.cleanup();
				}
			});
		}
	});
}

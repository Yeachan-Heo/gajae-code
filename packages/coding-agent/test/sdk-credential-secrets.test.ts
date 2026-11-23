import { describe, expect, it } from "bun:test";
import { maskStoredSecrets } from "@gajae-code/coding-agent/sdk/credential-secrets";

describe("maskStoredSecrets", () => {
	it("replaces each match with the caller's marker", () => {
		const text = "use sk-alpha then sk-alpha again";
		expect(maskStoredSecrets(text, ["sk-alpha"], "[REDACTED]")).toBe("use [REDACTED] then [REDACTED] again");
		expect(maskStoredSecrets(text, ["sk-alpha"], "«redacted»")).toBe("use «redacted» then «redacted» again");
	});

	it("masks overlapping literals as one union without leaving a remainder", () => {
		const text = "lead overlap-left-shared-right-private tail";
		const secrets = ["overlap-left-shared", "shared-right-private"];
		expect(maskStoredSecrets(text, secrets, "*")).toBe("lead * tail");
		expect(maskStoredSecrets(text, [...secrets].reverse(), "*")).toBe("lead * tail");
	});

	it("widens a mask to the whole surrogate pair it touches", () => {
		const masked = maskStoredSecrets("a𐐀b", ["\ud801"], "*");
		expect(masked).toBe("a*b");
		expect(masked.isWellFormed()).toBe(true);
	});

	it("ignores empty literals and returns text unchanged when nothing matches", () => {
		expect(maskStoredSecrets("public text", ["", "absent"], "*")).toBe("public text");
	});

	it("masks a cut-off credential suffix only when asked", () => {
		const text = "answer ends with sk-partial-cre";
		const secrets = ["sk-partial-credential"];
		expect(maskStoredSecrets(text, secrets, "*")).toBe(text);
		expect(maskStoredSecrets(text, secrets, "*", true)).toBe("answer ends with *");
	});
});

import { describe, expect, test } from "bun:test";
import {
	compareRankedProviders,
	FAMOUS_PROVIDER_ORDER,
	famousProviderIndex,
	type ProviderAuthState,
	type RankableProvider,
	sortRankedProviders,
} from "../src/config/provider-ranking";
import { formatProviderPresetList, PROVIDER_PRESETS } from "../src/setup/provider-onboarding";

const AUTH_STATES: readonly ProviderAuthState[] = ["valid", "checking", "configured", "invalid", "none"];
const EXISTING_AUTH_STATES: readonly ProviderAuthState[] = ["valid", "checking", "configured"];
const UNICODE_LABELS = ["가나다", "Ångström", "Éclair", "😀 Provider", "東京", "مرحبا", "e\u0301", "é"];

type ProviderSignature = `${string}\u0000${ProviderAuthState}\u0000${string}`;

function provider(id: string, authState: ProviderAuthState, label = id): RankableProvider {
	return { id, label, authState };
}

function sign(value: number): -1 | 0 | 1 {
	return value === 0 ? 0 : value < 0 ? -1 : 1;
}

function oppositeSign(value: number): -1 | 0 | 1 {
	const valueSign = sign(value);
	return valueSign === 0 ? 0 : valueSign === 1 ? -1 : 1;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
	const random = mulberry32(seed);
	const shuffled = [...values];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
	}
	return shuffled;
}

function signature(entry: RankableProvider): ProviderSignature {
	return `${entry.id}\u0000${entry.authState}\u0000${entry.label}`;
}

function presetRankingId(preset: (typeof PROVIDER_PRESETS)[number]): string {
	return (
		[preset.providerId, preset.id, ...preset.aliases].find(id => famousProviderIndex(id) !== undefined) ?? preset.id
	);
}

describe("provider ranking adversarial properties", () => {
	test("keeps reflexivity, antisymmetry, and transitivity over generated providers", () => {
		const unknownIds = Array.from(
			{ length: 24 },
			(_, index) => `unknown-generated-${index.toString(36).padStart(2, "0")}`,
		);
		const ids = [...FAMOUS_PROVIDER_ORDER, ...unknownIds];
		const entries = ids.flatMap((id, idIndex) =>
			AUTH_STATES.map(authState =>
				provider(id, authState, `${UNICODE_LABELS[idIndex % UNICODE_LABELS.length]} ${id}`),
			),
		);

		for (const entry of entries) {
			expect(compareRankedProviders(entry, entry)).toBe(0);
		}

		for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
				const left = entries[leftIndex];
				const right = entries[rightIndex];
				const forward = compareRankedProviders(left, right);
				const backward = compareRankedProviders(right, left);
				expect(sign(forward)).toBe(oppositeSign(backward));
			}
		}

		for (let first = 0; first < entries.length; first += 1) {
			for (let second = first + 1; second < entries.length; second += 1) {
				for (let third = second + 1; third < entries.length; third += 1) {
					const firstSecond = compareRankedProviders(entries[first], entries[second]);
					const secondThird = compareRankedProviders(entries[second], entries[third]);
					if (firstSecond <= 0 && secondThird <= 0) {
						expect(compareRankedProviders(entries[first], entries[third])).toBeLessThanOrEqual(0);
					}
				}
			}
		}
	});

	test("produces one deterministic sequence across 64 seeded input permutations", () => {
		const entries: RankableProvider[] = [
			...FAMOUS_PROVIDER_ORDER.map((id, index) =>
				provider(id, AUTH_STATES[index % AUTH_STATES.length], UNICODE_LABELS[index % UNICODE_LABELS.length]),
			),
			...Array.from({ length: 80 }, (_, index) =>
				provider(
					`custom-generated-${index.toString(36).padStart(2, "0")}`,
					AUTH_STATES[(index + 1) % AUTH_STATES.length],
					UNICODE_LABELS[(index + 3) % UNICODE_LABELS.length],
				),
			),
		];
		const before = entries.map(signature);
		const expected = sortRankedProviders(entries);
		const expectedIds = expected.map(entry => entry.id);
		const expectedSignatures = expected.map(signature);

		for (let shuffleNumber = 0; shuffleNumber < 64; shuffleNumber += 1) {
			const shuffled = shuffle(entries, 0x51_7e_0000 + shuffleNumber);
			const sorted = sortRankedProviders(shuffled);
			expect(sorted.map(entry => entry.id)).toEqual(expectedIds);
			expect(sorted.map(signature)).toEqual(expectedSignatures);
		}
		expect(entries.map(signature)).toEqual(before);
	});

	test("handles empty, singleton, identical-label, and homogeneous-auth-state inputs", () => {
		expect(sortRankedProviders([])).toEqual([]);

		const singleton = [provider("single", "none", "Only one")];
		const singletonResult = sortRankedProviders(singleton);
		expect(singletonResult).toEqual(singleton);
		expect(singletonResult).not.toBe(singleton);

		const sameLabel = [
			provider("zeta", "none", "Same label"),
			provider("alpha", "none", "Same label"),
			provider("middle", "none", "Same label"),
		];
		expect(sortRankedProviders(sameLabel).map(entry => entry.id)).toEqual(["alpha", "middle", "zeta"]);

		for (const authState of AUTH_STATES) {
			const homogeneous = [
				provider("custom-z", authState, "Same label"),
				provider("anthropic", authState, "Same label"),
				provider("custom-a", authState, "Same label"),
			];
			const sorted = sortRankedProviders(homogeneous);
			expect(sorted.every(entry => entry.authState === authState)).toBe(true);
			expect(sorted.map(entry => entry.id)).toEqual(["anthropic", "custom-a", "custom-z"]);
		}
	});

	test("keeps Unicode and locale-sensitive labels in a total, non-throwing order", () => {
		const entries = [
			provider("korean", "none", "가나다"),
			provider("accented", "none", "Ångström"),
			provider("accented-e", "none", "Éclair"),
			provider("emoji", "none", "😀 Provider"),
			provider("cjk", "none", "東京"),
			provider("arabic", "none", "مرحبا"),
			provider("decomposed-e", "none", "e\u0301"),
			provider("composed-e", "none", "é"),
		];
		const before = entries.map(signature);
		const sorted = sortRankedProviders(entries);

		expect(sorted).toHaveLength(entries.length);
		expect(new Set(sorted.map(entry => entry.id)).size).toBe(entries.length);
		expect(entries.map(signature)).toEqual(before);
		for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
				expect(compareRankedProviders(sorted[leftIndex], sorted[rightIndex])).not.toBe(0);
				expect(sign(compareRankedProviders(sorted[leftIndex], sorted[rightIndex]))).toBe(
					oppositeSign(compareRankedProviders(sorted[rightIndex], sorted[leftIndex])),
				);
			}
		}
	});

	test("retains duplicate ids without mutating the input", () => {
		const input = [
			provider("duplicate", "none", "Duplicate"),
			provider("duplicate", "none", "Duplicate"),
			provider("duplicate", "invalid", "Duplicate"),
			provider("duplicate", "valid", "Duplicate"),
			provider("custom", "none", "Custom"),
		];
		const before = input.map(signature);
		const sorted = sortRankedProviders(input);

		expect(sorted).not.toBe(input);
		expect(sorted.filter(entry => entry.id === "duplicate")).toHaveLength(4);
		expect(sorted.filter(entry => entry.id === "custom")).toHaveLength(1);
		expect(sorted.map(signature)).toContain("duplicate\u0000valid\u0000Duplicate");
		expect(sorted.map(signature)).toContain("duplicate\u0000invalid\u0000Duplicate");
		expect(input.map(signature)).toEqual(before);
	});
});

describe("provider ranking spec-contract attacks", () => {
	test("keeps every famous variant immediately behind its primary in a full mixed sort", () => {
		const mixed = [
			provider("configured-custom", "configured", "Configured custom"),
			provider("invalid-custom", "invalid", "Invalid custom"),
			...FAMOUS_PROVIDER_ORDER.map((id, index) => provider(id, "none", `Famous ${index}`)),
			provider("unknown-last", "none", "AAA unknown"),
		];
		const sortedIds = sortRankedProviders(mixed).map(entry => entry.id);
		const expected = ["configured-custom", "invalid-custom", ...FAMOUS_PROVIDER_ORDER, "unknown-last"];
		expect(sortedIds).toEqual(expected);

		const groups = [
			["openai-codex", "openai-codex-device"],
			["zai", "glm-zcode"],
			["alibaba-token-plan", "qwen-portal"],
			["kimi-code", "moonshot"],
			["minimax-code", "minimax-code-cn"],
			["xiaomi", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"],
		];
		for (const group of groups) {
			const start = sortedIds.indexOf(group[0]);
			expect(sortedIds.slice(start, start + group.length)).toEqual(group);
		}
	});

	test("never lets an unauthed famous provider outrank an invalid provider", () => {
		const invalidProviders = [
			provider("invalid-a", "invalid", "AAA invalid"),
			provider("invalid-b", "invalid", "ZZZ invalid"),
			provider("invalid-famous-shaped", "invalid", "Invalid famous-shaped"),
		];
		const famousProviders = FAMOUS_PROVIDER_ORDER.map(id => provider(id, "none", `Famous ${id}`));
		const sortedIds = sortRankedProviders([...famousProviders, ...invalidProviders]).map(entry => entry.id);
		const firstFamous = sortedIds.findIndex(id => FAMOUS_PROVIDER_ORDER.includes(id));
		expect(sortedIds.slice(0, firstFamous).sort()).toEqual(invalidProviders.map(entry => entry.id).sort());
		for (const invalid of invalidProviders) {
			for (const famous of famousProviders) {
				expect(compareRankedProviders(invalid, famous)).toBeLessThan(0);
			}
		}
	});

	test("never lets a tier-3 unknown provider outrank a tier-2 famous provider", () => {
		const famousProviders = FAMOUS_PROVIDER_ORDER.map(id => provider(id, "none", `Famous ${id}`));
		const unknownProviders = Array.from({ length: 16 }, (_, index) =>
			provider(`unknown-tier-three-${index}`, "none", `AAA ${index}`),
		);
		const sortedIds = sortRankedProviders([...unknownProviders, ...famousProviders]).map(entry => entry.id);
		const firstUnknown = sortedIds.findIndex(id => id.startsWith("unknown-tier-three-"));
		expect(sortedIds.slice(firstUnknown)).toEqual(unknownProviders.map(entry => entry.id).sort());
		for (const famous of famousProviders) {
			for (const unknown of unknownProviders) {
				expect(compareRankedProviders(famous, unknown)).toBeLessThan(0);
			}
		}
	});

	test("treats checking, valid, and configured as mutually indistinguishable", () => {
		const base = [
			provider("openai-codex", "none", "Codex"),
			provider("anthropic", "none", "Claude"),
			provider("custom-z", "none", "Zeta"),
			provider("custom-a", "none", "Alpha"),
		];
		const sequences = EXISTING_AUTH_STATES.map(authState =>
			sortRankedProviders(base.map(entry => ({ ...entry, authState }))).map(entry => entry.id),
		);
		expect(sequences[1]).toEqual(sequences[0]);
		expect(sequences[2]).toEqual(sequences[0]);

		for (let leftIndex = 0; leftIndex < base.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < base.length; rightIndex += 1) {
				const baseline = sign(
					compareRankedProviders(
						{ ...base[leftIndex], authState: "valid" },
						{ ...base[rightIndex], authState: "valid" },
					),
				);
				for (const leftState of EXISTING_AUTH_STATES) {
					for (const rightState of EXISTING_AUTH_STATES) {
						expect(
							sign(
								compareRankedProviders(
									{ ...base[leftIndex], authState: leftState },
									{ ...base[rightIndex], authState: rightState },
								),
							),
						).toBe(baseline);
					}
				}
			}
		}
	});
});

describe("/provider preset CLI surface", () => {
	test("preserves line format, includes all presets, and follows shared ranking", () => {
		const output = formatProviderPresetList();

		const lines = output.split("\n");
		expect(lines).toHaveLength(PROVIDER_PRESETS.length);
		for (const line of lines) {
			expect(line).toMatch(/^[a-z0-9][a-z0-9._-]*(?: \(aliases: [^)]*\))?: .+$/);
		}
		for (const preset of PROVIDER_PRESETS) {
			const aliases = preset.aliases.length > 0 ? ` (aliases: ${preset.aliases.join(", ")})` : "";
			expect(lines).toContain(`${preset.id}${aliases}: ${preset.description}`);
		}

		const expectedPresets = [...PROVIDER_PRESETS].sort((left, right) =>
			compareRankedProviders(
				{ id: presetRankingId(left), label: left.name, authState: "none" },
				{ id: presetRankingId(right), label: right.name, authState: "none" },
			),
		);
		const expectedLines = expectedPresets.map(preset => {
			const aliases = preset.aliases.length > 0 ? ` (aliases: ${preset.aliases.join(", ")})` : "";
			return `${preset.id}${aliases}: ${preset.description}`;
		});
		expect(lines).toEqual(expectedLines);
		expect(lines.map(line => line.match(/^([a-z0-9][a-z0-9._-]*)/)?.[1])).toEqual([
			"glm",
			"alibaba-token-plan",
			"minimax",
			"minimax-cn",
		]);
	});
});

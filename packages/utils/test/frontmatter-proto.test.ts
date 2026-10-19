import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "@gajae-code/utils";

const marker = "frontmatterProtoMarker";
const protoKey = "__proto__";

function own(record: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function reportPass(name: string): void {
	console.log(`(pass) ${name}`);
}

interface GeneratedRecord {
	[key: string]: GeneratedValue;
}

type GeneratedValue = string | number | boolean | null | GeneratedValue[] | GeneratedRecord;

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function dataRecord(entries: ReadonlyArray<readonly [string, GeneratedValue]>): Record<string, GeneratedValue> {
	const record: Record<string, GeneratedValue> = {};
	for (const [key, value] of entries) {
		Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
	}
	return record;
}

function generatedScalar(random: () => number): GeneratedValue {
	switch (Math.floor(random() * 4)) {
		case 0:
			return `value-${Math.floor(random() * 10_000)}`;
		case 1:
			return Math.floor(random() * 10_000);
		case 2:
			return random() < 0.5;
		default:
			return null;
	}
}

function generatedValue(random: () => number, depth: number): GeneratedValue {
	if (depth === 0) return generatedScalar(random);

	switch (Math.floor(random() * 3)) {
		case 0:
			return generatedScalar(random);
		case 1:
			return Array.from({ length: 1 + Math.floor(random() * 3) }, () => generatedValue(random, depth - 1));
		default:
			return dataRecord([
				["display-name", generatedValue(random, depth - 1)],
				[`nested-field-${Math.floor(random() * 16)}`, generatedValue(random, depth - 1)],
			]);
	}
}

function expectedKey(key: string): string {
	return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function normalizeGeneratedValue(value: GeneratedValue): GeneratedValue {
	if (Array.isArray(value)) return value.map(normalizeGeneratedValue);
	if (value !== null && typeof value === "object") {
		const record = value as GeneratedRecord;
		return dataRecord(
			Object.entries(record).map(([key, child]) => [expectedKey(key), normalizeGeneratedValue(child)] as const),
		);
	}
	return value;
}

function expectSafePrototypes(value: unknown, markerKey: string, markerValue: string, context: string): void {
	if (Array.isArray(value)) {
		expect(Object.getPrototypeOf(value), context).toBe(Array.prototype);
		for (const child of value) expectSafePrototypes(child, markerKey, markerValue, context);
		return;
	}
	if (value === null || typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	expect(Object.getPrototypeOf(record), context).toBe(Object.prototype);
	if (Object.hasOwn(record, protoKey)) {
		const payload = own(record, protoKey);
		expect(payload).not.toBeNull();
		expect(typeof payload).toBe("object");
		expect(Array.isArray(payload)).toBe(false);
		const payloadRecord = payload as Record<string, unknown>;
		const normalizedMarker = expectedKey(markerKey);
		expect(Object.hasOwn(payloadRecord, normalizedMarker), context).toBe(true);
		expect(payloadRecord[normalizedMarker], context).toBe(markerValue);
		expect(Object.hasOwn(record, normalizedMarker), context).toBe(false);
		expect(record[normalizedMarker], context).toBeUndefined();
	}
	for (const child of Object.values(record)) expectSafePrototypes(child, markerKey, markerValue, context);
}

describe("parseFrontmatter prototype keys", () => {
	test("preserves prototypes for seeded nested maps and arrays with __proto__ payloads", () => {
		const seed = 0x5eedc0de;
		const random = seededRandom(seed);

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const markerKey = `property-marker-${caseIndex}`;
			const markerValue = `payload-${Math.floor(random() * 10_000)}`;
			const generatedPayload = (): Record<string, GeneratedValue> =>
				dataRecord([
					["payload-name", generatedScalar(random)],
					[markerKey, markerValue],
					["payload-list", Array.from({ length: 1 + Math.floor(random() * 3) }, () => generatedValue(random, 2))],
				]);
			const generatedAttackMap = (): Record<string, GeneratedValue> =>
				dataRecord([
					[protoKey, generatedPayload()],
					["ordinary-field", generatedScalar(random)],
					["nested-map", dataRecord([["nested-field", generatedValue(random, 2)]])],
					["array-items", [generatedValue(random, 2), generatedValue(random, 2)]],
				]);
			const input = dataRecord([
				["case-id", caseIndex],
				[protoKey, generatedPayload()],
				["nested-map", generatedAttackMap()],
				["array-items", [generatedAttackMap(), generatedValue(random, 2)]],
				["ordinary-kebab-key", generatedScalar(random)],
			]);
			const yaml = Bun.YAML.stringify(input, null, 2);
			const parsed = parseFrontmatter(`---\n${yaml}\n---\nbody-${caseIndex}\n`, { level: "off" });
			const context = `seed ${seed}, case ${caseIndex}`;

			expect(parsed.frontmatter, context).toEqual(normalizeGeneratedValue(input) as GeneratedRecord);
			expect(parsed.body, context).toBe(`body-${caseIndex}`);
			expectSafePrototypes(parsed.frontmatter, markerKey, markerValue, context);
			expect(Object.hasOwn(Object.prototype, expectedKey(markerKey)), context).toBe(false);
		}
	}, 10_000);

	test("stores a __proto__ payload as data when that payload contains a kebab-case key", () => {
		const parsed = parseFrontmatter(
			`---
__proto__:
  thinking-level: low
  ${marker}: pwned
name: doc
---
body
`,
			{ level: "off" },
		);
		const frontmatter = parsed.frontmatter;
		expect(Object.hasOwn(frontmatter, protoKey)).toBe(true);
		expect(frontmatter.thinkingLevel).toBeUndefined();
		expect(frontmatter[marker]).toBeUndefined();
		expect(frontmatter.name).toBe("doc");
		const payload = own(frontmatter, protoKey) as Record<string, unknown>;
		expect(payload.thinkingLevel).toBe("low");
		expect(payload[marker]).toBe("pwned");
		expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
		expect(String(frontmatter)).toBe("[object Object]");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		expect(parsed.body).toBe("body");
		reportPass("stores a __proto__ payload as data when that payload contains a kebab-case key");
	});

	test("stores a nested __proto__ payload as data when that payload contains a kebab-case key", () => {
		const parsed = parseFrontmatter(
			`---
meta:
  __proto__:
    inner-key: v
    ${marker}: nested
title: doc
---
body
`,
			{ level: "off" },
		);
		const meta = parsed.frontmatter.meta as Record<string, unknown>;
		expect(Object.hasOwn(meta, protoKey)).toBe(true);
		expect(meta.innerKey).toBeUndefined();
		expect(meta[marker]).toBeUndefined();
		const payload = own(meta, protoKey) as Record<string, unknown>;
		expect(payload.innerKey).toBe("v");
		expect(payload[marker]).toBe("nested");
		expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
		expect(String(meta)).toBe("[object Object]");
		expect(parsed.frontmatter.title).toBe("doc");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		reportPass("stores a nested __proto__ payload as data when that payload contains a kebab-case key");
	});

	test("keeps ordinary kebab-case frontmatter keys", () => {
		const parsed = parseFrontmatter(
			`---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content
`,
			{ level: "off" },
		);
		expect(parsed.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(String(parsed.frontmatter)).toBe("[object Object]");
		expect(String(parsed.frontmatter.nestedField)).toBe("[object Object]");
		expect(parsed.body).toBe("Body content");
		reportPass("keeps ordinary kebab-case frontmatter keys");
	});

	test("keeps string conversion of an object frontmatter value", () => {
		const parsed = parseFrontmatter(
			`---
description:
  display-name: example
---
Prompt body
`,
			{ level: "off" },
		);
		const description = parsed.frontmatter.description as Record<string, unknown>;
		expect(description.displayName).toBe("example");
		expect(String(description)).toBe("[object Object]");
		expect(String(parsed.frontmatter)).toBe("[object Object]");
		reportPass("keeps string conversion of an object frontmatter value");
	});

	test("keeps an own __proto__ key when no frontmatter key is rewritten", () => {
		const parsed = parseFrontmatter(
			`---
__proto__:
  ${marker}: plain
name: doc
---
body
`,
			{ level: "off" },
		);
		expect(Object.hasOwn(parsed.frontmatter, protoKey)).toBe(true);
		expect(parsed.frontmatter[marker]).toBeUndefined();
		expect(parsed.frontmatter.name).toBe("doc");
		const payload = own(parsed.frontmatter, protoKey) as Record<string, unknown>;
		expect(payload[marker]).toBe("plain");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		reportPass("keeps an own __proto__ key when no frontmatter key is rewritten");
	});
});

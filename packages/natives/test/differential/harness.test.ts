import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	compareGoldens,
	defineDifferential,
	inputHash,
	readGoldens,
	recordGoldens,
	verifyDifferential,
} from "./harness";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; golden: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-diffcheck-"));
	roots.push(root);
	return { root, golden: path.join(root, "golden", "fixture.jsonl") };
}

function identityDefinition(
	native: (input: { text: string }) => unknown = input => ({ normalized: input.text }),
): ReturnType<typeof defineDifferential<{ text: string }, unknown>> {
	return defineDifferential({
		module: "fixture",
		cases: [{ id: "stable-id", input: { text: "input" } }],
		reference: input => ({ normalized: input.text }),
		native,
	});
}

describe("differential golden harness", () => {
	test("records canonical inputs with stable hashes and verifies live reference + native output", async () => {
		const { golden } = await fixture();
		const definition = identityDefinition();
		const records = await recordGoldens(definition, golden);
		expect(records[0]?.inputHash).toBe(inputHash({ text: "input" }));
		expect(await readGoldens(golden)).toEqual(records);
		expect(await verifyDifferential(definition, golden)).toEqual({
			total: 1,
			identical: 1,
			accepted: [],
			unlisted: [],
			stale: [],
		});
	});

	test("compares against committed goldens without a live reference and refuses to record without one", async () => {
		const { golden } = await fixture();
		const withReference = identityDefinition();
		const records = await recordGoldens(withReference, golden);
		const noReference = defineDifferential({
			module: withReference.module,
			cases: withReference.cases,
			native: withReference.native,
		});
		expect(await compareGoldens(noReference, records)).toMatchObject({ identical: 1, unlisted: [], stale: [] });
		await expect(recordGoldens(noReference, golden)).rejects.toThrow("record mode requires a live reference");
	});

	test("reports divergent native output, an unrecorded input, and stale golden cases", async () => {
		const { golden } = await fixture();
		const definition = identityDefinition();
		const records = await recordGoldens(definition, golden);
		const changed = identityDefinition(() => ({ normalized: "wrong" }));
		expect(await compareGoldens(changed, records)).toEqual({
			total: 1,
			identical: 0,
			accepted: [],
			unlisted: ["stable-id"],
			stale: [],
		});
		const accepted = defineDifferential({
			...changed,
			accepted: new Map([["stable-id", { reason: "documented upstream change" }]]),
		});
		expect(await compareGoldens(accepted, records)).toEqual({
			total: 1,
			identical: 0,
			accepted: ["stable-id"],
			unlisted: [],
			stale: [],
		});
		const changedInput = defineDifferential({
			...definition,
			cases: [{ id: "stable-id", input: { text: "different" } }],
		});
		const report = await compareGoldens(changedInput, [...records, { ...records[0]!, caseId: "removed-case" }]);
		expect(report.unlisted).toEqual(["stable-id"]);
		expect(report.stale).toEqual(["removed-case"]);
	});

	test("rejects duplicate case IDs, duplicate golden IDs and malformed JSONL", async () => {
		expect(() =>
			defineDifferential({
				...identityDefinition(),
				cases: [
					{ id: "same", input: 1 },
					{ id: "same", input: 2 },
				],
			}),
		).toThrow("duplicate differential case id");
		const { golden } = await fixture();
		const record = (await recordGoldens(identityDefinition(), golden))[0]!;
		await fs.writeFile(golden, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);
		await expect(readGoldens(golden)).rejects.toThrow("duplicate golden case id");
		await fs.writeFile(golden, "{bad json}\n");
		await expect(readGoldens(golden)).rejects.toThrow("invalid golden JSONL");
	});
});

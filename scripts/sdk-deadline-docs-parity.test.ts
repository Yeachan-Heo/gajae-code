import { expect, test } from "bun:test";
import * as path from "node:path";
import { getDefault } from "@gajae-code/coding-agent/config/settings-schema";

/**
 * Issue #5637: commit 5a549a3b1 raised `sdk.promptDeadlineMs` from 30 to 60 minutes but left
 * every prose statement of the figure stale, including the shipped `gjc-sdk-operate` skill.
 * These assertions derive the expected figure from the schema, so the next default change
 * fails here instead of silently misinforming SDK clients about when their turn dies.
 *
 * The generated `sdk-skills/` bundle is deliberately not checked: `bun run check:sdk-skills`
 * already fails on any drift from `scripts/gjc-sdk-skills/prompts/`.
 */
const repoRoot = path.join(import.meta.dir, "..");

const deadlineMs = getDefault("sdk.promptDeadlineMs");
const deadlineMinutes = deadlineMs / 60_000;

/** `3600000` -> `3_600_000`, the numeric-separator form the `docs/*.md` prose uses. */
function withUnderscores(value: number): string {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

/** Figures the prose is allowed to state, in every rendering the tracked files use. */
const current = {
	msUnderscored: withUnderscores(deadlineMs),
	msPlain: String(deadlineMs),
	minutes: deadlineMinutes,
};

/** Renderings of the pre-#5583 30-minute default. Filtered against `current` below. */
const LEGACY_RENDERINGS = ["1_800_000", "1800000", "30 min", "30 minutes", "30분", "30 분", "30 分"];

/** The figure each file must state, keyed by the unit and locale that file writes in. */
const TRACKED_DOCS: ReadonlyArray<{ file: string; figure: string }> = [
	{ file: "README.md", figure: `${current.minutes} min` },
	{ file: "README.ja.md", figure: `${current.minutes} 分` },
	{ file: "README.ko.md", figure: `${current.minutes}분` },
	{ file: "docs/sdk.md", figure: `\`${current.msUnderscored}\`` },
	{ file: "docs/bot-integration.md", figure: `\`${current.msUnderscored}\`` },
	{ file: "docs/hermes-mcp-bridge.md", figure: `\`${current.msUnderscored}\`` },
	{ file: "docs/acp-local-development.md", figure: `${current.minutes} minutes` },
	{ file: "scripts/gjc-sdk-skills/prompts/operate.md", figure: `${current.minutes} min` },
];

/**
 * Only lines that name the setting are in scope. A whole-file search for "30 min" would fire
 * on unrelated prose (detached-idle grace, cron jitter, the `task.maxRuntimeMs` dropdown) and
 * would be a false guard rather than a regression guard.
 */
async function deadlineLines(file: string): Promise<{ lineNumber: number; text: string }[]> {
	const text = await Bun.file(path.join(repoRoot, file)).text();
	return text
		.split("\n")
		.map((line, index) => ({ lineNumber: index + 1, text: line }))
		.filter((line) => line.text.includes("promptDeadlineMs"));
}

test("the sdk.promptDeadlineMs default renders as whole minutes", () => {
	// The READMEs and the operate skill state the deadline in minutes; a default that is not a
	// whole number of minutes would make "N min" unstatable and must be caught here.
	expect(Number.isInteger(deadlineMinutes)).toBe(true);
});

for (const { file, figure } of TRACKED_DOCS) {
	test(`${file} states the current sdk.promptDeadlineMs default`, async () => {
		const lines = await deadlineLines(file);
		expect(lines.length).toBeGreaterThan(0);

		const stating = lines.filter((line) => line.text.includes(figure));
		if (stating.length === 0) {
			throw new Error(
				`${file} never states the current sdk.promptDeadlineMs default (${figure}) on a line mentioning the setting.\n` +
					`The schema default is ${current.msUnderscored} ms (${current.minutes} min); update the prose to match.\n` +
					lines.map((line) => `  ${file}:${line.lineNumber}: ${line.text}`).join("\n"),
			);
		}
	});

	test(`${file} states no superseded sdk.promptDeadlineMs figure`, async () => {
		// Drop any legacy rendering that the current default has come back around to, so the check
		// never contradicts the positive assertion above.
		const stale = LEGACY_RENDERINGS.filter(
			(rendering) =>
				rendering !== current.msUnderscored && rendering !== current.msPlain && !figure.includes(rendering),
		);

		const offenders = (await deadlineLines(file)).flatMap((line) =>
			stale
				.filter((rendering) => line.text.includes(rendering))
				.map((rendering) => `  ${file}:${line.lineNumber} still states "${rendering}": ${line.text}`),
		);

		if (offenders.length > 0) {
			throw new Error(
				`${file} states a superseded sdk.promptDeadlineMs figure; the schema default is ${current.msUnderscored} ms (${current.minutes} min).\n` +
					offenders.join("\n"),
			);
		}
	});
}

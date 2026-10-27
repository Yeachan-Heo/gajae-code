// A/B adapter for word-level intra-line diff rendering.
//
// The A/B runner installs this file into the base worktree too, so both sides
// time the same fixtures through the same public entrypoint (`renderDiff`),
// which computes a word diff for every adjacent removed/added line pair. Only
// the implementation behind it differs (jsdiff on base, native on head).
import { Settings } from "../../coding-agent/src/config/settings";
import { renderDiff } from "../../coding-agent/src/modes/components/diff";
import { initTheme } from "../../coding-agent/src/modes/theme/theme";
import { runAbSuite } from "./ab-adapter";

await initTheme("dark");
await Settings.init({ inMemory: true, cwd: process.cwd() });

interface Fixture {
	id: string;
	diffText: string;
}

function makeFixture(id: string, pairCount: number): Fixture {
	const lines: string[] = [];
	for (let index = 0; index < pairCount; index++) {
		const base = `const record${index} = compute(alpha, amber, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, ${index});`;
		const edited = base.replace("amber", "violet").replace("theta", `theta${index % 7}`);
		const lineNo = String(index + 1).padStart(4, " ");
		lines.push(`-${lineNo}|${base}`);
		lines.push(`+${lineNo}|${edited}`);
	}
	return { id, diffText: lines.join("\n") };
}

const fixtures = [makeFixture("D01", 10), makeFixture("D02", 100), makeFixture("D03", 500)];

for (const fixture of fixtures) {
	const rendered = await renderDiff(fixture.diffText);
	if (typeof rendered !== "string" || rendered.length < fixture.diffText.length) {
		throw new Error(`${fixture.id}: renderDiff produced unexpectedly short output`);
	}
}

await runAbSuite(
	"word-diff",
	fixtures.map(fixture => ({
		id: fixture.id,
		run: () => renderDiff(fixture.diffText),
	})),
	20,
);

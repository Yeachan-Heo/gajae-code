import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import {
	AUTOROUTING_TIERS,
	type AutoroutingEffective,
	type AutoroutingProvenance,
	matchesRecordedTiersFingerprint,
	validateAutoroutingProvenance,
} from "../../config/autorouting-contract";
import { validateDisplayLine } from "../../modes/components/ansi-display-validator";

/** Longest rendered chain/diagnostic before truncation. */
const MAX_STATUS_LINE_WIDTH = 200;

/**
 * Selectors and diagnostics originate in user-editable config, so a hand-edited
 * value can carry tabs or terminal control sequences. Strip them before the
 * string reaches a renderer.
 */
function displaySafe(text: string): string {
	return truncateToWidth(validateDisplayLine(replaceTabs(text)), MAX_STATUS_LINE_WIDTH);
}

export type AutoroutingStatusSnapshot = {
	effective: AutoroutingEffective;
	tiers: unknown;
	provenance: AutoroutingProvenance | undefined;
};

/** Render settings-derived autorouting state without consulting registry/auth. */
export function buildAutoroutingStatusReport(snapshot: AutoroutingStatusSnapshot): string {
	const { effective, tiers, provenance } = snapshot;
	if (!effective.active) {
		const detail =
			effective.issue?.detail ?? "Autorouting is disabled; every Task item uses manual model resolution.";
		return `Autorouting: off\n${displaySafe(detail)}`;
	}
	const provenanceIssues = provenance === undefined ? [] : validateAutoroutingProvenance(provenance);
	const malformed = provenanceIssues.length > 0;
	const generated = !malformed && provenance !== undefined && matchesRecordedTiersFingerprint(provenance, tiers);
	const label = malformed
		? "hand-authored tiers"
		: generated
			? "generated"
			: provenance === undefined
				? "hand-authored tiers"
				: "generated, hand-edited";
	const lines = [`Autorouting: on (${label})`];
	if (malformed) lines.push("Recorded generation provenance is invalid; treating tiers as hand-authored.");
	for (const tier of AUTOROUTING_TIERS) {
		const chain = effective.map[tier];
		const rendered = chain && chain.length > 0 ? displaySafe(chain.join(" -> ")) : "(unmapped, falls back to manual)";
		lines.push(`  ${tier}: ${rendered}`);
	}
	return lines.join("\n");
}

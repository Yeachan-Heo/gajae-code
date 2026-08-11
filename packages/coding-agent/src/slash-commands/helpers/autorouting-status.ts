import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import { AUTOROUTING_TIERS, type AutoroutingEffective } from "../../config/autorouting-contract";
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

/**
 * Render the durable autorouting state as plain text.
 *
 * Only settings-derived facts are reported; catalog freshness and generated
 * provenance belong to the interactive smart-routing panel.
 */
export function buildAutoroutingStatusReport(effective: AutoroutingEffective): string {
	if (!effective.active) {
		const detail =
			effective.issue?.detail ?? "Autorouting is disabled; every Task item uses manual model resolution.";
		return `Autorouting: off\n${displaySafe(detail)}`;
	}
	const source =
		effective.source === "tiers" ? "generated/explicit tiers" : `preset ${displaySafe(effective.source.preset)}`;
	const lines = [`Autorouting: on (${source})`];
	for (const tier of AUTOROUTING_TIERS) {
		const chain = effective.map[tier];
		const rendered = chain && chain.length > 0 ? displaySafe(chain.join(" -> ")) : "(unmapped, falls back to manual)";
		lines.push(`  ${tier}: ${rendered}`);
	}
	return lines.join("\n");
}

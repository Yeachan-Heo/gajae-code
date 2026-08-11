import { AUTOROUTING_TIERS, type AutoroutingEffective } from "../../config/autorouting-contract";

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
		return `Autorouting: off\n${detail}`;
	}
	const source = effective.source === "tiers" ? "generated/explicit tiers" : `preset ${effective.source.preset}`;
	const lines = [`Autorouting: on (${source})`];
	for (const tier of AUTOROUTING_TIERS) {
		const chain = effective.map[tier];
		lines.push(`  ${tier}: ${chain && chain.length > 0 ? chain.join(" -> ") : "(unmapped, falls back to manual)"}`);
	}
	return lines.join("\n");
}

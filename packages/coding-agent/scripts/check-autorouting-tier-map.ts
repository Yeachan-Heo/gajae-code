#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RETIRED_MODEL_KEYS } from "../../ai/src/model-retirements";
import { isValidAutoroutingSelector } from "../src/config/autorouting-contract";
import {
	CURATED_TIER_LABELS,
	type CuratedTierLabels,
	TIER_MAP_SKIP_LIST,
	type TierMapSkipList,
} from "../src/config/autorouting-tier-map";

export const BASELINE_SKIP_RATIONALE = "pre-feature baseline; not yet curated";
const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm"]);
const RETIRED_KEYS = new Set<string>(RETIRED_MODEL_KEYS);

export type CommittedCatalogModel = {
	id?: unknown;
	provider?: unknown;
	output?: unknown;
	[key: string]: unknown;
};

export type CommittedCatalog = Record<string, Record<string, CommittedCatalogModel>>;

export type AutoroutingTierMapGateReport = {
	inScopeKeys: string[];
	labeledKeys: string[];
	skippedKeys: string[];
	unlabeledKeys: string[];
	invalidLabelKeys: string[];
	outOfScopeLabelKeys: string[];
	baselineSkipCount: number;
};

function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function isImageGenerationOnly(model: CommittedCatalogModel): boolean {
	return Array.isArray(model.output) && model.output.includes("image");
}

export function isInAutoroutingGateScope(provider: string, id: string, model: CommittedCatalogModel): boolean {
	const key = modelKey(provider, id);
	return (
		isValidAutoroutingSelector(key) &&
		!RETIRED_KEYS.has(key) &&
		!DISCOVERY_ONLY_PROVIDERS.has(provider) &&
		!isImageGenerationOnly(model)
	);
}

export function committedCatalogKeys(catalog: CommittedCatalog): string[] {
	const keys: string[] = [];
	for (const [provider, models] of Object.entries(catalog)) {
		if (models === null || typeof models !== "object" || Array.isArray(models)) continue;
		for (const [id, model] of Object.entries(models)) {
			if (isInAutoroutingGateScope(provider, id, model)) keys.push(modelKey(provider, id));
		}
	}
	return keys.sort((left, right) => left.localeCompare(right));
}

export function getAutoroutingTierMapGateReport(
	catalog: CommittedCatalog,
	labels: CuratedTierLabels = CURATED_TIER_LABELS,
	skips: TierMapSkipList = TIER_MAP_SKIP_LIST,
): AutoroutingTierMapGateReport {
	const catalogKeys = new Set(committedCatalogKeys(catalog));
	const labeledKeys = Object.keys(labels).sort((left, right) => left.localeCompare(right));
	const skippedKeys = Object.keys(skips).sort((left, right) => left.localeCompare(right));
	const invalidLabelKeys = labeledKeys.filter(key => !catalogKeys.has(key));
	const outOfScopeLabelKeys = labeledKeys.filter(key => {
		const separator = key.indexOf("/");
		const provider = separator > 0 ? key.slice(0, separator) : key;
		const id = separator > 0 ? key.slice(separator + 1) : "";
		const rawModel = catalog[provider]?.[id];
		return rawModel !== undefined && !isInAutoroutingGateScope(provider, id, rawModel);
	});
	const unlabeledKeys = [...catalogKeys].filter(key => !Object.hasOwn(labels, key) && !Object.hasOwn(skips, key));
	const inScopeKeys = [...catalogKeys];
	const inScopeSkipped = skippedKeys.filter(key => catalogKeys.has(key));
	return {
		inScopeKeys,
		labeledKeys,
		skippedKeys: inScopeSkipped,
		unlabeledKeys: unlabeledKeys.sort((left, right) => left.localeCompare(right)),
		invalidLabelKeys,
		outOfScopeLabelKeys,
		baselineSkipCount: inScopeSkipped.filter(
			key => (skips as Record<string, { baseline?: true }>)[key]?.baseline === true,
		).length,
	};
}

export function findUnlabeledAutoroutingKeys(
	catalog: CommittedCatalog,
	labels: CuratedTierLabels = CURATED_TIER_LABELS,
	skips: TierMapSkipList = TIER_MAP_SKIP_LIST,
): string[] {
	return getAutoroutingTierMapGateReport(catalog, labels, skips).unlabeledKeys;
}

export type AutoroutingTierMapGateResult = {
	ok: boolean;
	report: AutoroutingTierMapGateReport;
};

export function checkAutoroutingTierMap(
	catalog: CommittedCatalog,
	labels: CuratedTierLabels = CURATED_TIER_LABELS,
	skips: TierMapSkipList = TIER_MAP_SKIP_LIST,
): AutoroutingTierMapGateResult {
	const report = getAutoroutingTierMapGateReport(catalog, labels, skips);
	const ok =
		report.unlabeledKeys.length === 0 &&
		report.invalidLabelKeys.length === 0 &&
		report.outOfScopeLabelKeys.length === 0;
	return { ok, report };
}

export async function loadCommittedCatalog(
	repoRoot = path.resolve(import.meta.dir, "../../.."),
): Promise<CommittedCatalog> {
	const catalogPath = path.join(repoRoot, "packages/ai/src/models.json");
	return JSON.parse(await fs.readFile(catalogPath, "utf8")) as CommittedCatalog;
}

export async function runAutoroutingTierMapGate(repoRoot?: string): Promise<AutoroutingTierMapGateResult> {
	return checkAutoroutingTierMap(await loadCommittedCatalog(repoRoot));
}

export const checkTierMap = checkAutoroutingTierMap;
export const findUnlabeledKeys = findUnlabeledAutoroutingKeys;
export const runTierMapGate = runAutoroutingTierMapGate;

function printFailure(report: AutoroutingTierMapGateReport): void {
	const failures = [
		...new Set([...report.unlabeledKeys, ...report.invalidLabelKeys, ...report.outOfScopeLabelKeys]),
	].sort((a, b) => a.localeCompare(b));
	console.error("Autorouting tier-map gate failed.");
	console.error("Offending provider/model-id keys:");
	for (const key of failures) console.error(`- ${key}`);
	console.error(
		"Add each new key to CURATED_TIER_LABELS with reviewed tier/rank data, or add it to TIER_MAP_SKIP_LIST with a non-empty rationale.",
	);
}

if (import.meta.main) {
	const result = await runAutoroutingTierMapGate();
	if (!result.ok) {
		printFailure(result.report);
		process.exitCode = 1;
	} else {
		console.log(
			`Autorouting tier-map gate passed: ${result.report.inScopeKeys.length} in-scope keys; ${result.report.baselineSkipCount} baseline skips.`,
		);
	}
}

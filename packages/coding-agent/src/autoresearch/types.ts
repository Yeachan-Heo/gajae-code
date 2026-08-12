/**
 * Shared types for the rebuilt autoresearch capability modules.
 *
 * These mirror the deleted extension's `types.ts` surface (metrics, ASI,
 * experiment statuses) without the extension-only runtime types (dashboards,
 * tool factories, session entries). The mission/verdict/ledger types live in
 * `gjc-runtime/autoresearch-runtime.ts`; run storage and dashboard models live
 * in `runs.ts` / `dashboard.ts`.
 */

export type MetricDirection = "lower" | "higher";
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

export interface ASIData {
	[key: string]: ASIValue;
}

export interface NumericMetricMap {
	[key: string]: number;
}

export interface MetricDef {
	name: string;
	unit: string;
}

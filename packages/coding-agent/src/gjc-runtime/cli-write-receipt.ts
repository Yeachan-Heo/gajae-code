/**
 * CLI write/mutation receipt shaping (Workstream B, v4).
 *
 * `CliWriteReceipt` is the compact **stdout presentation** returned by a GJC
 * mutation command. It carries only routing/audit fields a caller needs; it
 * NEVER echoes the persisted body (full `state` envelope, ultragoal `plan`,
 * team task body, ralplan `task`, etc.) — echoing those back is a redundant
 * token leak because the caller already has the content it just wrote.
 *
 * This is intentionally a *separate* concept from the persisted
 * `WorkflowStateReceipt` (the on-disk envelope `receipt` integrity field).
 * Do NOT use `CliWriteReceipt` as a persistence schema or validate persisted
 * envelopes against it.
 */
export interface CliWriteReceipt {
	ok: boolean;
	[field: string]: unknown;
}

/**
 * Serialize a write/mutation receipt to compact stdout JSON.
 * `undefined` fields are dropped so optional routing fields stay absent
 * rather than serialized as `null`.
 */
export function renderCliWriteReceipt(receipt: Record<string, unknown>): string {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(receipt)) {
		if (receipt[key] !== undefined) out[key] = receipt[key];
	}
	return `${JSON.stringify(out)}\n`;
}

import applyReceiptSchema from "./apply-receipt.v1.json" with { type: "json" };
import auditSchema from "./audit.v1.json" with { type: "json" };
import capabilitiesSchema from "./capabilities.v1.json" with { type: "json" };
import checkpointSchema from "./checkpoint.v1.json" with { type: "json" };
import errorSchema from "./error.v1.json" with { type: "json" };
import forgetReceiptSchema from "./forget-receipt.v1.json" with { type: "json" };
import handoffSchema from "./handoff.v1.json" with { type: "json" };
import initReceiptSchema from "./init-receipt.v1.json" with { type: "json" };
import recallSchema from "./recall.v1.json" with { type: "json" };
import resourceSchema from "./resource.v1.json" with { type: "json" };
import retrievalLedgerEntrySchema from "./retrieval-ledger-entry.v1.json" with { type: "json" };
import scopeResolutionSchema from "./scope-resolution.v1.json" with { type: "json" };
import searchResultSchema from "./search-result.v1.json" with { type: "json" };
import writeProposalSchema from "./write-proposal.v1.json" with { type: "json" };

export interface MemoryJsonSchema {
	readonly $id: string;
	readonly $schema?: string;
	readonly title?: string;
	readonly type?: string;
	readonly [key: string]: unknown;
}

export const SCHEMA_REGISTRY = Object.freeze({
	capabilities: capabilitiesSchema,
	initReceipt: initReceiptSchema,
	scopeResolution: scopeResolutionSchema,
	searchResult: searchResultSchema,
	recall: recallSchema,
	retrievalLedgerEntry: retrievalLedgerEntrySchema,
	error: errorSchema,
	checkpoint: checkpointSchema,
	handoff: handoffSchema,
	audit: auditSchema,
	writeProposal: writeProposalSchema,
	applyReceipt: applyReceiptSchema,
	forgetReceipt: forgetReceiptSchema,
	resource: resourceSchema,
} as const satisfies Readonly<Record<string, MemoryJsonSchema>>);

export const SCHEMA_VERSIONS = Object.freeze({
	capabilities: "gajae.memory.capabilities.v1",
	initReceipt: "gajae.memory.init-receipt.v1",
	scopeResolution: "gajae.memory.scope-resolution.v1",
	searchResult: "gajae.memory.search-result.v1",
	recall: "gajae.memory.recall.v1",
	retrievalLedgerEntry: "gajae.memory.retrieval-ledger-entry.v1",
	error: "gajae.memory.error.v1",
	checkpoint: "gajae.memory.checkpoint.v1",
	handoff: "gajae.memory.handoff.v1",
	audit: "gajae.memory.audit.v1",
	writeProposal: "gajae.memory.write-proposal.v1",
	applyReceipt: "gajae.memory.apply-receipt.v1",
	forgetReceipt: "gajae.memory.forget-receipt.v1",
	resource: "gajae.memory.resource.v1",
} as const);

export type MemorySchemaName = keyof typeof SCHEMA_REGISTRY;
export type MemorySchemaVersion = (typeof SCHEMA_VERSIONS)[keyof typeof SCHEMA_VERSIONS];

export {
	applyReceiptSchema,
	auditSchema,
	capabilitiesSchema,
	checkpointSchema,
	errorSchema,
	forgetReceiptSchema,
	handoffSchema,
	initReceiptSchema,
	recallSchema,
	resourceSchema,
	retrievalLedgerEntrySchema,
	scopeResolutionSchema,
	searchResultSchema,
	writeProposalSchema,
};

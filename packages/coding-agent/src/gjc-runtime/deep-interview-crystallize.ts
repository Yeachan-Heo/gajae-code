import { createHash } from "node:crypto";

export type CrystalClassification = "confirmed" | "inferred" | "disputed";
export type CrystalItemKind = "goal" | "constraint" | "decision" | "acceptance_criterion" | "non_goal";

export interface CrystalMessage {
	index: number;
	role: "user" | "assistant" | "system" | "tool" | "toolResult" | "developer";
	content: string;
}

export interface CrystalSnapshot {
	revision: number;
	start: number;
	end: number;
	digest: string;
	messages: CrystalMessage[];
}

export interface CrystalItem {
	id: string;
	kind: CrystalItemKind;
	classification: CrystalClassification;
	statement: string;
	anchor?: { message_index: number; quote: string };
}

export interface CrystalInput {
	snapshot: CrystalSnapshot;
	current_revision: number;
	items: CrystalItem[];
	removed_ids?: string[];
	open_gaps?: string[];
	conflicts?: string[];
	prior?: DeepInterviewCrystal;
}

export interface CrystalDelta {
	kind: "none" | "additive" | "intent-changed" | "goal-replaced" | "stale";
	changed_ids: string[];
	added_ids: string[];
	preserved_ids: string[];
	approval_invalidated: boolean;
}

export interface DeepInterviewCrystal {
	schema_version: 1;
	spec_version: number;
	lifecycle: "ready" | "needs-questions" | "stale" | "superseded";
	source: { revision: number; start: number; end: number; digest: string };
	items: CrystalItem[];
	removed_ids?: string[];
	open_gaps: string[];
	conflicts: string[];
	delta: CrystalDelta;
	execution_approval: "not-approved";
}

const MAX_MESSAGES = 200;
const MAX_ITEMS = 128;
const MAX_TEXT = 10_000;
const ITEM_KINDS: readonly CrystalItemKind[] = ["goal", "constraint", "decision", "acceptance_criterion", "non_goal"];
const CLASSIFICATIONS: readonly CrystalClassification[] = ["confirmed", "inferred", "disputed"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, name: string, max = MAX_TEXT): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be non-empty text`);
	const result = value.normalize("NFC").trim();
	if ([...result].length > max) throw new Error(`${name} exceeds max length ${max}`);
	return result;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a non-negative integer`);
	return value;
}

export function crystalSnapshotDigest(
	snapshot: Pick<CrystalSnapshot, "revision" | "start" | "end" | "messages">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				revision: snapshot.revision,
				start: snapshot.start,
				end: snapshot.end,
				messages: snapshot.messages.map(message => ({
					...message,
					content: message.content.normalize("NFC").trim(),
				})),
			}),
		)
		.digest("hex");
}

function validateSnapshot(value: unknown): CrystalSnapshot {
	if (!isRecord(value)) throw new Error("crystallize snapshot is required");
	const revision = integer(value.revision, "snapshot.revision");
	const start = integer(value.start, "snapshot.start");
	const end = integer(value.end, "snapshot.end");
	if (end < start) throw new Error("snapshot.end must be >= snapshot.start");
	if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES)
		throw new Error("snapshot.messages must be bounded");
	const messages = value.messages.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`snapshot.messages[${index}] is invalid`);
		const messageIndex = integer(entry.index, `snapshot.messages[${index}].index`);
		if (messageIndex < start || messageIndex > end) throw new Error("snapshot message is outside its declared range");
		const role = entry.role as CrystalMessage["role"];
		if (
			role !== "user" &&
			role !== "assistant" &&
			role !== "system" &&
			role !== "tool" &&
			role !== "toolResult" &&
			role !== "developer"
		)
			throw new Error("snapshot message role is invalid");
		return { index: messageIndex, role, content: text(entry.content, `snapshot.messages[${index}].content`) };
	});
	if (messages.some((message, index) => index > 0 && message.index <= messages[index - 1]!.index))
		throw new Error("snapshot messages must be ordered and unique");
	if (end - start + 1 > MAX_MESSAGES) throw new Error("snapshot range is too large");
	if (messages.length !== end - start + 1 || messages.some((message, index) => message.index !== start + index))
		throw new Error("snapshot messages must cover the declared range");
	const digest = text(value.digest, "snapshot.digest", 64);
	if (!/^[a-f0-9]{64}$/.test(digest) || digest !== crystalSnapshotDigest({ revision, start, end, messages }))
		throw new Error("snapshot digest mismatch");
	return { revision, start, end, digest, messages };
}

function validateItems(value: unknown, snapshot?: CrystalSnapshot): CrystalItem[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error("crystallize items must be a bounded array");
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`crystallize item ${index} is invalid`);
		const id = text(entry.id, `items[${index}].id`, 128);
		if (ids.has(id)) throw new Error(`duplicate crystallize item: ${id}`);
		ids.add(id);
		if (!ITEM_KINDS.includes(entry.kind as CrystalItemKind)) throw new Error(`items[${index}].kind is invalid`);
		if (!CLASSIFICATIONS.includes(entry.classification as CrystalClassification))
			throw new Error(`items[${index}].classification is invalid`);
		const item: CrystalItem = {
			id,
			kind: entry.kind as CrystalItemKind,
			classification: entry.classification as CrystalClassification,
			statement: text(entry.statement, `items[${index}].statement`),
		};
		if (item.classification === "confirmed") {
			if (!isRecord(entry.anchor)) throw new Error(`confirmed item ${id} requires a verbatim anchor`);
			item.anchor = {
				message_index: integer(entry.anchor.message_index, `items[${index}].anchor.message_index`),
				quote: text(entry.anchor.quote, `items[${index}].anchor.quote`),
			};
			if (snapshot) {
				const anchorMessage = snapshot.messages.find(
					message => String(message.index) === String(item.anchor!.message_index),
				);
				if (!anchorMessage)
					throw new Error(`confirmed item ${id} anchor message ${item.anchor!.message_index} is missing`);
				if (
					anchorMessage.role !== "user" ||
					/\[(?:image|audio|video|file|content)\]/i.test(item.anchor.quote) ||
					/^(?:\[[^\]]+\])+$/.test(anchorMessage.content) ||
					!anchorMessage.content.includes(item.anchor.quote)
				)
					throw new Error(`confirmed item ${id} has no verbatim user anchor`);
			}
		}
		return item;
	});
}

function normalizedGaps(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 16) throw new Error("open_gaps must be a bounded array");
	return value.map((gap, index) => text(gap, `open_gaps[${index}]`, 500));
}

function validateRemovedIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error("removed_ids must be a bounded array");
	const ids = value.map((id, index) => text(id, `removed_ids[${index}]`, 128));
	if (new Set(ids).size !== ids.length) throw new Error("removed_ids must be unique");
	return ids.sort();
}

export function crystallizeDeepInterview(value: unknown): DeepInterviewCrystal {
	if (!isRecord(value)) throw new Error("crystallize input must be an object");
	const snapshot = validateSnapshot(value.snapshot);
	if (value.current_revision === undefined) throw new Error("authoritative current revision is required");
	if (integer(value.current_revision, "current_revision") !== snapshot.revision)
		throw new Error("conversation snapshot is stale");
	const items = validateItems(value.items, snapshot);
	if (snapshot.messages.length === 0 || items.length === 0)
		throw new Error("crystallize requires material conversation evidence");
	if (!items.some(item => item.classification === "confirmed" && item.kind !== "non_goal"))
		throw new Error("crystallize requires a confirmed user requirement");
	const removedIds = value.removed_ids === undefined ? [] : validateRemovedIds(value.removed_ids);
	if (removedIds.some(id => items.some(item => item.id === id)))
		throw new Error("removed_ids must be disjoint from submitted items");
	const gaps = normalizedGaps(value.open_gaps);
	if (gaps.length > 2) throw new Error("broad ambiguity requires the full deep-interview flow");
	const conflicts = normalizedGaps(value.conflicts);
	const prior = value.prior;
	if (prior !== undefined && !isRecord(prior)) throw new Error("prior crystal is invalid");
	const priorCrystal = prior as DeepInterviewCrystal | undefined;
	let canonicalPriorItems: CrystalItem[] = [];
	if (priorCrystal) {
		if (
			priorCrystal.schema_version !== 1 ||
			!Number.isSafeInteger(priorCrystal.spec_version) ||
			priorCrystal.spec_version < 1
		)
			throw new Error("prior crystal is invalid");
		if (!isRecord(priorCrystal.source) || snapshot.revision <= priorCrystal.source.revision)
			throw new Error("conversation snapshot is stale");
		if (!Array.isArray(priorCrystal.items)) throw new Error("prior crystal is invalid");
		if (
			!Number.isSafeInteger(priorCrystal.source.revision) ||
			!Number.isSafeInteger(priorCrystal.source.start) ||
			!Number.isSafeInteger(priorCrystal.source.end) ||
			typeof priorCrystal.source.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(priorCrystal.source.digest) ||
			!isRecord(priorCrystal.delta) ||
			priorCrystal.execution_approval !== "not-approved"
		)
			throw new Error("prior crystal is invalid");
		canonicalPriorItems = validateItems(priorCrystal.items);
	}
	const priorItems = new Map(canonicalPriorItems.map(item => [item.id, item]));
	if (removedIds.some(id => !priorItems.has(id)))
		throw new Error("removed crystallize item is not present in prior crystal");
	const mergedItems = [...items];
	for (const item of canonicalPriorItems)
		if (!removedIds.includes(item.id) && !mergedItems.some(candidate => candidate.id === item.id))
			mergedItems.push(item);
	const currentItems = mergedItems;
	if (currentItems.length > MAX_ITEMS) throw new Error("merged crystallize items exceed the bounded limit");
	const sameIntent = (left: CrystalItem, right: CrystalItem): boolean =>
		left.id === right.id && left.kind === right.kind && left.statement === right.statement;
	const changed = currentItems
		.filter(item => {
			const previous = priorItems.get(item.id);
			return previous !== undefined && !sameIntent(item, previous);
		})
		.map(item => item.id)
		.sort();
	const added = currentItems
		.filter(item => !priorItems.has(item.id))
		.map(item => item.id)
		.sort();
	const preserved = currentItems
		.filter(item => priorItems.has(item.id) && !changed.includes(item.id))
		.map(item => item.id)
		.sort();
	const goalChanged = changed.some(id => {
		const current = currentItems.find(item => item.id === id);
		const previous = priorItems.get(id);
		return current?.kind === "goal" || previous?.kind === "goal";
	});
	const removedGoal = removedIds.some(id => priorItems.get(id)?.kind === "goal");
	const removedIntent = removedIds.length > 0;
	const intentChanged =
		goalChanged ||
		changed.some(id =>
			["constraint", "decision", "acceptance_criterion", "non_goal"].includes(
				items.find(item => item.id === id)?.kind ?? "",
			),
		);
	const delta: CrystalDelta = {
		kind:
			conflicts.length > 0
				? "stale"
				: goalChanged || removedGoal
					? "goal-replaced"
					: intentChanged || removedIntent
						? "intent-changed"
						: added.length > 0
							? "additive"
							: "none",
		changed_ids: changed,
		added_ids: added,
		preserved_ids: preserved,
		approval_invalidated: intentChanged || removedIntent || conflicts.length > 0,
	};
	const lifecycle =
		conflicts.length > 0
			? "stale"
			: goalChanged || removedGoal
				? "superseded"
				: intentChanged || removedIntent || gaps.length > 0
					? "needs-questions"
					: "ready";
	return {
		schema_version: 1,
		spec_version: (priorCrystal?.spec_version ?? 0) + 1,
		lifecycle,
		source: { revision: snapshot.revision, start: snapshot.start, end: snapshot.end, digest: snapshot.digest },
		items: currentItems,
		...(removedIds.length > 0 ? { removed_ids: removedIds } : {}),
		open_gaps: gaps,
		conflicts,
		delta,
		execution_approval: "not-approved",
	};
}

export function crystalMarkdown(crystal: DeepInterviewCrystal): string {
	const lines = [
		`# Deep Interview Crystal v${crystal.spec_version}`,
		"",
		`- Readiness: ${crystal.lifecycle}`,
		`- Source: revision ${crystal.source.revision}, messages ${crystal.source.start}–${crystal.source.end}, digest ${crystal.source.digest}`,
		`- Execution approval: ${crystal.execution_approval}`,
		"",
		"## Delta",
		`- Kind: ${crystal.delta.kind}`,
		`- Changed IDs: ${crystal.delta.changed_ids.join(", ") || "none"}`,
		`- Added IDs: ${crystal.delta.added_ids.join(", ") || "none"}`,
		`- Preserved IDs: ${crystal.delta.preserved_ids.join(", ") || "none"}`,
		`- Removed IDs: ${crystal.removed_ids?.join(", ") || "none"}`,
		`- Approval invalidated: ${crystal.delta.approval_invalidated}`,
		"",
		"## Classified material",
	];
	for (const classification of CLASSIFICATIONS) {
		lines.push(`### ${classification}`);
		for (const item of crystal.items.filter(candidate => candidate.classification === classification))
			lines.push(
				`- **${item.kind}** (${item.id}): ${item.statement}${item.anchor ? ` _(verbatim anchor ${item.anchor.message_index}: ${item.anchor.quote})_` : ""}`,
			);
	}
	lines.push(
		"",
		"## Open gaps",
		...(crystal.open_gaps.length > 0 ? crystal.open_gaps.map(gap => `- ${gap}`) : ["- None"]),
		"",
		"## Conflicts",
		...(crystal.conflicts.length > 0 ? crystal.conflicts.map(conflict => `- ${conflict}`) : ["- None"]),
		"",
	);
	return `${lines.join("\n")}\n`;
}

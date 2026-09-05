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
	removed_item_anchors?: CrystalResolutionAnchor[];
	open_gaps?: string[];
	conflicts?: string[];
	resolved_open_gaps?: string[];
	resolved_conflicts?: string[];
	resolved_open_gap_anchors?: CrystalResolutionAnchor[];
	resolved_conflict_anchors?: CrystalResolutionAnchor[];
	prior?: DeepInterviewCrystal;
}

export interface CrystalResolutionAnchor {
	item: string;
	message_index: number;
	quote: string;
	resolution: string;
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
	source: { revision: number; start: number; end: number; digest: string; messages: CrystalMessage[] };
	items: CrystalItem[];
	removed_ids?: string[];
	removed_item_anchors?: CrystalResolutionAnchor[];
	pending_removals?: string[];
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
const EVIDENCE_SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });
const CJK_NEGATOR_TERMS = new Set(["不", "無", "无", "没", "沒", "未", "否", "勿", "毋", "别", "別", "莫"]);
const SEMANTIC_EVIDENCE_TERMS = new Set([
	"no",
	"not",
	"never",
	"neither",
	"without",
	"cannot",
	"can't",
	"won't",
	"don't",
	"doesn't",
	"isn't",
	"aren't",
	"wasn't",
	"weren't",
	"shouldn't",
	"mustn't",
	"needn't",
	"must",
	"should",
	"need",
	"needs",
	"required",
	"require",
	"shall",
	"ought",
	"may",
	"might",
	"could",
	"would",
	"if",
	"unless",
	"provided",
	"assuming",
	"maybe",
	"perhaps",
	"possibly",
	"probably",
	"likely",
	"unlikely",
	"seems",
	"seem",
	"apparently",
	"or",
	"either",
	"alternatively",
	"instead",
	"rather",
	"but",
	"however",
	"although",
	"though",
	"except",
	"refuse",
	"refused",
	"reject",
	"rejected",
	"defer",
	"deferred",
	"pending",
	"uncertain",
	"unknown",
	"undecided",
	"unresolved",
	"unclear",
]);
const RESOLUTION_GENERIC_TERMS = new Set([
	"ok",
	"yes",
	"done",
	"resolved",
	"confirmed",
	"accepted",
	"fine",
	"selected",
	"select",
	"chosen",
	"choose",
	"set",
	"sets",
	"follow",
	"follows",
	"remain",
	"remains",
	"stays",
	"stay",
	"unchanged",
	"same",
	"different",
	"fixed",
	"defined",
	"available",
	"possible",
	"valid",
	"invalid",
	"answer",
	"answers",
	"decision",
	"decisions",
	"choice",
	"choices",
	"selection",
	"selections",
	"resolution",
	"resolutions",
	"determined",
	"specified",
]);
const RESOLUTION_META_TERMS = new Set([
	"answer",
	"answers",
	"decision",
	"decisions",
	"choice",
	"choices",
	"selection",
	"selections",
	"resolution",
	"resolutions",
	"determination",
	"determinations",
]);
const RESOLUTION_QUESTION_TERMS = new Set([
	"what",
	"which",
	"when",
	"where",
	"why",
	"how",
	"whether",
	"is",
	"are",
	"does",
	"do",
	"can",
	"could",
	"should",
	"would",
	"will",
	"얼마",
	"몇",
	"무엇",
	"무엇을",
	"어떤",
	"언제",
	"어디",
	"왜",
	"어떻게",
	"인지",
	"인가",
	"多少",
	"幾",
	"什么",
	"什麼",
	"哪个",
	"哪個",
	"为何",
	"為何",
	"怎么",
	"怎麼",
	"如何",
	"何时",
	"何時",
	"哪里",
	"哪裡",
	"是否",
	"いくら",
	"何",
	"なに",
	"どの",
	"いつ",
	"どこ",
	"なぜ",
	"どう",
	"ですか",
]);
const CONFLICT_STATUS_TERMS = new Set([
	"dispute",
	"disputed",
	"disputes",
	"conflict",
	"conflicts",
	"contradiction",
	"contradictory",
	"uncertain",
	"unknown",
	"unresolved",
	"unclear",
	"undecided",
	"pending",
	"contested",
	"disagreement",
	"争议",
	"爭議",
	"冲突",
	"衝突",
	"분쟁",
	"충돌",
	"모순",
]);

type CrystalSemanticProfile = {
	negative: boolean;
	interrogative: boolean;
	conditional: boolean;
	hedged: boolean;
	alternative: boolean;
	contradictory: boolean;
	refusal: boolean;
	unresolved: boolean;
	obligation: string;
};

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

function containsNonTextMarker(value: string): boolean {
	return (
		/(?:\[(?:image|audio|video|file|content|toolCall|thinking|sticker|attachment|document)\]?|(?:image|audio|video|file|content|toolCall|thinking|sticker|attachment|document)\])/i.test(
			value,
		) ||
		/^(?:\[?(?:image|audio|video|file|content|toolCall|thinking|sticker|attachment|document)\]?)+$/i.test(
			value.trim(),
		) ||
		/^(?:\[[^\]]+\])+$/.test(value.trim())
	);
}

function anchoredClause(content: string, quote: string): string {
	const quoteIndex = content.indexOf(quote);
	if (quoteIndex < 0) return content;
	const before = content.slice(0, quoteIndex);
	const boundaryPattern = /(?:[!?]["'”’]?\s+|\.["'”’]?\s+(?=[\p{Lu}"'])|\n+)/gu;
	let boundary = -1;
	for (const match of before.matchAll(boundaryPattern)) boundary = match.index + match[0].length - 1;
	const afterStart = quoteIndex + quote.length;
	const after = content.slice(afterStart);
	const endMatch = /(?:[!?]["'”’]?(?:\s|$)|\.["'”’]?(?=\s+[\p{Lu}"']|$)|\n)/u.exec(after);
	const end = endMatch ? afterStart + endMatch.index + 1 : content.length;
	return content.slice(boundary + 1, end).trim();
}

function semanticProfile(value: string): CrystalSemanticProfile {
	const normalized = value.normalize("NFC").toLowerCase();
	const obligationTerms = new Set<string>();
	if (
		/\b(?:must|have\s+to|required|required\s+to|require|shall)\b/i.test(normalized) ||
		/(?:반드시|필수|해야|필요|必須|必要|なければなら|必须|必須|需要|应当|應當)/u.test(normalized)
	)
		obligationTerms.add("required");
	if (
		/\b(?:should|ought\s+to|recommended|recommend)\b/i.test(normalized) ||
		/(?:권장|하는\s+것이\s+좋|べき|推荐|推薦|应该|應該)/u.test(normalized)
	)
		obligationTerms.add("recommended");
	if (/\bneed(?:s|ed)?\b/i.test(normalized) || /(?:필요하다|필요한|必要だ|需要)/u.test(normalized))
		obligationTerms.add("need");
	if (
		/\b(?:can|may|might|could|would)\b/i.test(normalized) ||
		/(?:할\s+수|가능|てもよい|かもしれ|可以|可能)/u.test(normalized)
	)
		obligationTerms.add("permissive");
	const negative =
		/\b(?:no|not|never|neither|without|cannot|can't|won't|don't|doesn't|isn't|aren't|wasn't|weren't|shouldn't|mustn't|needn't|avoid|prohibit(?:s|ed)?|forbid(?:s|den)?|ban(?:s|ned)?)\b/i.test(
			normalized,
		) ||
		/(?:안|않|못|없|아니|하지\s*마|마세요|말자|금지|禁止|ない|ません|ぬ|ず|たくない|不|無|无|没|沒|未|否|勿|毋|别|別|莫)/u.test(
			normalized,
		);
	const interrogative =
		/[?？]/u.test(normalized) ||
		/\b(?:whether|wonder(?:s|ing)?|question(?:s|ed|ing)?)\b/i.test(normalized) ||
		/\b(?:what|which|when|where|why|how|whether|do|does|did|is|are|can|could|should|would|will)\b[^.!。！？]*[?？]/iu.test(
			normalized,
		) ||
		/(?:吗|嗎|呢|か|かな|나요|습니까|습니까|인가요|인가|ㄹ까요|을까요|까요|궁금|어떻게|무엇|무엇을|왜|언제|어디|얼마|몇|多少|什么|什麼|哪个|哪個|为何|為何|怎么|怎麼|如何|何时|何時|哪里|哪裡|是否|疑問|かどうか)/u.test(
			normalized,
		);
	const conditional =
		/\b(?:if|unless|provided(?:\s+that)?|assuming|in\s+case|contingent|when|depending\s+on)\b/i.test(normalized) ||
		/(?:만약|하면|라면|다면|으면|이면|경우|조건|경우에\s+따라|もし|なら|れば|たら|場合|条件|次第|如果|若|假如|倘若|除非|只要|情况下|取决于|取決於)/u.test(
			normalized,
		);
	const hedged =
		/\b(?:maybe|perhaps|possibly|probably|might|may|could|would|likely|unlikely|seems?|apparently|approximately|around|roughly|tentative(?:ly)?|prefer(?:ably)?|i\s+think|i\s+guess|i\s+believe|believe(?:s|d)?)\b/i.test(
			normalized,
		) ||
		/(?:아마|어쩌면|가능성|수도|것\s+같|같습니다|추정|대략|たぶん|おそらく|かもしれ|可能性|と思|思われ|だろう|でしょう|也许|也許|可能|或许|大概|似乎|大約|估计|估計|据说|據說)/u.test(
			normalized,
		);
	const alternative =
		/\b(?:or|either|alternatively|one\s+of|option(?:s)?|versus|vs)\b/i.test(normalized) ||
		/\s\/\s/.test(normalized) ||
		/[\p{L}\p{N}]\/[\p{L}\p{N}]/u.test(normalized) ||
		/(?:또는|혹은|아니면|대안|または|もしくは|いずれか|或者|或是|或|还是|替代)/u.test(normalized);
	const contradictory =
		/\b(?:but|however|instead|rather\s+than|although|though|except|contradict(?:s|ed|ion)?|disagree(?:s|d)?|versus|vs)\b/i.test(
			normalized,
		) || /(?:하지만|그러나|반면|대신|모순|矛盾|但是|不过|不過|然而|しかし|だが|ところが|代わりに)/u.test(normalized);
	const refusal =
		/\b(?:refus(?:e|ed|es|ing)|declin(?:e|ed|es|ing)|won't|can't|cannot|unable\s+to|not\s+able\s+to)\b/i.test(
			normalized,
		) ||
		/(?:답변할\s+수\s+없|대답할\s+수\s+없|말할\s+수\s+없|하지\s+않|않겠|거부|回答できない|答えられない|答えない|したくない|拒否|无法回答|不能回答|不愿回答|不願回答|不愿|不願|拒绝|拒絕|无法决定|不能决定)/u.test(
			normalized,
		);
	return {
		negative,
		interrogative,
		conditional,
		hedged,
		alternative,
		contradictory,
		refusal,
		unresolved: isExplicitlyUnresolved(normalized),
		obligation: [...obligationTerms].sort().join(","),
	};
}

function sameSemanticIntent(left: CrystalSemanticProfile, right: CrystalSemanticProfile): boolean {
	return (
		left.negative === right.negative &&
		left.interrogative === right.interrogative &&
		left.conditional === right.conditional &&
		left.hedged === right.hedged &&
		left.alternative === right.alternative &&
		left.contradictory === right.contradictory &&
		left.refusal === right.refusal &&
		left.unresolved === right.unresolved &&
		left.obligation === right.obligation
	);
}

function isUnsafeConfirmedStatement(profile: CrystalSemanticProfile): boolean {
	return (
		profile.interrogative ||
		profile.conditional ||
		profile.hedged ||
		profile.alternative ||
		profile.refusal ||
		profile.unresolved
	);
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
				const statementTerms = evidenceTerms(item.statement);
				const quoteTerms = evidenceTerms(item.anchor.quote);
				const statementSemantics = semanticProfile(item.statement);
				const quoteSemantics = semanticProfile(anchoredClause(anchorMessage.content, item.anchor.quote));
				if (
					anchorMessage.role !== "user" ||
					containsNonTextMarker(item.anchor.quote) ||
					containsNonTextMarker(anchorMessage.content) ||
					!anchorMessage.content.includes(item.anchor.quote) ||
					quoteTerms.size === 0 ||
					statementTerms.size === 0 ||
					[...statementTerms].some(term => !quoteTerms.has(term)) ||
					!preservesEvidenceOrder(item.statement, item.anchor.quote) ||
					isUnsafeConfirmedStatement(statementSemantics) ||
					!sameSemanticIntent(statementSemantics, quoteSemantics)
				)
					throw new Error(
						`confirmed item ${id} has no statement-bound verbatim user anchor (conservative derivation failed)`,
					);
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

function isMeaningfulEvidenceWord(value: string): boolean {
	const codePointLength = [...value].length;
	return (
		codePointLength >= 3 ||
		(codePointLength >= 2 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) ||
		SEMANTIC_EVIDENCE_TERMS.has(value.toLowerCase()) ||
		[...value].some(codePoint => CJK_NEGATOR_TERMS.has(codePoint))
	);
}

function evidenceTerms(value: string): Set<string> {
	const ignored = new Set([
		"and",
		"are",
		"can",
		"does",
		"for",
		"how",
		"make",
		"needs",
		"requirement",
		"requirements",
		"support",
		"that",
		"the",
		"this",
		"was",
		"were",
		"what",
		"when",
		"where",
		"which",
		"why",
		"will",
		"with",
		"want",
		"use",
		"using",
	]);
	const normalized = value.normalize("NFC").toLowerCase();
	const terms = new Set(
		[...EVIDENCE_SEGMENTER.segment(normalized)]
			.filter(part => part.isWordLike)
			.map(part => part.segment)
			.filter(term => isMeaningfulEvidenceWord(term) && (!ignored.has(term) || SEMANTIC_EVIDENCE_TERMS.has(term))),
	);
	for (const negator of CJK_NEGATOR_TERMS) if (normalized.includes(negator)) terms.add(negator);
	return terms;
}

function evidenceTermSequence(value: string): string[] {
	const terms = evidenceTerms(value);
	return [...EVIDENCE_SEGMENTER.segment(value.normalize("NFC").toLowerCase())]
		.filter(part => part.isWordLike && terms.has(part.segment))
		.map(part => part.segment);
}

function preservesEvidenceOrder(statement: string, quote: string): boolean {
	const statementTerms = evidenceTermSequence(statement);
	const quoteTerms = evidenceTermSequence(quote);
	let quoteIndex = 0;
	for (const statementTerm of statementTerms) {
		while (quoteIndex < quoteTerms.length && quoteTerms[quoteIndex] !== statementTerm) quoteIndex++;
		if (quoteIndex >= quoteTerms.length) return false;
		quoteIndex++;
	}
	return true;
}

function topicTerms(value: string, conflict: boolean): Set<string> {
	const terms = evidenceTerms(value);
	for (const term of [...terms]) {
		if (
			SEMANTIC_EVIDENCE_TERMS.has(term) ||
			CJK_NEGATOR_TERMS.has(term) ||
			RESOLUTION_QUESTION_TERMS.has(term) ||
			RESOLUTION_META_TERMS.has(term) ||
			(conflict && CONFLICT_STATUS_TERMS.has(term))
		)
			terms.delete(term);
	}
	return terms;
}

function hasConcreteResolutionValue(value: string, item: string, conflict: boolean): boolean {
	const itemTerms = evidenceTerms(item);
	const resolutionTerms = evidenceTerms(value);
	const newTerms = [...resolutionTerms].filter(
		term =>
			!itemTerms.has(term) &&
			!SEMANTIC_EVIDENCE_TERMS.has(term) &&
			!RESOLUTION_GENERIC_TERMS.has(term) &&
			!(conflict && CONFLICT_STATUS_TERMS.has(term)),
	);
	return (
		newTerms.length > 0 ||
		/\b(?:yes|no|true|false|enabled|disabled)\b/i.test(value) ||
		/(?:예|네|아니요|아니|是|否|はい|いいえ)/u.test(value) ||
		/\d/.test(value)
	);
}

function hasCjkTopicOverlap(item: string, resolution: string): boolean {
	const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
	const itemChars = [...item.normalize("NFC").toLowerCase()].filter(character => cjk.test(character));
	const resolutionText = [...resolution.normalize("NFC").toLowerCase()]
		.filter(character => cjk.test(character))
		.join("");
	if (itemChars.length < 4 || resolutionText.length < 4) return false;
	for (let length = itemChars.length; length >= 4; length--)
		for (let start = 0; start + length <= itemChars.length; start++)
			if (resolutionText.includes(itemChars.slice(start, start + length).join(""))) return true;
	return false;
}

function isUnsafeResolution(value: string): boolean {
	const profile = semanticProfile(value);
	const standaloneBinary =
		/^(?:yes|no|true|false|enabled|disabled|예|네|아니요|아니|是|否|はい|いいえ)[.!。！？]?$/iu.test(value.trim());
	return (
		(profile.negative && !standaloneBinary) ||
		/\b(?:different\s+from|other\s+than|not\s+equal\s+to|anything\s+but|except\s+for|less\s+than|greater\s+than|at\s+most|at\s+least|no\s+more\s+than|no\s+less\s+than|under|over|below|above)\b/i.test(
			value,
		) ||
		/(?:<=|>=|<|>)/.test(value) ||
		profile.interrogative ||
		profile.conditional ||
		profile.hedged ||
		profile.alternative ||
		profile.contradictory ||
		profile.refusal ||
		profile.unresolved
	);
}

function validateResolutionAnchors(
	resolutions: readonly string[],
	value: unknown,
	snapshot: CrystalSnapshot,
	field: string,
	afterIndex: number,
): void {
	if (resolutions.length === 0 && value === undefined) return;
	if (!Array.isArray(value) || value.length !== resolutions.length)
		throw new Error(`${field} must contain one anchor per resolution`);
	const seen = new Set<string>();
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) throw new Error(`${field}[${index}] must be an object`);
		const item = text(raw.item, `${field}[${index}].item`, 500);
		const messageIndex = integer(raw.message_index, `${field}[${index}].message_index`);
		const quote = text(raw.quote, `${field}[${index}].quote`, 500);
		const resolution = text(raw.resolution, `${field}[${index}].resolution`, 500);
		const message = snapshot.messages.find(candidate => candidate.index === messageIndex);
		const conflict = field === "resolved_conflict_anchors";
		const itemTerms = topicTerms(item, conflict);
		const resolutionTerms = evidenceTerms(resolution);
		const addressesItem =
			(itemTerms.size > 0 && [...itemTerms].every(term => resolutionTerms.has(term))) ||
			hasCjkTopicOverlap(item, resolution);
		const concreteAnswer = hasConcreteResolutionValue(resolution, item, conflict);
		const unsafeResolution =
			isUnsafeResolution(resolution) ||
			isUnsafeResolution(quote) ||
			(message ? isUnsafeResolution(anchoredClause(message.content, quote)) : true);
		if (
			!resolutions.includes(item) ||
			seen.has(item) ||
			messageIndex <= afterIndex ||
			!message ||
			message.role !== "user" ||
			containsNonTextMarker(quote) ||
			containsNonTextMarker(resolution) ||
			containsNonTextMarker(message.content) ||
			!message.content.includes(quote) ||
			!message.content.includes(resolution) ||
			unsafeResolution ||
			resolution === item
		)
			throw new Error(`${field}[${index}] has no fresh verbatim user anchor`);
		if (!addressesItem) throw new Error(`${field}[${index}] has no relevant verbatim user anchor`);
		if (!concreteAnswer) throw new Error(`${field}[${index}] has no fresh verbatim user anchor`);
		seen.add(item);
	}
}

function isExplicitlyUnresolved(value: string): boolean {
	const normalized = value.normalize("NFC").toLowerCase();
	return (
		/\b(?:undecided|undetermined|unresolved|unclear|unknown|tbd|pending|defer(?:red|ring)?|uncertain|disputed|contested|conflict(?:s|ing)?|disagreement(?:s)?)\b/i.test(
			normalized,
		) ||
		/\b(?:still\s+(?:deciding|undecided|unresolved|unknown)|not\s+(?:yet\s+)?(?:decided|determined|settled|made|chosen|selected|specified|known)|to\s+be\s+decided)\b/i.test(
			normalized,
		) ||
		/\b(?:will\s+be\s+decided|decide\s+(?:later|eventually)|to\s+decide\s+later|follow[- ]?up|not\s+sure|unsure|later|eventually|afterwards|in\s+the\s+future|next\s+(?:week|month|time))\b/i.test(
			normalized,
		) ||
		/\b(?:no|not|never)\s+(?:\w+\s+){0,3}(?:decision|choice|answer|selection|determination|resolution|agreement)\b/i.test(
			normalized,
		) ||
		/(?:미정|미결정|미해결|보류|불확실|아직\s*(?:결정|정해|선택)|결정되지|결정\s*안\s*(?:됨|됐|되었습니다|안됨)|정해지지|나중에\s*결정|답(?:변)?이\s*없|모르겠|알\s*수\s*없|미합의|분쟁|충돌|모순|未定|未決定|未解決|保留|不明|不確定|まだ\s*(?:決ま|決め)|決まっていない|決まっていません|決定していない|決定していません|答えがない|回答がない|後で\s*決め|わからない|分からない|争議|矛盾|尚未决定|尚未确定|还没决定|還沒決定|没有答案|沒有答案|没有决定|沒有決定|以后决定|以後決定|未解决|未解決|不明确|不明確|不清楚|不知道|待定|暂缓|暫緩|争议|爭議|冲突|衝突|矛盾)/u.test(
			normalized,
		)
	);
}

function validateRemovalAnchors(
	value: unknown,
	requestedIds: readonly string[],
	priorPendingIds: readonly string[],
	priorItems: ReadonlyMap<string, CrystalItem>,
	snapshot: CrystalSnapshot,
	afterIndex: number,
): CrystalResolutionAnchor[] {
	const removalIds = [...new Set([...requestedIds, ...priorPendingIds])].sort();
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > removalIds.length)
		throw new Error("removed_item_anchors must contain one anchor per resolved removal");
	const seen = new Set<string>();
	const anchors: CrystalResolutionAnchor[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) throw new Error(`removed_item_anchors[${index}] must be an object`);
		const itemId = text(raw.item, `removed_item_anchors[${index}].item`, 128);
		if (!removalIds.includes(itemId) || seen.has(itemId))
			throw new Error(`removed_item_anchors[${index}] does not identify a pending removal`);
		const previous = priorItems.get(itemId);
		if (!previous) throw new Error(`removed_item_anchors[${index}] references unknown prior material`);
		const messageIndex = integer(raw.message_index, `removed_item_anchors[${index}].message_index`);
		const quote = text(raw.quote, `removed_item_anchors[${index}].quote`, 500);
		const resolution = text(raw.resolution, `removed_item_anchors[${index}].resolution`, 500);
		const message = snapshot.messages.find(candidate => candidate.index === messageIndex);
		const statementTerms = topicTerms(previous.statement, false);
		const resolutionTerms = evidenceTerms(resolution);
		const referencesStatement =
			statementTerms.size > 0 && [...statementTerms].every(term => resolutionTerms.has(term));
		const removalLanguage =
			/\b(?:remove|drop|delete|discard|omit|exclude|retire|cancel|stop|no\s+longer|do\s+not\s+need|don't\s+need|not\s+needed)\b/i.test(
				resolution,
			) ||
			/(?:삭제|제거|버리|제외|취소|중단|더\s+이상\s+필요\s+없|없애|削除|取り除|除外|破棄|取り消|停止|不要|删除|移除|去掉|丢弃|丟棄|排除|取消|停止|不再需要)/u.test(
				resolution,
			);
		const removalSemantics = semanticProfile(resolution);
		const quotedRemovalSemantics = semanticProfile(quote);
		const messageRemovalSemantics = message ? semanticProfile(anchoredClause(message.content, quote)) : undefined;
		if (
			message?.role !== "user" ||
			messageIndex <= afterIndex ||
			containsNonTextMarker(quote) ||
			containsNonTextMarker(resolution) ||
			containsNonTextMarker(message.content) ||
			!message.content.includes(quote) ||
			!message.content.includes(resolution) ||
			resolution === previous.statement ||
			!removalLanguage ||
			!referencesStatement ||
			removalSemantics.negative ||
			removalSemantics.interrogative ||
			removalSemantics.conditional ||
			removalSemantics.hedged ||
			removalSemantics.refusal ||
			removalSemantics.alternative ||
			removalSemantics.contradictory ||
			removalSemantics.unresolved ||
			quotedRemovalSemantics.negative ||
			quotedRemovalSemantics.interrogative ||
			quotedRemovalSemantics.conditional ||
			quotedRemovalSemantics.hedged ||
			quotedRemovalSemantics.refusal ||
			quotedRemovalSemantics.alternative ||
			quotedRemovalSemantics.contradictory ||
			quotedRemovalSemantics.unresolved ||
			!messageRemovalSemantics ||
			messageRemovalSemantics.negative ||
			messageRemovalSemantics.interrogative ||
			messageRemovalSemantics.conditional ||
			messageRemovalSemantics.hedged ||
			messageRemovalSemantics.refusal ||
			messageRemovalSemantics.alternative ||
			messageRemovalSemantics.contradictory ||
			messageRemovalSemantics.unresolved
		)
			throw new Error(`removed_item_anchors[${index}] has no fresh statement-bound user removal evidence`);
		seen.add(itemId);
		anchors.push({ item: itemId, message_index: messageIndex, quote, resolution });
	}
	return anchors.sort((left, right) => left.item.localeCompare(right.item));
}

function validateStoredRemovalAnchors(
	value: unknown,
	removedIds: readonly string[],
	priorSnapshot: CrystalSnapshot,
): CrystalResolutionAnchor[] {
	if (removedIds.length === 0 && value === undefined) return [];
	if (!Array.isArray(value) || value.length !== removedIds.length)
		throw new Error("prior crystal removal evidence is invalid");
	const anchors = value.map((raw, index) => {
		if (!isRecord(raw)) throw new Error("prior crystal removal evidence is invalid");
		const item = text(raw.item, `prior.removed_item_anchors[${index}].item`, 128);
		const messageIndex = integer(raw.message_index, `prior.removed_item_anchors[${index}].message_index`);
		const quote = text(raw.quote, `prior.removed_item_anchors[${index}].quote`, 500);
		const resolution = text(raw.resolution, `prior.removed_item_anchors[${index}].resolution`, 500);
		const message = priorSnapshot.messages.find(candidate => candidate.index === messageIndex);
		const rolledOut = messageIndex < priorSnapshot.start;
		if (
			!removedIds.includes(item) ||
			messageIndex > priorSnapshot.end ||
			(!rolledOut && (message?.role !== "user" || !message.content.includes(quote)))
		)
			throw new Error("prior crystal removal evidence is invalid");
		return { item, message_index: messageIndex, quote, resolution };
	});
	if (new Set(anchors.map(anchor => anchor.item)).size !== anchors.length)
		throw new Error("prior crystal removal evidence is invalid");
	return anchors.sort((left, right) => left.item.localeCompare(right.item));
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
	if (snapshot.messages.length === 0) throw new Error("crystallize requires material conversation evidence");
	const requestedRemovedIds = value.removed_ids === undefined ? [] : validateRemovedIds(value.removed_ids);
	if (requestedRemovedIds.some(id => items.some(item => item.id === id)))
		throw new Error("removed_ids must be disjoint from submitted items");
	const gaps = normalizedGaps(value.open_gaps);
	if (gaps.length > 2) throw new Error("broad ambiguity requires the full deep-interview flow");
	const conflicts = normalizedGaps(value.conflicts);
	const resolvedGaps = normalizedGaps(value.resolved_open_gaps);
	const resolvedConflicts = normalizedGaps(value.resolved_conflicts);
	const prior = value.prior;
	if (prior !== undefined && !isRecord(prior)) throw new Error("prior crystal is invalid");
	const priorCrystal = prior as DeepInterviewCrystal | undefined;
	let canonicalPriorItems: CrystalItem[] = [];
	let priorSnapshot: CrystalSnapshot | undefined;
	if (priorCrystal) {
		if (
			priorCrystal.schema_version !== 1 ||
			!Number.isSafeInteger(priorCrystal.spec_version) ||
			priorCrystal.spec_version < 1
		)
			throw new Error("prior crystal is invalid");
		if (priorCrystal.spec_version >= Number.MAX_SAFE_INTEGER)
			throw new Error("prior crystal spec_version cannot be safely incremented");
		if (!isRecord(priorCrystal.source) || snapshot.revision <= priorCrystal.source.revision)
			throw new Error("conversation snapshot is stale");
		if (!Array.isArray(priorCrystal.source.messages)) throw new Error("prior crystal source evidence is missing");
		priorSnapshot = validateSnapshot({ ...priorCrystal.source, messages: priorCrystal.source.messages });
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
		const inWindowPriorItems = priorCrystal.items.filter(
			item =>
				item.anchor &&
				item.anchor.message_index >= priorSnapshot!.start &&
				item.anchor.message_index <= priorSnapshot!.end,
		);
		validateItems(inWindowPriorItems, priorSnapshot);
	}
	const priorEnd =
		priorCrystal && isRecord(priorCrystal.source) && typeof priorCrystal.source.end === "number"
			? priorCrystal.source.end
			: -1;
	if (priorCrystal && snapshot.start > priorEnd + 1)
		throw new Error("conversation snapshot must include every message after the prior Crystal boundary");
	if (gaps.some(gap => resolvedGaps.includes(gap)))
		throw new Error("open_gaps and resolved_open_gaps must be disjoint");
	if (conflicts.some(conflict => resolvedConflicts.includes(conflict)))
		throw new Error("conflicts and resolved_conflicts must be disjoint");
	validateResolutionAnchors(
		resolvedGaps,
		value.resolved_open_gap_anchors,
		snapshot,
		"resolved_open_gap_anchors",
		priorEnd,
	);
	validateResolutionAnchors(
		resolvedConflicts,
		value.resolved_conflict_anchors,
		snapshot,
		"resolved_conflict_anchors",
		priorEnd,
	);
	const priorItems = new Map(canonicalPriorItems.map(item => [item.id, item]));
	const priorRemovedIds = priorCrystal?.removed_ids === undefined ? [] : validateRemovedIds(priorCrystal.removed_ids);
	const priorRemovedAnchors = priorCrystal
		? validateStoredRemovalAnchors(priorCrystal.removed_item_anchors, priorRemovedIds, priorSnapshot!)
		: [];
	const priorPendingRemovals =
		priorCrystal?.pending_removals === undefined ? [] : validateRemovedIds(priorCrystal.pending_removals);
	if (priorPendingRemovals.some(id => !priorItems.has(id)))
		throw new Error("prior crystal contains an unresolved removal for unknown material");
	if (priorRemovedIds.some(id => priorItems.has(id)))
		throw new Error("prior crystal contains removed material in its active items");
	if (priorRemovedIds.some(id => priorPendingRemovals.includes(id)))
		throw new Error("prior crystal contains both resolved and pending removal tombstones");
	if (items.some(item => priorRemovedIds.includes(item.id)))
		throw new Error("submitted items must not resurrect a permanently removed item");
	if (requestedRemovedIds.some(id => priorRemovedIds.includes(id)))
		throw new Error("removed crystallize item is permanently removed");
	if (requestedRemovedIds.some(id => !priorItems.has(id)))
		throw new Error("removed crystallize item is not present in prior crystal");
	const resolvedRemovalAnchors = validateRemovalAnchors(
		value.removed_item_anchors,
		requestedRemovedIds,
		priorPendingRemovals,
		priorItems,
		snapshot,
		priorEnd,
	);
	const resolvedRemovedIds = resolvedRemovalAnchors.map(anchor => anchor.item);
	const unresolvedRemovalIds = [
		...new Set([...priorPendingRemovals, ...requestedRemovedIds].filter(id => !resolvedRemovedIds.includes(id))),
	].sort();
	if (items.some(item => unresolvedRemovalIds.includes(item.id) || resolvedRemovedIds.includes(item.id)))
		throw new Error("submitted items must not silently resurrect unresolved removals");
	const allRemovedIds = [...new Set([...priorRemovedIds, ...resolvedRemovedIds])].sort();
	const sameIntent = (left: CrystalItem, right: CrystalItem): boolean =>
		left.id === right.id &&
		left.kind === right.kind &&
		left.statement === right.statement &&
		left.classification === right.classification;
	for (const item of items) {
		const previous = priorItems.get(item.id);
		if (
			item.classification === "confirmed" &&
			(previous === undefined || !sameIntent(item, previous)) &&
			(item.anchor === undefined || item.anchor.message_index <= priorEnd)
		)
			throw new Error(`changed confirmed item ${item.id} requires fresh user evidence`);
	}
	const mergedItems = [...items];
	for (const item of canonicalPriorItems)
		if (!allRemovedIds.includes(item.id) && !mergedItems.some(candidate => candidate.id === item.id))
			mergedItems.push(item);
	const currentItems = mergedItems;
	if (currentItems.length > MAX_ITEMS) throw new Error("merged crystallize items exceed the bounded limit");
	if (currentItems.length === 0) throw new Error("crystallize requires material conversation evidence");
	if (!currentItems.some(item => item.classification === "confirmed" && item.kind !== "non_goal"))
		throw new Error("crystallize requires a confirmed user requirement");
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
	const removedGoal = resolvedRemovedIds.some(id => priorItems.get(id)?.kind === "goal");
	const removedIntent = resolvedRemovedIds.length > 0 || unresolvedRemovalIds.length > 0;
	const allGaps = [
		...new Set([...(priorCrystal?.open_gaps ?? []), ...gaps].filter(gap => !resolvedGaps.includes(gap))),
	];
	if (allGaps.length > 2) throw new Error("broad ambiguity requires the full deep-interview flow");
	const allConflicts = [
		...new Set(
			[...(priorCrystal?.conflicts ?? []), ...conflicts].filter(conflict => !resolvedConflicts.includes(conflict)),
		),
	];
	const hasDisputed = currentItems.some(item => item.classification === "disputed");
	const hasInferred = currentItems.some(item => item.classification === "inferred");
	const intentChanged =
		goalChanged ||
		changed.some(id =>
			["constraint", "decision", "acceptance_criterion", "non_goal"].includes(
				items.find(item => item.id === id)?.kind ?? "",
			),
		);
	const delta: CrystalDelta = {
		kind:
			allConflicts.length > 0 || hasDisputed
				? "stale"
				: goalChanged || removedGoal
					? "goal-replaced"
					: intentChanged || removedIntent || hasInferred
						? "intent-changed"
						: added.length > 0
							? "additive"
							: "none",
		changed_ids: changed,
		added_ids: added,
		preserved_ids: preserved,
		approval_invalidated:
			Boolean(priorCrystal && added.length > 0) ||
			intentChanged ||
			removedIntent ||
			hasInferred ||
			allConflicts.length > 0 ||
			hasDisputed,
	};
	const allRemovedAnchors = [...priorRemovedAnchors];
	for (const anchor of resolvedRemovalAnchors)
		if (!allRemovedAnchors.some(existing => existing.item === anchor.item)) allRemovedAnchors.push(anchor);
	allRemovedAnchors.sort((left, right) => left.item.localeCompare(right.item));
	const lifecycle =
		allConflicts.length > 0 || hasDisputed
			? "stale"
			: goalChanged || removedGoal
				? "superseded"
				: intentChanged || removedIntent || hasInferred || allGaps.length > 0
					? "needs-questions"
					: "ready";
	return {
		schema_version: 1,
		spec_version: (priorCrystal?.spec_version ?? 0) + 1,
		lifecycle,
		source: {
			revision: snapshot.revision,
			start: snapshot.start,
			end: snapshot.end,
			digest: snapshot.digest,
			messages: snapshot.messages,
		},
		items: currentItems,
		...(allRemovedIds.length > 0 ? { removed_ids: allRemovedIds } : {}),
		...(allRemovedAnchors.length > 0 ? { removed_item_anchors: allRemovedAnchors } : {}),
		...(unresolvedRemovalIds.length > 0 ? { pending_removals: unresolvedRemovalIds } : {}),
		open_gaps: allGaps,
		conflicts: allConflicts,
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
		`- Removal evidence: ${crystal.removed_item_anchors?.map(anchor => `${anchor.item}@${anchor.message_index}: ${anchor.quote}`).join("; ") || "none"}`,
		`- Pending removals: ${crystal.pending_removals?.join(", ") || "none"}`,
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

export interface SearchBudgetLimits {
	readonly maxMaps: number;
	readonly maxFiles: number;
	readonly maxSections: number;
	readonly maxChars: number;
}

export interface SearchBudgetUsage {
	readonly maps: number;
	readonly files: number;
	readonly sections: number;
	readonly chars: number;
}

export type SearchBudgetDimension = "maps" | "files" | "sections" | "chars";

export interface SearchBudgetDrop {
	readonly candidateId: string;
	readonly dimension: SearchBudgetDimension;
	readonly amount: number;
	readonly reason: "limit" | "invalid-amount";
}

export interface SearchBudgetState {
	readonly limits: SearchBudgetLimits;
	readonly usage: SearchBudgetUsage;
	readonly droppedCandidates: readonly string[];
	readonly drops: readonly SearchBudgetDrop[];
	readonly truncated: boolean;
}

export interface SearchBudgetReservation {
	readonly accepted: boolean;
	readonly state: SearchBudgetState;
}

export const SEARCH_BUDGET_LIMITS = Object.freeze({
	maxMaps: 4,
	maxFiles: 20,
	maxSections: 8,
	maxChars: 24_000,
} satisfies SearchBudgetLimits);

function freezeLimits(limits: SearchBudgetLimits): SearchBudgetLimits {
	return Object.freeze({
		maxMaps: limits.maxMaps,
		maxFiles: limits.maxFiles,
		maxSections: limits.maxSections,
		maxChars: limits.maxChars,
	});
}

function freezeUsage(usage: SearchBudgetUsage): SearchBudgetUsage {
	return Object.freeze({
		maps: usage.maps,
		files: usage.files,
		sections: usage.sections,
		chars: usage.chars,
	});
}

function normalizeLimit(value: number | undefined, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return maximum;
	if (!Number.isInteger(value)) return maximum;
	return Math.max(0, Math.min(maximum, value));
}

function normalizeLimits(limits: Partial<SearchBudgetLimits> | undefined): SearchBudgetLimits {
	return freezeLimits({
		maxMaps: normalizeLimit(limits?.maxMaps, SEARCH_BUDGET_LIMITS.maxMaps),
		maxFiles: normalizeLimit(limits?.maxFiles, SEARCH_BUDGET_LIMITS.maxFiles),
		maxSections: normalizeLimit(limits?.maxSections, SEARCH_BUDGET_LIMITS.maxSections),
		maxChars: normalizeLimit(limits?.maxChars, SEARCH_BUDGET_LIMITS.maxChars),
	});
}

function emptyUsage(): SearchBudgetUsage {
	return freezeUsage({ maps: 0, files: 0, sections: 0, chars: 0 });
}

function createState(
	limits: SearchBudgetLimits,
	usage: SearchBudgetUsage,
	droppedCandidates: readonly string[],
	drops: readonly SearchBudgetDrop[],
	truncated: boolean,
): SearchBudgetState {
	return Object.freeze({
		limits: freezeLimits(limits),
		usage: freezeUsage(usage),
		droppedCandidates: Object.freeze([...droppedCandidates]),
		drops: Object.freeze(drops.map(drop => Object.freeze({ ...drop }))),
		truncated,
	});
}

/** Create the immutable retrieval budget. Custom limits may only tighten the fixed contract. */
export function createSearchBudget(limits?: Partial<SearchBudgetLimits>): SearchBudgetState {
	const normalizedLimits = normalizeLimits(limits);
	return createState(normalizedLimits, emptyUsage(), [], [], false);
}

function dimensionLimit(limits: SearchBudgetLimits, dimension: SearchBudgetDimension): number {
	switch (dimension) {
		case "maps":
			return limits.maxMaps;
		case "files":
			return limits.maxFiles;
		case "sections":
			return limits.maxSections;
		case "chars":
			return limits.maxChars;
	}
}

function reserve(
	state: SearchBudgetState,
	dimension: SearchBudgetDimension,
	amount: number,
	candidateId: string,
): SearchBudgetReservation {
	const id = candidateId.normalize("NFC");
	if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
		const drop: SearchBudgetDrop = {
			candidateId: id,
			dimension,
			amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
			reason: "invalid-amount",
		};
		return {
			accepted: false,
			state: createState(state.limits, state.usage, [...state.droppedCandidates, id], [...state.drops, drop], true),
		};
	}

	const current = state.usage[dimension];
	const limit = dimensionLimit(state.limits, dimension);
	if (current + amount > limit) {
		const drop: SearchBudgetDrop = { candidateId: id, dimension, amount, reason: "limit" };
		return {
			accepted: false,
			state: createState(state.limits, state.usage, [...state.droppedCandidates, id], [...state.drops, drop], true),
		};
	}

	const usage: SearchBudgetUsage = {
		...state.usage,
		[dimension]: current + amount,
	};
	return {
		accepted: true,
		state: createState(state.limits, usage, state.droppedCandidates, state.drops, state.truncated),
	};
}

export function reserveMap(state: SearchBudgetState, amount = 1, candidateId = "map"): SearchBudgetReservation {
	return reserve(state, "maps", amount, candidateId);
}

export function reserveFile(state: SearchBudgetState, amount = 1, candidateId = "file"): SearchBudgetReservation {
	return reserve(state, "files", amount, candidateId);
}

export function reserveSection(state: SearchBudgetState, amount = 1, candidateId = "section"): SearchBudgetReservation {
	return reserve(state, "sections", amount, candidateId);
}

export function reserveChars(state: SearchBudgetState, amount = 1, candidateId = "chars"): SearchBudgetReservation {
	return reserve(state, "chars", amount, candidateId);
}

/** Record a policy or pipeline exclusion without consuming a budget unit. */
export function dropCandidate(
	state: SearchBudgetState,
	candidateId: string,
	dimension: SearchBudgetDimension = "files",
	reason: SearchBudgetDrop["reason"] = "limit",
): SearchBudgetState {
	const id = candidateId.normalize("NFC");
	const drop: SearchBudgetDrop = { candidateId: id, dimension, amount: 0, reason };
	return createState(state.limits, state.usage, [...state.droppedCandidates, id], [...state.drops, drop], true);
}

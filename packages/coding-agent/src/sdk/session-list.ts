export type SessionListPageRecord = Record<string, unknown>;

export type SessionListSavedSessionOmissionReason =
	| "scope_unavailable"
	| "candidate_scan_failed"
	| "candidate_not_found"
	| "candidate_ambiguous"
	| "candidate_invalid"
	| "identity_incomplete";

export const SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES = [
	"cwd_missing",
	"cwd_not_directory",
	"identity_unavailable",
	"network_unsupported",
	"sessions_root_unavailable",
	"binding_conflict",
	"binding_invalid",
	"migration_busy",
	"atomic_unavailable",
	"invalid_request",
	"durability_failed",
	"durability_not_provable",
	"capacity_exceeded",
	"scan_failed",
	"unsafe_root",
	"invalid_candidate",
	"invalid_header",
	"unreadable_candidate",
	"source_changed",
	"cwd_not_found",
	"cwd_not_utf8",
	"cwd_network_unsupported",
	"cwd_identity_unavailable",
	"cwd_io_error",
] as const;

export type SessionListSavedSessionOmissionDetailCode =
	(typeof SESSION_LIST_SAVED_SESSION_OMISSION_DETAIL_CODES)[number];

/** Path-free diagnostic for a requested managed transcript that could not be selected safely. */
export interface SessionListSavedSessionOmission {
	readonly sessionId: string;
	readonly reason: SessionListSavedSessionOmissionReason;
	readonly detailCode?: SessionListSavedSessionOmissionDetailCode;
	readonly candidateCount?: number;
	readonly missingIdentityFields?: readonly ("nlink" | "ctimeNs")[];
}

export type SessionListTraversalErrorKind = "malformed_page" | "repeated_cursor" | "page_budget_exceeded";

export class SessionListTraversalError extends Error {
	readonly #kind: SessionListTraversalErrorKind;

	constructor(kind: SessionListTraversalErrorKind) {
		super(
			kind === "malformed_page"
				? "session.list returned a malformed page."
				: kind === "repeated_cursor"
					? "session.list returned a repeated continuation cursor."
					: "session.list exceeded the page budget.",
		);
		this.name = "SessionListTraversalError";
		this.#kind = kind;
	}

	get kind(): SessionListTraversalErrorKind {
		return this.#kind;
	}
}

export interface SessionListTraversalInputPage {
	readonly sessions: readonly unknown[];
	readonly continuationCursor?: unknown;
}

export interface SessionListTraversalPage<TResponse, TPage extends SessionListTraversalInputPage> {
	readonly response: TResponse;
	readonly page: TPage;
	readonly sessions: readonly unknown[];
	readonly continuationCursor?: string;
}

const MAX_SESSION_LIST_PAGES = 10_000;

function record(value: unknown): SessionListPageRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as SessionListPageRecord)
		: undefined;
}

export type SessionListPage = SessionListPageRecord & SessionListTraversalInputPage;

/** Returns a strict session.list page from either a Broker envelope or a direct result record. */
export function sessionListPageFromResponse(value: unknown): SessionListPage | undefined {
	const response = record(value);
	if (!response) return undefined;
	const page = Object.hasOwn(response, "ok") ? (response.ok === true ? record(response.result) : undefined) : response;
	if (!page || !Array.isArray(page.sessions)) return undefined;
	return page as SessionListPage;
}

/** Drains bounded Broker session.list pages while rejecting malformed or cyclic continuations. */
export async function traverseSessionList<
	TInput extends Record<string, unknown>,
	TResponse,
	TPage extends SessionListTraversalInputPage,
>(
	input: TInput,
	request: (input: TInput) => Promise<TResponse>,
	pageFromResponse: (response: TResponse) => TPage | undefined,
): Promise<readonly SessionListTraversalPage<TResponse, TPage>[]> {
	const pages: SessionListTraversalPage<TResponse, TPage>[] = [];
	const seenCursors = new Set<string>();
	const initialCursor = input.cursor;
	if (typeof initialCursor === "string" && initialCursor.length > 0) seenCursors.add(initialCursor);
	let cursor: string | undefined;
	for (let pageCount = 0; pageCount < MAX_SESSION_LIST_PAGES; pageCount++) {
		const response = await request({ ...input, ...(cursor === undefined ? {} : { cursor }) } as TInput);
		const page = pageFromResponse(response);
		if (!page || !Array.isArray(page.sessions)) throw new SessionListTraversalError("malformed_page");
		const continuationCursor = page.continuationCursor;
		if (
			continuationCursor !== undefined &&
			(typeof continuationCursor !== "string" || continuationCursor.length === 0)
		)
			throw new SessionListTraversalError("malformed_page");
		pages.push({
			response,
			page,
			sessions: page.sessions,
			...(continuationCursor === undefined ? {} : { continuationCursor }),
		});
		if (continuationCursor === undefined) return pages;
		if (seenCursors.has(continuationCursor)) throw new SessionListTraversalError("repeated_cursor");
		seenCursors.add(continuationCursor);
		cursor = continuationCursor;
	}
	throw new SessionListTraversalError("page_budget_exceeded");
}

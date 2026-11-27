/**
 * Who holds a session, and how that is said: holder types, the held-session error and its text.
 *
 * Import-free on purpose. Machine entrypoints (ACP, MCP, the `gjc sdk session` CLI) and the broker's
 * lifecycle service name a holder in their errors, and must not reach the claim and lock machinery in
 * `session-ownership.ts` to do it (`scripts/verify-gjc-sdk-canonicalization.ts`).
 */

/** A session id that may be quoted in text; any other id may hold any text. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A host name that may be shown; any other host reads as "another gjc process". */
export const SAFE_SESSION_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

export const SESSION_OWNER_SURFACES = ["app", "terminal", "print", "sdk-host", "acp-host", "sdk"] as const;
export type SessionOwnerBaseSurface = (typeof SESSION_OWNER_SURFACES)[number];
/** Where the holder runs; a subagent child carries its parent's surface plus ` (subagent)`. */
export type SessionOwnerSurface = SessionOwnerBaseSurface | `${SessionOwnerBaseSurface} (subagent)`;

/** A verified holder: its lock is held, and (on this host) its pid and incarnation match its record. */
export interface SessionOwnerHolder {
	readonly surface: SessionOwnerSurface;
	readonly pid: number;
	/** Present only when the holder runs on another host, whose pid cannot be checked here. */
	readonly host?: string;
	readonly gjcVersion?: string;
	readonly claimedAt?: string;
}

export function isSessionOwnerSurface(value: unknown): value is SessionOwnerSurface {
	if (typeof value !== "string") return false;
	const base = value.endsWith(" (subagent)") ? value.slice(0, -" (subagent)".length) : value;
	return (SESSION_OWNER_SURFACES as readonly string[]).includes(base);
}

const SURFACE_NOUNS: Record<SessionOwnerBaseSurface, string> = {
	app: "the Gajae Code app",
	terminal: "another terminal",
	print: "a gjc -p run",
	"sdk-host": "an SDK session host",
	"acp-host": "an ACP session host",
	sdk: "an application using the gjc SDK",
};

/** The holder as a remote client is told it, in a broker lifecycle error: surface and pid only. */
export interface SessionOwnerHolderSummary {
	readonly surface: SessionOwnerSurface;
	readonly pid: number;
}

/**
 * {@link SessionOwnerHolderSummary} of `holder`, checked field by field because it may come from
 * a file another process wrote; `undefined` when it does not name a surface and a positive pid.
 * A holder on another host keeps its surface and pid; its host name stays out.
 */
export function sessionOwnerHolderSummary(holder: unknown): SessionOwnerHolderSummary | undefined {
	if (typeof holder !== "object" || holder === null) return undefined;
	const { surface, pid } = holder as { surface?: unknown; pid?: unknown };
	return isSessionOwnerSurface(surface) && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
		? { surface, pid }
		: undefined;
}

/**
 * How a holder is named to a person (design §3.4). The holder is checked again here, because a
 * caller may build one: anything malformed reads as "another gjc process", never as raw text.
 */
export function sessionOwnerHolderPhrase(holder: SessionOwnerHolder | undefined): string {
	if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !isSessionOwnerSurface(holder.surface))
		return "another gjc process";
	if (holder.host !== undefined)
		return SAFE_SESSION_HOST.test(holder.host)
			? `a gjc process on ${holder.host} (pid ${holder.pid})`
			: "another gjc process";
	const subagent = holder.surface.endsWith(" (subagent)");
	const base = (subagent ? holder.surface.slice(0, -" (subagent)".length) : holder.surface) as SessionOwnerBaseSurface;
	const noun = SURFACE_NOUNS[base];
	return subagent ? `a subagent of ${noun} (pid ${holder.pid})` : `${noun} (pid ${holder.pid})`;
}

/** The holder as the SDK message names it (design §3.3): `terminal, pid 4242`, or `a gjc process on build-box, pid 4242` for a remote holder; `undefined` if unverified. */
function sessionOwnerHolderLabel(holder: SessionOwnerHolder | undefined): string | undefined {
	if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !isSessionOwnerSurface(holder.surface))
		return undefined;
	if (holder.host === undefined) return `${holder.surface}, pid ${holder.pid}`;
	return SAFE_SESSION_HOST.test(holder.host) ? `a gjc process on ${holder.host}, pid ${holder.pid}` : undefined;
}

/**
 * The CLI command that continues a held session in a copy (design §3.3), for the CLI's refusals
 * only: the SDK's `operatorMessage` names no command. `undefined` for an id that is not a safe file
 * name, since any other id may hold any text.
 */
export function sessionHeldForkCommand(
	sessionId: string,
	options: {
		readonly print?: boolean;
		/** The transcript path the session was named by, repeated so the command reads the same file. */
		readonly source?: string;
		/** The `--session-dir` the session was found in; an id resolves only there. */
		readonly sessionDir?: string;
	} = {},
): string | undefined {
	if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
	const source = options.source === undefined ? sessionId : shellWord(options.source);
	const sessionDir = options.sessionDir === undefined ? undefined : shellWord(options.sessionDir);
	if (source === undefined || (options.sessionDir !== undefined && sessionDir === undefined)) return undefined;
	const flags = sessionDir === undefined ? "" : `--session-dir ${sessionDir} `;
	return options.print ? `gjc -p ${flags}--fork ${source} "<message>"` : `gjc ${flags}--fork ${source}`;
}

/** One shell word for a path in a printed command; `undefined` for text no terminal should print. */
function shellWord(value: string): string | undefined {
	if (value === "" || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return undefined;
	return /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) && !value.startsWith("-")
		? value
		: `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The terminal warning for a session another process holds (design §3.1; Fork and Cancel only, the
 * read-only view and Take over are deferred). Fixed vocabulary, the holder's §3.4 phrase and a safe
 * short id only: nothing a session or another process wrote reaches the screen.
 */
export function sessionHeldWarning(error: SessionHeldError): { readonly heading: string; readonly lines: string[] } {
	const subject = SAFE_SESSION_ID.test(error.sessionId) ? `Session ${error.sessionId.slice(0, 8)}` : "This session";
	return {
		heading: "This session is open in another process",
		lines: [
			`${subject} is open for writing in ${sessionOwnerHolderPhrase(error.holder)}.`,
			"Only one process can write a session at a time.",
		],
	};
}

/** What a launch or the TUI says after Fork (design §3.1). */
export function sessionHeldForkedNotice(error: SessionHeldError): string {
	return `Forked into a new session. The original stays with ${sessionOwnerHolderPhrase(error.holder)}.`;
}

const SURFACE_MARKERS: Record<SessionOwnerBaseSurface, string> = {
	app: "in app",
	terminal: "in terminal",
	print: "in gjc -p",
	"sdk-host": "in session host",
	"acp-host": "in session host",
	sdk: "in SDK app",
};

/** The short marker a session list shows on a row another process holds (design §1 row 2): `in terminal`. */
export function sessionOwnerHolderMarker(holder: SessionOwnerHolder | undefined): string {
	if (!holder || !isSessionOwnerSurface(holder.surface) || holder.host !== undefined) return "in use";
	if (holder.surface.endsWith(" (subagent)")) return "in subagent";
	return SURFACE_MARKERS[holder.surface as SessionOwnerBaseSurface];
}

/**
 * A session another live process holds for writing. `message` is the stable machine code; the
 * fixed, path-free `operatorMessage` is what a person sees.
 */
export class SessionHeldError extends Error {
	readonly code = "session_held";
	readonly sessionId: string;
	readonly holder: SessionOwnerHolder | undefined;
	readonly operatorMessage: string;

	constructor(sessionId: string, holder?: SessionOwnerHolder) {
		super("session_held");
		this.name = "SessionHeldError";
		this.sessionId = sessionId;
		this.holder = holder;
		// Only a safe id is quoted, shortened as the CLI shows it; any other id may hold any text.
		const subject = SAFE_SESSION_ID.test(sessionId) ? `Session ${sessionId.slice(0, 8)}` : "This session";
		const label = sessionOwnerHolderLabel(holder);
		const where = label ? `another process (${label})` : "another gjc process";
		this.operatorMessage = `${subject} is open for writing in ${where}. Only one process can write a session at a time.`;
	}
}

/**
 * Types for the internal URL routing system.
 *
 * Internal URLs (agent://, artifact://, memory://, rule://, gjc://, local://) are resolved by tools like read,
 * providing access to agent outputs and server resources without exposing filesystem paths.
 */

/**
 * Raw resource payload returned by protocol handlers. The `immutable` flag is
 * applied by the router from {@link ProtocolHandler.immutable}, so handlers do
 * not need to set it themselves.
 */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/** Additional notes about resolution */
	notes?: string[];
	/**
	 * True when the resolved content cannot be edited by the agent (e.g. sealed
	 * artifacts, harness docs, machine-generated memory summaries). Hashline
	 * anchors and similar edit affordances are suppressed for immutable
	 * resources. Mutable resources (e.g. local://) behave like editable files.
	 */
	immutable?: boolean;
}

/**
 * Parsed internal URL with preserved host casing.
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/**
 * Caller-supplied context that the router threads into protocol handlers.
 *
 * Read tool calls `InternalUrlRouter.resolve(url, { cwd, settings, signal })`
 * so handlers can resolve relative defaults (e.g. `issue://N` → which repo?)
 * against the actual session that initiated the read, not whichever session
 * happens to be registered first in the global `AgentRegistry`.
 */
export interface ResolveContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Settings of the calling session (used by `issue://`/`pr://` for cache TTLs). */
	settings?: unknown;
	/** Artifacts directory of the calling session. */
	getArtifactsDir?: () => string | null;
	/** Additional artifacts directories explicitly authorized for this caller (for parent/child agent trees). */
	getAuthorizedArtifactsDirs?: () => readonly string[];
	/** Caller's abort signal. */
	signal?: AbortSignal;
}

/**
 * Caller context for write operations dispatched to host-owned URI handlers.
 * Mirrors {@link ResolveContext} so handlers that share read/write state can
 * accept the same shape.
 */
export interface WriteContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Caller's abort signal. */
	signal?: AbortSignal;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/**
	 * Whether resources produced by this handler are immutable (cannot be
	 * edited by the agent). When true, callers suppress hashline anchors and
	 * other edit affordances. When false, resources behave like editable files.
	 */
	readonly immutable: boolean;
	/**
	 * Resolve an internal URL to its content. The router stamps the
	 * {@link InternalResource.immutable} flag from {@link ProtocolHandler.immutable}.
	 *
	 * @param url Parsed URL object
	 * @param context Optional caller context. Handlers that depend on caller
	 *   identity (working directory, settings) **MUST** consume this in
	 *   preference to global state.
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	/**
	 * Optional write hook. When present, the write tool dispatches
	 * `write(url, content)` to this handler instead of writing to a filesystem
	 * path. The handler is responsible for any persistence and validation.
	 *
	 * Handlers that omit this method are treated as read-only; the write tool
	 * surfaces a clear "not writable" error when invoked against them.
	 */
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
}

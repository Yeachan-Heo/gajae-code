/**
 * Identity of the tool object a `tool_execution_start` event was produced for.
 *
 * The producer already knows exactly which tool object it dispatched to: the agent loop
 * resolves it once, from the run's immutable tool snapshot, before it emits anything. Any
 * consumer that instead re-resolves `event.toolName` later reads a MUTABLE registry — a
 * mid-run `setTools`, MCP reload, or tool refresh can hand the same wire name to a
 * completely different object — and would then attribute the call to a tool that never
 * ran.
 *
 * The binding is deliberately a side channel rather than an event field:
 *
 *  - a tool object exposes `execute`, closures over session state, and its own
 *    description/parameters; putting it on `AgentEvent` would make it enumerable, walkable,
 *    and reachable by every serializer, wire envelope, and log sink that copies events, and
 *    `JSON.stringify(event)` would start emitting tool metadata;
 *  - the map is weak on the event object, so the association disappears with the event it
 *    describes and pins nothing alive;
 *  - it carries no arguments, no results, no call ids, and no timing — only object identity,
 *    which is exactly what provenance checks (`WeakSet.has`) need and nothing more.
 */
const dispatchedToolByEvent = new WeakMap<object, object>();

/**
 * Record, at the producer boundary, the tool object this event was emitted for.
 *
 * A call with no resolved tool (an unknown name the loop is about to reject, or a call
 * aborted before dispatch) binds nothing: there is no object, so there is nothing to prove.
 */
export function bindDispatchedToolIdentity(event: object, tool: object | undefined): void {
	if (!tool) return;
	dispatchedToolByEvent.set(event, tool);
}

/** The tool object this event was actually dispatched to, if its producer bound one. */
export function dispatchedToolIdentity(event: object): object | undefined {
	return dispatchedToolByEvent.get(event);
}

/**
 * Tool events emitted only to keep the stream's start/end PAIRING intact, for calls that
 * were never dispatched.
 *
 * A skipped or aborted call still has to produce a result, and every consumer downstream
 * is built around results arriving in pairs, so the loop synthesizes the missing start.
 * That is a stream-shape obligation and nothing more: no `execute` ran, no work began, and
 * no time was spent in a tool.
 *
 * Consumers that merely relay or record events are unaffected and must stay unaffected.
 * Consumers that publish a claim about what is RUNNING are not: between the synthetic
 * start and its end, such a consumer would report a tool as active that was never entered.
 *
 * A side channel rather than an `AgentEvent` field, for the same reasons the dispatched
 * identity is one — no wire/schema surface to serialize, copy, or persist — and a `WeakSet`
 * because the mark is meaningful only for the exact event object it was applied to.
 */
const nonDispatchedToolEvents = new WeakSet<object>();

/** Mark an event as pairing-only: emitted for a call the loop never dispatched. */
export function markNonDispatchedToolEvent(event: object): void {
	nonDispatchedToolEvents.add(event);
}

/** Whether this exact event was synthesized for a call that never ran. */
export function isNonDispatchedToolEvent(event: object): boolean {
	return nonDispatchedToolEvents.has(event);
}

/**
 * Active tool a call name dispatches to. Tools emitted via OpenAI's custom-tool path
 * (e.g. `apply_patch` on GPT-5) come back under their wire-level name, which may differ
 * from the harness-internal `name`. Match on either, preferring `name` for determinism if
 * both somehow collide.
 *
 * This is the single dispatch-matching rule: execution, external-event identity binding,
 * and every "is this tool callable" check must agree, or a label can describe a tool the
 * call would never have reached.
 */
export function activeToolForCallName<T extends { name: string; customWireName?: string }>(
	tools: ReadonlyArray<T> | undefined,
	callName: string,
): T | undefined {
	return (
		tools?.find(tool => tool.name === callName) ??
		tools?.find(tool => tool.customWireName !== undefined && tool.customWireName === callName)
	);
}

import { UNPROVEN_TOOL_LABEL } from "../gjc-runtime/session-state-sidecar";
import { TOOL_DESCRIPTORS } from "../tools/descriptors";

/**
 * Proves whether the tool OBJECT that actually ran is one this session constructed from a
 * built-in descriptor, before any extension, MCP, or dynamically registered tool could
 * override that registry name.
 */
export type BuiltinToolProvenance = (tool: object) => boolean;

/**
 * Canonical public label for the tool object a call was ACTUALLY dispatched to.
 *
 * The input is the object the producer bound to the event, never a name resolved here. A
 * wire name is model text and the tool list behind it is mutable: a `setTools`, MCP
 * reload, or tool refresh between dispatch and this call would otherwise publish whatever
 * holds the name by now instead of what ran.
 *
 * Two independent facts must hold before a canonical label is published:
 *
 *  1. the producer bound a dispatched tool object at all (an unknown name the loop
 *     rejected, and a call aborted before dispatch, bind nothing), AND
 *  2. that object carries built-in provenance and its canonical name is one of the closed
 *     built-in descriptors.
 *
 * The object check is what makes the label trustworthy. A registry name is not
 * provenance: an SDK extension, MCP, or custom tool may register itself as `bash` or
 * `edit`, or claim a built-in `customWireName`, and would otherwise be published under
 * the built-in's label. Without proven provenance — including for a direct AgentSession
 * construction that supplies none — the answer is `custom`.
 */
export function canonicalCoordinatorToolLabel(
	dispatchedTool: object | undefined,
	isBuiltinToolObject: BuiltinToolProvenance,
): string {
	if (!dispatchedTool || !isBuiltinToolObject(dispatchedTool)) return UNPROVEN_TOOL_LABEL;
	const name = (dispatchedTool as { name?: unknown }).name;
	if (typeof name !== "string" || !Object.hasOwn(TOOL_DESCRIPTORS, name)) return UNPROVEN_TOOL_LABEL;
	return name;
}

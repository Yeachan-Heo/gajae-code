/**
 * Canonical command-surface boundary for the agent-wire adapters.
 *
 * RPC and Bridge SHARE the JSONL `RpcCommand` grammar and dispatch it through
 * the single `dispatchRpcCommand` entry in `command-dispatch.ts`. This module
 * re-exports that command surface so the shared contract has one documented home.
 *
 * ACP does NOT use `RpcCommand`. It keeps its richer `@agentclientprotocol/sdk`
 * command surface (fork/resume/elicitation/session-mode/session-model) and only
 * shares the lower session/event layer (`AgentWireEventPayload`). ACP must never
 * import `dispatchRpcCommand`.
 *
 * Event semantics are intentionally elsewhere: `event-contract.ts` owns the event
 * types + registry and `event-observation.ts` owns the single semantic mapping.
 */
export type { RpcCommand, RpcResponse } from "../../rpc/rpc-types";
export { dispatchRpcCommand, type RpcCommandDispatchContext } from "./command-dispatch";
export { isRpcCommandType, RPC_COMMAND_TYPES, type RpcCommandType } from "./scopes";

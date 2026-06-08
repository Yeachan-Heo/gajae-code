/** Shared RPC-compatible response helpers for agent-wire consumers. */
import type { RpcCommand, RpcResponse } from "../../rpc/rpc-types";

export function rpcSuccess<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function rpcError(id: string | undefined, command: string, error: string | object): RpcResponse {
	return { id, type: "response", command, success: false, error } as RpcResponse;
}

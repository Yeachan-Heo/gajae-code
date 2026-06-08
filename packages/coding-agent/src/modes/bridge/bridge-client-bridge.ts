import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";
import type { UiRequestBroker, UiRequestCancelled, UiRequestResolution } from "../shared/agent-wire/ui-request-broker";

export interface BridgePermissionRequestPayload {
	kind: "permission";
	toolCall: ClientBridgePermissionToolCall;
	options: ClientBridgePermissionOption[];
}

export type BridgePermissionBroker = UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>;
function isUiRequestCancelled(
	resolution: UiRequestResolution<ClientBridgePermissionOutcome>,
): resolution is UiRequestCancelled {
	return "status" in resolution && resolution.status === "cancelled";
}

function toPermissionOutcome(
	resolution: UiRequestResolution<ClientBridgePermissionOutcome>,
): ClientBridgePermissionOutcome {
	if (isUiRequestCancelled(resolution)) {
		return { outcome: "cancelled" };
	}
	return resolution;
}

export function createBridgeClientBridge(broker: BridgePermissionBroker): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		deferAgentInitiatedTurns: true,
		async requestPermission(toolCall, options, signal) {
			return toPermissionOutcome(
				await broker.request(
					{ kind: "permission", toolCall, options },
					{
						correlationId: toolCall.toolCallId,
						signal,
					},
				),
			);
		},
	};
}

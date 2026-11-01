/**
 * Canonical trusted-host workflow gate contract. Execution authority remains on
 * the session-owned emitter; no broker/store constructors are public here.
 */

export { approvalGate, executionGate } from "../modes/shared/agent-wire/approval-gate";
export { questionToGate } from "../modes/shared/agent-wire/deep-interview-gate";
export type {
	OpenGateInput,
	WorkflowGateEmitter,
	WorkflowGateTerminalController,
	WorkflowGateTerminalProof,
} from "../modes/shared/agent-wire/workflow-gate-broker";
export {
	canonicalJson,
	compileGateSchema,
	schemaHash,
	validateGateAnswer,
} from "../modes/shared/agent-wire/workflow-gate-schema";
export type {
	JsonSchema,
	WorkflowGate,
	WorkflowGateContext,
	WorkflowGateKind,
	WorkflowGateOption,
	WorkflowGateResolution,
	WorkflowGateResponse,
	WorkflowGateValidationError,
	WorkflowStage,
} from "../modes/shared/agent-wire/workflow-gate-types";

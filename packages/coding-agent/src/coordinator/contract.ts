export const COORDINATOR_MCP_PROTOCOL_VERSION = "2024-11-05";
export const COORDINATOR_MCP_SERVER_NAME = "gjc-coordinator-mcp";

export const COORDINATOR_MCP_TOOL_NAMES = [
	"gjc_coordinator_list_sessions",
	"gjc_coordinator_read_status",
	"gjc_coordinator_read_tail",
	"gjc_coordinator_list_questions",
	"gjc_coordinator_list_artifacts",
	"gjc_coordinator_read_artifact",
	"gjc_coordinator_read_coordination_status",
	"gjc_coordinator_watch_events",
	"gjc_coordinator_register_session",
	"gjc_coordinator_start_session",
	"gjc_coordinator_send_prompt",
	"gjc_coordinator_submit_question_answer",
	"gjc_coordinator_read_turn",
	"gjc_coordinator_await_turn",
	"gjc_coordinator_report_status",
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_MCP_TOOL_NAMES)[number];

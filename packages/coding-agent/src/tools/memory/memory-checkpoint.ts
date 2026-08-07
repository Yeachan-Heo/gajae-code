import type { AgentTool } from "@gajae-code/agent-core";
import { type CheckpointInput, type CheckpointResult, checkpoint } from "@gajae-code/memory-core";
import * as z from "zod/v4";
import type { ToolSession } from "..";
import {
	buildMemoryToolEnvironment,
	type MemoryToolDetails,
	type MemoryToolResult,
	memoryToolEnabled,
	memoryToolError,
	memoryToolResult,
	memoryToolUnexpectedFailure,
} from "./memory-recall";

const memoryCheckpointSchema = z
	.object({
		goal: z.string().describe("checkpoint goal"),
		task: z.string().describe("current task"),
		nextSteps: z.array(z.string()).max(3).describe("at most three next steps"),
		constraints: z.array(z.string()).optional().describe("current constraints"),
		decisions: z.array(z.string()).optional().describe("pending or recorded decisions"),
		risks: z.array(z.string()).optional().describe("known risks"),
	})
	.strict();

export type MemoryCheckpointParams = z.infer<typeof memoryCheckpointSchema>;

export class MemoryCheckpointTool
	implements AgentTool<typeof memoryCheckpointSchema, MemoryToolDetails<CheckpointResult>>
{
	readonly name = "memory_checkpoint";
	readonly label = "Memory Checkpoint";
	readonly summary = "Persist a versioned session checkpoint through canonical memory";
	readonly description =
		"Write a structured session checkpoint through memory-core. This records resumable session state in the initialized memory root.";
	readonly parameters = memoryCheckpointSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static async createIf(session: ToolSession): Promise<MemoryCheckpointTool | null> {
		return (await memoryToolEnabled(session)) ? new MemoryCheckpointTool(session) : null;
	}

	async execute(_id: string, params: MemoryCheckpointParams): Promise<MemoryToolResult<CheckpointResult>> {
		const environment = await buildMemoryToolEnvironment(this.session, "checkpoint");
		if (!environment.ok) return memoryToolError(environment.error);
		try {
			return memoryToolResult(await checkpoint(environment.value, params satisfies CheckpointInput));
		} catch {
			return await memoryToolUnexpectedFailure(this.session, "checkpoint");
		}
	}
}

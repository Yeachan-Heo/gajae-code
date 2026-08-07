import type { AgentTool } from "@gajae-code/agent-core";
import { type ForgetInput, type ForgetReceipt, forget } from "@gajae-code/memory-core";
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

const memoryForgetSchema = z
	.object({
		uri: z.string().describe("canonical memory URI to tombstone"),
		expectedDigest: z.string().nullable().optional().describe("optional compare-and-swap digest"),
		reason: z.string().optional().describe("optional reason for the tombstone"),
	})
	.strict();

export type MemoryForgetParams = z.infer<typeof memoryForgetSchema>;

export class MemoryForgetTool implements AgentTool<typeof memoryForgetSchema, MemoryToolDetails<ForgetReceipt>> {
	readonly name = "memory_forget";
	readonly label = "Memory Forget";
	readonly summary = "Tombstone a canonical memory document through memory-core";
	readonly description =
		"Forget one canonical memory URI through memory-core's tombstone/supersession operation. This never performs a raw file deletion.";
	readonly parameters = memoryForgetSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static async createIf(session: ToolSession): Promise<MemoryForgetTool | null> {
		return (await memoryToolEnabled(session)) ? new MemoryForgetTool(session) : null;
	}

	async execute(_id: string, params: MemoryForgetParams): Promise<MemoryToolResult<ForgetReceipt>> {
		const environment = await buildMemoryToolEnvironment(this.session, "project-canonical");
		if (!environment.ok) return memoryToolError(environment.error);
		try {
			return memoryToolResult(await forget(environment.value, params satisfies ForgetInput));
		} catch {
			return await memoryToolUnexpectedFailure(this.session, "project-canonical");
		}
	}
}

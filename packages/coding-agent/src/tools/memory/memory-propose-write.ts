import type { AgentTool } from "@gajae-code/agent-core";
import {
	type MemoryDocumentType,
	type MemoryScopeKind,
	type ProposeInput,
	propose,
	type WriteProposal,
} from "@gajae-code/memory-core";
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

const MEMORY_DOCUMENT_TYPES = [
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
] as const satisfies readonly MemoryDocumentType[];
const MEMORY_SCOPES = ["global", "project", "session"] as const satisfies readonly MemoryScopeKind[];

const memoryProposeWriteSchema = z
	.object({
		type: z.enum(MEMORY_DOCUMENT_TYPES).describe("memory document type"),
		content: z.string().describe("document content to propose"),
		targetScope: z.enum(MEMORY_SCOPES).optional().describe("optional target scope"),
		targetUri: z.string().optional().describe("optional target URI"),
		sourceSession: z.string().nullable().optional().describe("source session identifier"),
		supersedes: z.array(z.string()).optional().describe("URIs superseded by the proposal"),
	})
	.strict();

export type MemoryProposeWriteParams = z.infer<typeof memoryProposeWriteSchema>;

export class MemoryProposeWriteTool
	implements AgentTool<typeof memoryProposeWriteSchema, MemoryToolDetails<WriteProposal>>
{
	readonly name = "memory_propose_write";
	readonly label = "Memory Propose Write";
	readonly summary = "Create a memory write proposal without applying canonical changes";
	readonly description =
		"Build and stage a versioned write proposal through memory-core. This tool proposes content only and never applies or directly mutates canonical documents.";
	readonly parameters = memoryProposeWriteSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static async createIf(session: ToolSession): Promise<MemoryProposeWriteTool | null> {
		return (await memoryToolEnabled(session)) ? new MemoryProposeWriteTool(session) : null;
	}

	async execute(_id: string, params: MemoryProposeWriteParams): Promise<MemoryToolResult<WriteProposal>> {
		const environment = await buildMemoryToolEnvironment(this.session, "proposal");
		if (!environment.ok) return memoryToolError(environment.error);
		try {
			return memoryToolResult(await propose(environment.value, params satisfies ProposeInput));
		} catch {
			return await memoryToolUnexpectedFailure(this.session, "proposal");
		}
	}
}

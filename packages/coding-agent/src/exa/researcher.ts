/**
 * Exa Researcher Tools
 *
 * Async research tasks with polling for completion.
 */
import type { TSchema } from "@gajae-code/ai/core";
import * as z from "zod/v4";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { createExaTool } from "./factory";
import type { ExaRenderDetails } from "./types";

const researcherStartTool = createExaTool(
	"exa_researcher_start",
	"Start Deep Research",
	"Start an asynchronous deep research task using Exa's researcher. Returns a task_id for polling completion.",
	z.object({
		query: z.string().describe("research query"),
		depth: z.number().int().min(1).max(5).describe("research depth (1-5)").optional(),
		breadth: z.number().int().min(1).max(5).describe("research breadth (1-5)").optional(),
	}),
	"deep_researcher_start",
	{ formatResponse: false },
);

const researcherPollTool = createExaTool(
	"exa_researcher_poll",
	"Poll Research Status",
	"Poll the status of an asynchronous research task. Returns status (pending|running|completed|failed) and result if completed.",
	z.object({
		task_id: z.string().describe("task id"),
	}),
	"deep_researcher_check",
	{ formatResponse: false },
);

export const researcherTools: CustomTool<TSchema, ExaRenderDetails>[] = [researcherStartTool, researcherPollTool];

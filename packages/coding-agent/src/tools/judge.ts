/**
 * Judge Tool
 *
 * Calibrated typed judgments via the TypeSafe System One (Jev) API: noul
 * probabilities, option choices, and weighted scores over caller-supplied
 * state. A network read tool — it judges, it does not generate.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import judgeDescription from "../prompts/tools/judge.md" with { type: "text" };
import { evaluateTypeSafe, getTypeSafeApiKey, type TypeSafeEvaluateResult } from "../typesafe/client";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

/** Judge tool parameters schema */
export const judgeSchema = type({
	state: type("unknown").describe("the object or text being judged"),
	questions: type({
		"[string]": {
			type: "'noul' | 'choice' | 'score'",
			instructions: "unknown",
			"criteria?": "unknown",
		},
	}).describe("map of question id → { type: noul|choice|score, instructions, criteria? }"),
	"model?": type("string").describe("TypeSafe model override (default jev-latest)"),
});

export type JudgeToolParams = typeof judgeSchema.infer;

export interface JudgeToolDetails {
	result?: TypeSafeEvaluateResult;
	error?: string;
}

/**
 * Judge tool implementation.
 *
 * Always registered when `judge.enabled`; calls without `TYPESAFE_API_KEY`
 * return a clear error result, mirroring web_search's unconfigured behavior.
 */
export class JudgeTool implements AgentTool<typeof judgeSchema, JudgeToolDetails> {
	readonly name = "judge";
	readonly approval = "read" as const;
	readonly label = "Judge";
	readonly description: string;
	readonly parameters = judgeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Calibrated typed judgments via TypeSafe";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(judgeDescription);
	}

	async execute(
		_toolCallId: string,
		params: JudgeToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<JudgeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JudgeToolDetails>> {
		const apiKey = getTypeSafeApiKey();
		if (!apiKey) {
			const message = "TypeSafe is not configured. Set TYPESAFE_API_KEY to enable the judge tool.";
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message },
			};
		}
		try {
			const result = await evaluateTypeSafe(params.state, params.questions, {
				apiKey,
				signal,
				model: params.model,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: { result },
			};
		} catch (error) {
			// Surface user-initiated cancellation as a clean abort, not a tool error.
			throwIfAborted(signal);
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message },
			};
		}
	}
}

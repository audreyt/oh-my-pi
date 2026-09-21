/**
 * Judge Tool
 *
 * Calibrated typed judgments through the session's `judge` role chain.
 * A network read tool — it judges, it does not generate.
 */
import { type } from "@oh-my-pi/omptype";
import type { JudgmentResult, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveJudge } from "../judgment";
import judgeDescription from "../prompts/tools/judge.md" with { type: "text" };
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

/** Judge tool parameters schema */
export const judgeSchema = type({
	state: type("unknown").describe("the object or text being judged"),
	questions: type({
		"[string]": {
			type: "'noul' | 'choice' | 'score'",
			instructions: "string",
			"criteria?": "unknown",
		},
	}).describe("map of question id → { type: noul|choice|score, instructions, criteria? }"),
});

export type JudgeToolParams = typeof judgeSchema.infer;

export interface JudgeToolDetails {
	result?: JudgmentResult;
	error?: string;
}

/**
 * Judge tool implementation.
 *
 * Always registered when `judge.enabled`; resolves the session's judgment
 * backend per call so `providers.judgmentProvider` changes take effect
 * immediately and TypeSafe failures fall back to the chat bridge.
 */
export class JudgeTool implements AgentTool<typeof judgeSchema, JudgeToolDetails> {
	readonly name = "judge";
	readonly approval = "read" as const;
	readonly label = "Judge";
	readonly description: string;
	readonly parameters = judgeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Calibrated typed judgments";

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
		const registry = this.session.modelRegistry;
		if (!registry) {
			const message = "No model registry available to resolve a judgment backend.";
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message },
			};
		}
		try {
			const judge = resolveJudge({
				settings: this.session.settings,
				registry,
				sessionModel: this.session.getActiveModel?.(),
			});
			const result = await judge.judge(
				{ state: params.state as JudgmentState, questions: params.questions as Questions },
				{ signal },
			);
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

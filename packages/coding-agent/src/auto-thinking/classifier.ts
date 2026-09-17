/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Picks a coding-difficulty bucket for a user prompt and maps it to a concrete
 * {@link Effort}, clamped into the active model's supported range (never below
 * {@link Effort.Low}). Two backends, selected by `providers.autoThinkingModel`:
 *
 * - `online` (default): a smol model classifies into `low|medium|high|xhigh`,
 *   plus `max` when the target model exposes that tier.
 * - a local key: an on-device memory model classifies into the coarser
 *   `trivial|moderate|hard` scheme (3-class is more reliable than 4-way ordinal
 *   on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no model, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import {
	type AssistantMessage,
	completeSimple,
	Effort,
	type Model,
	retryTransientCompletion,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { collectOnlineTinyCandidates } from "../tiny/online-candidates";
import type { Settings } from "../config/settings";
import difficultySystemPrompt from "../prompts/system/auto-thinking-difficulty.md" with { type: "text" };
import difficultyLocalPrompt from "../prompts/system/auto-thinking-difficulty-local.md" with { type: "text" };
import difficultyTypeSafePrompt from "../prompts/system/auto-thinking-typesafe.md" with { type: "text" };
import { clampAutoThinkingEffort } from "../thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";
import { evaluateTypeSafe, getTypeSafeApiKey, TYPESAFE_MODEL_KEY, type TypeSafeAnswer } from "../typesafe/client";

/**
 * Rendered classifier prompts, keyed by whether `max` is offered as a label.
 * Two variants only, so both are memoized on first use.
 */
const DIFFICULTY_SYSTEM_PROMPTS: Partial<Record<"max" | "xhigh", string>> = {};
const TYPESAFE_INSTRUCTION_PROMPTS: Partial<Record<"max" | "xhigh", string>> = {};

/**
 * Highest effort this turn's classification may resolve to: the configured
 * ceiling, further limited by what the target model actually exposes. The
 * default keeps `auto` one tier below the top, so only an explicit
 * `ultrathink` reaches {@link Effort.Max}.
 */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (deps.settings.get("providers.autoThinkingMaxEffort") !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

function difficultyPromptFor(
	template: string,
	cache: Partial<Record<"max" | "xhigh", string>>,
	ceiling: Effort,
): string {
	const key = ceiling === Effort.Max ? "max" : "xhigh";
	const cached = cache[key];
	if (cached !== undefined) return cached;
	const rendered = prompt.render(template, { allowMax: key === "max" });
	cache[key] = rendered;
	return rendered;
}

/** Local classifiers occasionally need more room for chat-template boilerplate. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning classifiers need room for the bucket keyword after the `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;
/**
 * Online classifier budget. Sized against two independent constraints:
 *   - Backends that ignore `disableReasoning` still emit a thinking preamble
 *     (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` but still thinking;
 *     Anthropic via LiteLLM/Vertex, whose `openai-completions` route downgrades a
 *     disabled request to the lowest reasoning effort instead of turning thinking
 *     off). The classifier keyword must have room to land after that preamble
 *     (issue #4355).
 *   - Anthropic-dialect proxies reject `max_tokens <= thinking.budget_tokens`. The
 *     pinned lowest effort maps to at least Anthropic's 1024-token minimum budget,
 *     so the cap MUST comfortably exceed 1024 or every classifier call 400s with
 *     `max_tokens must be greater than thinking.budget_tokens` (issue #8610).
 * `maxTokens` is a hard cap — non-thinking completions still return in a handful
 * of tokens.
 */
const ONLINE_REASONING_SAFE_MAX_TOKENS = 4096;

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: ClassifierUsage) => void;
}

export interface ClassifierUsage {
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

/**
 * Classify `promptText` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface (auto has
 * nothing to pick — the caller leaves the prior reasoning level in place).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	promptText: string,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const backend = deps.settings.get("providers.autoThinkingModel");
	const input = preprocessTinyMessage(promptText);
	const online = backend === ONLINE_AUTO_THINKING_MODEL_KEY;
	const typesafe = backend === TYPESAFE_MODEL_KEY;
	// The 3-bucket local classifier cannot select `max`, so its ceiling stays at
	// XHigh whatever the setting says — otherwise a sparse ladder would snap its
	// `hard` bucket up to a tier it never chose. TypeSafe answers the same level
	// set as online, so it shares the online ceiling.
	const ceiling = online || typesafe ? autoEffortCeiling(deps) : Effort.XHigh;
	const effort = online
		? await classifyOnline(input, deps, ceiling)
		: typesafe
			? await classifyTypeSafe(input, deps, ceiling)
			: await classifyLocal(input, backend, deps);
	// The ceiling goes into the clamp itself: capping the request alone is not
	// enough, because a sparse ladder snaps an excluded request back up.
	return clampAutoThinkingEffort(deps.model, effort, ceiling);
}

async function classifyOnline(input: string, deps: ClassifyDifficultyDeps, ceiling: Effort): Promise<Effort> {
	const candidates = collectOnlineTinyCandidates(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
	if (candidates.length === 0) {
		throw new Error("auto-thinking: no tiny/smol model available for classification");
	}
	const maxTokens = ONLINE_REASONING_SAFE_MAX_TOKENS;
	let lastError: string | undefined;
	for (const resolved of candidates) {
		if (deps.signal?.aborted) {
			throw deps.signal.reason instanceof Error
				? deps.signal.reason
				: new AIError.AbortError("auto-thinking: classification aborted");
		}
		const model = resolved.model;
		try {
			const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
			if (!apiKey) {
				lastError = `no API key for ${model.provider}/${model.id}`;
				continue;
			}
			// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
			const metadata = deps.metadataResolver?.(model.provider);
			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						model,
						{
							systemPrompt: [difficultyPromptFor(difficultySystemPrompt, DIFFICULTY_SYSTEM_PROMPTS, ceiling)],
							messages: [{ role: "user", content: input, timestamp: Date.now() }],
						},
						{
							apiKey: deps.registry.resolver(model, deps.sessionId),
							sessionId: deps.sessionId,
							maxTokens,
							disableReasoning: true,
							metadata,
							signal: deps.signal,
							onAttempt: attempt =>
								deps.onUsage?.({
									role: resolved.role,
									api: attempt.api,
									provider: attempt.provider,
									model: attempt.model,
									usage: attempt.usage,
									stopReason: attempt.stopReason,
									errorMessage: attempt.errorMessage,
								}),
						},
					),
				{ signal: deps.signal, provider: model.provider },
			);

			if (response.stopReason === "aborted" || deps.signal?.aborted) {
				throw deps.signal?.reason instanceof Error
					? deps.signal.reason
					: new AIError.AbortError("auto-thinking: classification aborted");
			}
			if (response.stopReason === "error") {
				lastError = response.errorMessage ?? "unknown error";
				continue;
			}

			const text = extractText(response.content);
			const effort = parseDifficultyLevel(text);
			if (!effort) {
				lastError = `unparseable online classification: ${JSON.stringify(text)}`;
				continue;
			}
			return effort;
		} catch (err) {
			if (deps.signal?.aborted) {
				throw deps.signal.reason instanceof Error
					? deps.signal.reason
					: err instanceof Error
						? err
						: new AIError.AbortError("auto-thinking: classification aborted");
			}
			if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
				throw err;
			}
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	throw new Error(`auto-thinking: online classification failed: ${lastError ?? "unknown error"}`);
}

async function classifyLocal(input: string, modelKey: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`auto-thinking: unsupported local classifier model: ${modelKey}`);
	}
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey)
		? Math.max(LOCAL_ANSWER_MAX_TOKENS, LOCAL_REASONING_MAX_TOKENS)
		: LOCAL_ANSWER_MAX_TOKENS;
	const builtPrompt = prompt.render(difficultyLocalPrompt, { prompt: input });
	const text = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens,
		signal: deps.signal,
	});
	if (!text) {
		throw new Error("auto-thinking: local classification returned no output");
	}
	const effort = parseDifficultyBucket(text);
	if (!effort) {
		throw new Error(`auto-thinking: unparseable local classification: ${JSON.stringify(text)}`);
	}
	return effort;
}

/**
 * TypeSafe (Jev) backend: one `choice` question over the same level set the
 * online classifier is offered (`max` only when the ceiling allows it).
 */
async function classifyTypeSafe(input: string, deps: ClassifyDifficultyDeps, ceiling: Effort): Promise<Effort> {
	const apiKey = getTypeSafeApiKey();
	if (!apiKey) {
		throw new Error("auto-thinking: no TYPESAFE_API_KEY for typesafe classification");
	}
	const levels = ["low", "medium", "high", "xhigh", ...(ceiling === Effort.Max ? ["max"] : [])];
	const result = await evaluateTypeSafe(
		input,
		{
			difficulty: {
				type: "choice",
				instructions: difficultyPromptFor(difficultyTypeSafePrompt, TYPESAFE_INSTRUCTION_PROMPTS, ceiling),
				// Option rubric lives in the instructions; criteria keys declare the option set.
				criteria: Object.fromEntries(levels.map(level => [level, null])),
			},
		},
		{ apiKey, signal: deps.signal },
	);
	const answer = result.answers.difficulty;
	const effort = answer ? effortFromTypeSafeAnswer(answer) : undefined;
	if (!effort) {
		throw new Error(`auto-thinking: unparseable typesafe classification: ${JSON.stringify(answer ?? null)}`);
	}
	return effort;
}

const TYPESAFE_LEVEL_EFFORTS: Record<string, Effort> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

/**
 * Map a TypeSafe choice answer to an {@link Effort}: argmax over
 * `probabilities` (the `score` field's indexing convention is ambiguous),
 * falling back to the declared `choice` when probabilities are absent.
 */
function effortFromTypeSafeAnswer(answer: TypeSafeAnswer): Effort | undefined {
	const probabilities = answer.probabilities;
	if (probabilities) {
		let best: { level: string; probability: number } | undefined;
		for (const [level, probability] of Object.entries(probabilities)) {
			if (typeof probability !== "number") continue;
			if (!best || probability > best.probability) best = { level, probability };
		}
		if (best) return TYPESAFE_LEVEL_EFFORTS[best.level.trim().toLowerCase()];
	}
	return answer.choice ? TYPESAFE_LEVEL_EFFORTS[answer.choice.trim().toLowerCase()] : undefined;
}

/**
 * Map an online level keyword to an {@link Effort}; earliest match wins.
 *
 * `max` is only offered to the classifier when the target model exposes that
 * tier, but it is always parsed: an unsupported `max` is snapped back down by
 * {@link clampAutoThinkingEffort} rather than failing the turn.
 */
export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	// `xhigh` must be probed as its own token: `\bhigh\b` cannot match the "high"
	// inside "xhigh" (no word boundary between `x` and `h`), so the two never collide.
	const xhigh = lower.search(/x[\s_-]?high/);
	if (xhigh >= 0) candidates.push([xhigh, Effort.XHigh]);
	const max = lower.search(/\bmax\b/);
	if (max >= 0) candidates.push([max, Effort.Max]);
	const high = lower.search(/\bhigh\b/);
	if (high >= 0) candidates.push([high, Effort.High]);
	const medium = lower.search(/\bmed(?:ium)?\b/);
	if (medium >= 0) candidates.push([medium, Effort.Medium]);
	const low = lower.search(/\blow\b/);
	if (low >= 0) candidates.push([low, Effort.Low]);
	return earliest(candidates);
}

/** Map the local 3-way bucket keyword to an {@link Effort}; earliest match wins. */
export function parseDifficultyBucket(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	const trivial = lower.search(/\btrivial\b/);
	if (trivial >= 0) candidates.push([trivial, Effort.Low]);
	const moderate = lower.search(/\bmoderate\b/);
	if (moderate >= 0) candidates.push([moderate, Effort.High]);
	const hard = lower.search(/\bhard\b/);
	if (hard >= 0) candidates.push([hard, Effort.XHigh]);
	return earliest(candidates);
}

function earliest(candidates: Array<[number, Effort]>): Effort | undefined {
	if (candidates.length === 0) return undefined;
	let best = candidates[0];
	for (const candidate of candidates) {
		if (candidate[0] < best[0]) best = candidate;
	}
	return best[1];
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}

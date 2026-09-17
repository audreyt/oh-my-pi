/**
 * Minimal client for TypeSafe System One (Jev) — a decision-only model that
 * returns typed judgments (noul/choice/score) instead of generated text.
 * Used by the generative classifiers as an alternative to prompt-and-parse.
 * No SDK: a single POST to the evaluation endpoint.
 */
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Settings value selecting the TypeSafe backend for classifier roles. */
export const TYPESAFE_MODEL_KEY = "typesafe";

const TYPESAFE_EVALUATE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_DEFAULT_MODEL = "jev-latest";
const TYPESAFE_DEFAULT_TIMEOUT_MS = 10_000;
/** Error bodies can be large; keep thrown messages bounded. */
const ERROR_BODY_MAX_CHARS = 500;

export interface TypeSafeQuestion {
	type: "noul" | "choice" | "score";
	instructions: unknown;
	criteria?: unknown;
}

export interface TypeSafeAnswer {
	type: string;
	noul?: number;
	choice?: string;
	score?: number;
	probabilities?: Record<string, number>;
	confidence?: number;
	legend?: Record<string, string>;
}

export interface TypeSafeEvaluateResult {
	model: string;
	answers: Record<string, TypeSafeAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** API key for the TypeSafe backend (`TYPESAFE_API_KEY`). */
export function getTypeSafeApiKey(): string | undefined {
	return getEnvApiKey("typesafe");
}

/**
 * Evaluate `state` against a map of typed questions; answers come back under
 * the same question ids. Answers whose `type` does not match their question's
 * `type` are dropped rather than trusted.
 *
 * @throws on missing API key, non-2xx responses, or a malformed body.
 */
export async function evaluateTypeSafe(
	state: unknown,
	questions: Record<string, TypeSafeQuestion>,
	opts?: { apiKey?: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<TypeSafeEvaluateResult> {
	const apiKey = opts?.apiKey ?? getTypeSafeApiKey();
	if (!apiKey) {
		throw new Error("typesafe: no API key (set TYPESAFE_API_KEY)");
	}
	const timeoutMs = opts?.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS;
	const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	const signal = timeout ? (opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout) : opts?.signal;

	const response = await fetch(TYPESAFE_EVALUATE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			state,
			model: opts?.model ?? TYPESAFE_DEFAULT_MODEL,
			questions,
		}),
		signal,
	});

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, ERROR_BODY_MAX_CHARS);
		throw new Error(`typesafe: HTTP ${response.status}: ${body}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.answers)) {
		throw new Error("typesafe: malformed response (missing answers map)");
	}
	const model = typeof payload.model === "string" ? payload.model : (opts?.model ?? TYPESAFE_DEFAULT_MODEL);
	const usage = isRecord(payload.usage) ? (payload.usage as TypeSafeEvaluateResult["usage"]) : undefined;

	const answers: Record<string, TypeSafeAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = payload.answers[id];
		if (!isRecord(answer) || answer.type !== question.type) continue;
		answers[id] = answer as unknown as TypeSafeAnswer;
	}
	return { model, answers, usage };
}

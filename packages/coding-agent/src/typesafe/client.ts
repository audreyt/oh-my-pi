/**
 * Minimal TypeSafe (System One / Jev) API client.
 *
 * One POST to `https://api.typesafe.ai/v1/systemone` evaluates a caller-built
 * `state` object against a map of typed questions (`noul` | `choice` |
 * `score`) and returns the model's answers. No SDK dependency — plain fetch.
 *
 * Auth: `TYPESAFE_API_KEY` env var (see {@link getTypeSafeApiKey}), or an
 * explicit `opts.apiKey`. Callers are expected to fail closed: any thrown
 * error (missing key, non-2xx, malformed body, abort/timeout) means "no
 * answer", never a turn-blocking failure.
 */
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Env/registry key under which the TypeSafe credential resolves. */
export const TYPESAFE_MODEL_KEY = "typesafe";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cap on the error body echoed into the thrown message. */
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

/** Resolves the TypeSafe API key from env (`TYPESAFE_API_KEY`). */
export function getTypeSafeApiKey(): string | undefined {
	return getEnvApiKey(TYPESAFE_MODEL_KEY);
}

/**
 * Evaluate `state` against `questions` in a single System One request.
 *
 * Throws on missing credentials, non-2xx responses (status + truncated body),
 * and malformed payloads (missing `answers` map). Answers whose `type` does
 * not match the corresponding question's `type` — or that name no asked
 * question — are dropped from the result.
 */
export async function evaluateTypeSafe(
	state: unknown,
	questions: Record<string, TypeSafeQuestion>,
	opts?: { apiKey?: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<TypeSafeEvaluateResult> {
	const apiKey = opts?.apiKey ?? getTypeSafeApiKey();
	if (!apiKey) {
		throw new Error("TypeSafe API key not configured (set TYPESAFE_API_KEY)");
	}
	const timeoutSignal = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

	const response = await fetch(TYPESAFE_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			state,
			model: opts?.model ?? DEFAULT_MODEL,
			questions,
		}),
		signal,
	});
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, ERROR_BODY_MAX_CHARS);
		throw new Error(`TypeSafe evaluate failed: HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.answers)) {
		throw new Error("TypeSafe evaluate returned a malformed response (missing answers map)");
	}
	const answers: Record<string, TypeSafeAnswer> = {};
	for (const [id, raw] of Object.entries(payload.answers)) {
		const question = questions[id];
		if (!isRecord(raw) || question === undefined || raw.type !== question.type) continue;
		const answer: TypeSafeAnswer = { type: question.type };
		if (typeof raw.noul === "number") answer.noul = raw.noul;
		if (typeof raw.choice === "string") answer.choice = raw.choice;
		if (typeof raw.score === "number") answer.score = raw.score;
		if (typeof raw.confidence === "number") answer.confidence = raw.confidence;
		if (isRecord(raw.probabilities)) {
			answer.probabilities = Object.fromEntries(
				Object.entries(raw.probabilities).filter(
					(entry): entry is [string, number] => typeof entry[1] === "number",
				),
			);
		}
		if (isRecord(raw.legend)) {
			answer.legend = Object.fromEntries(
				Object.entries(raw.legend).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
		}
		answers[id] = answer;
	}
	const usage = isRecord(payload.usage)
		? {
				...(typeof payload.usage.input_tokens === "number" ? { input_tokens: payload.usage.input_tokens } : {}),
				...(typeof payload.usage.output_tokens === "number" ? { output_tokens: payload.usage.output_tokens } : {}),
			}
		: undefined;
	return {
		model: typeof payload.model === "string" ? payload.model : (opts?.model ?? DEFAULT_MODEL),
		answers,
		...(usage ? { usage } : {}),
	};
}

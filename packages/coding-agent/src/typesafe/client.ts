/**
 * TypeSafe (System One / Jev) client.
 *
 * Thin fetch wrapper over `POST https://api.typesafe.ai/v1/systemone`, which
 * returns calibrated typed judgments for a supplied state and question set.
 * No SDK dependency; the API key resolves through the standard env-key path
 * (`TYPESAFE_API_KEY`, see `LEGACY_ENV_KEYS` in pi-ai).
 */

import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Provider key used for env-key resolution (`TYPESAFE_API_KEY`). */
export const TYPESAFE_MODEL_KEY = "typesafe";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_CHARS = 500;

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

/** Resolve the TypeSafe API key from the environment (`TYPESAFE_API_KEY`). */
export function getTypeSafeApiKey(): string | undefined {
	return getEnvApiKey(TYPESAFE_MODEL_KEY);
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Copy only the entries of `value` whose values satisfy `pick`; undefined when `value` is not a record. */
function pickRecordEntries<T>(value: unknown, pick: (entry: unknown) => entry is T): Record<string, T> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (pick(entry)) out[key] = entry;
	}
	return out;
}

/**
 * Evaluate typed questions against `state` via the TypeSafe System One API.
 *
 * Throws on transport failure, non-2xx status (message carries the status and
 * a truncated body), a malformed response (missing `answers` map), or abort.
 * Answers whose `type` does not match their question's declared `type` are
 * dropped from the result.
 */
export async function evaluateTypeSafe(
	state: unknown,
	questions: Record<string, TypeSafeQuestion>,
	opts?: { apiKey?: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<TypeSafeEvaluateResult> {
	const apiKey = opts?.apiKey ?? getTypeSafeApiKey();
	if (!apiKey) {
		throw new Error("TypeSafe is not configured. Set TYPESAFE_API_KEY to enable typed judgments.");
	}
	const model = opts?.model ?? DEFAULT_MODEL;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const signal = opts?.signal
		? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);

	const response = await fetch(TYPESAFE_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ state, model, questions }),
		signal,
	});

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_CHARS);
		throw new Error(`TypeSafe request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !isRecord(payload.answers)) {
		throw new Error("TypeSafe returned a malformed response: missing answers map.");
	}

	const answers: Record<string, TypeSafeAnswer> = {};
	for (const [key, value] of Object.entries(payload.answers)) {
		if (!isRecord(value) || typeof value.type !== "string") continue;
		const question = questions[key];
		if (question && value.type !== question.type) continue;
		const answer: TypeSafeAnswer = { type: value.type };
		const noul = numberOrUndefined(value.noul);
		if (noul !== undefined) answer.noul = noul;
		const choice = stringOrUndefined(value.choice);
		if (choice !== undefined) answer.choice = choice;
		const score = numberOrUndefined(value.score);
		if (score !== undefined) answer.score = score;
		const probabilities = pickRecordEntries(
			value.probabilities,
			(entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
		);
		if (probabilities !== undefined) answer.probabilities = probabilities;
		const confidence = numberOrUndefined(value.confidence);
		if (confidence !== undefined) answer.confidence = confidence;
		const legend = pickRecordEntries(value.legend, (entry): entry is string => typeof entry === "string");
		if (legend !== undefined) answer.legend = legend;
		answers[key] = answer;
	}

	const result: TypeSafeEvaluateResult = {
		model: stringOrUndefined(payload.model) ?? model,
		answers,
	};
	if (isRecord(payload.usage)) {
		const usage: { input_tokens?: number; output_tokens?: number } = {};
		const inputTokens = numberOrUndefined(payload.usage.input_tokens);
		if (inputTokens !== undefined) usage.input_tokens = inputTokens;
		const outputTokens = numberOrUndefined(payload.usage.output_tokens);
		if (outputTokens !== undefined) usage.output_tokens = outputTokens;
		result.usage = usage;
	}
	return result;
}

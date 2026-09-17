/**
 * Per-turn skill suggestion via TypeSafe (System One / Jev).
 *
 * One `evaluateTypeSafe` request per user turn asks two questions at once:
 * `needs_skill` (noul — does this turn benefit from a specialized skill) and
 * `pick` (choice over the skill catalog plus a literal `none`). A skill name
 * is returned only when the noul gate and the pick's own confidence both
 * clear 0.5 and the pick is not `none`.
 *
 * Fail closed by contract: any error (missing key, HTTP failure, malformed
 * response, abort/timeout) resolves to `undefined` with a debug log — the
 * turn proceeds without a suggestion.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import skillSuggestPrompt from "../prompts/system/skill-suggest.md" with { type: "text" };
import { evaluateTypeSafe, type TypeSafeQuestion } from "../typesafe/client";
import type { Skill } from "./skills";

/** Literal opt-out choice offered alongside every skill name. */
const NONE_CHOICE = "none";
/** Both the noul gate and the pick's confidence must reach this floor. */
const MIN_CONFIDENCE = 0.5;
/** Catalog sent to the API is bounded so a huge skill set can't blow the request up. */
const MAX_SKILLS = 250;
const MAX_SKILL_DESCRIPTION_CHARS = 200;
/** Bound on the turn text shipped to api.typesafe.ai. */
const MAX_USER_MESSAGE_CHARS = 8_000;

export interface SkillSuggestionDeps {
	apiKey?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	model?: string;
}

/**
 * Suggest at most one skill for this user turn, or `undefined`.
 * Never throws; callers may fire-and-forget the promise alongside other
 * per-turn work and await it just before the model call.
 */
export async function suggestSkill(
	turnText: string,
	skills: readonly Skill[],
	deps: SkillSuggestionDeps = {},
): Promise<string | undefined> {
	try {
		const catalog = skills
			.filter(skill => skill.hide !== true)
			.slice(0, MAX_SKILLS)
			.map(skill => ({ name: skill.name, description: skill.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS) }));
		if (catalog.length === 0) return undefined;
		const options = [...catalog.map(skill => skill.name), NONE_CHOICE];
		const questions: Record<string, TypeSafeQuestion> = {
			needs_skill: {
				type: "noul",
				instructions: prompt.render(skillSuggestPrompt, { kind: "noul" }),
			},
			pick: {
				type: "choice",
				instructions: prompt.render(skillSuggestPrompt, { kind: "pick", options }),
				// criteria is a map<option, description|null>: keys declare the option set.
				criteria: Object.fromEntries(options.map(option => [option, null])),
			},
		};
		const result = await evaluateTypeSafe(
			{ user_message: turnText.slice(0, MAX_USER_MESSAGE_CHARS), skills: catalog },
			questions,
			deps,
		);
		const needsSkill = result.answers.needs_skill;
		const pick = result.answers.pick;
		if ((needsSkill?.noul ?? 0) < MIN_CONFIDENCE) return undefined;
		const choice = pick?.choice;
		if (!choice || choice === NONE_CHOICE || (pick?.confidence ?? 0) < MIN_CONFIDENCE) return undefined;
		return catalog.some(skill => skill.name === choice) ? choice : undefined;
	} catch (error) {
		logger.debug("skill-suggest: evaluation failed; skipping suggestion", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

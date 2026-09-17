/**
 * Per-turn skill suggestion through the session's judgment backend
 * (`providers.judgmentProvider` — TypeSafe System One when authenticated,
 * else the tiny/smol chat bridge).
 *
 * One `judge()` request per user turn asks two questions at once:
 * `needs_skill` (noul — does this turn benefit from a specialized skill) and
 * `pick` (choice over the skill catalog plus a literal `none`). A skill name
 * is returned only when the noul gate and the pick's own confidence both
 * clear 0.5 and the pick is not `none`.
 *
 * Fail closed by contract: any error (no backend, HTTP failure, malformed
 * response, abort/timeout) resolves to `undefined` with a debug log — the
 * turn proceeds without a suggestion.
 */
import type { Judge, JudgeOptions } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import skillSuggestPrompt from "../prompts/system/skill-suggest.md" with { type: "text" };
import type { Skill } from "./skills";

/** Literal opt-out choice offered alongside every skill name. */
const NONE_CHOICE = "none";
/** Both the noul gate and the pick's confidence must reach this floor. */
const MIN_CONFIDENCE = 0.5;
/** Catalog sent to the backend is bounded so a huge skill set can't blow the request up. */
const MAX_SKILLS = 250;
const MAX_SKILL_DESCRIPTION_CHARS = 200;
/** Bound on the turn text shipped to the judgment backend. */
const MAX_USER_MESSAGE_CHARS = 8_000;

/**
 * Suggest at most one skill for this user turn, or `undefined`.
 * Never throws; callers may fire-and-forget the promise alongside other
 * per-turn work and await it just before the model call.
 */
export async function suggestSkill(
	turnText: string,
	skills: readonly Skill[],
	judge: Judge,
	options?: JudgeOptions,
): Promise<string | undefined> {
	try {
		const catalog = skills
			.filter(skill => skill.hide !== true)
			.slice(0, MAX_SKILLS)
			.map(skill => ({ name: skill.name, description: skill.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS) }));
		if (catalog.length === 0) return undefined;
		const optionNames = [...catalog.map(skill => skill.name), NONE_CHOICE];
		const { answers } = await judge.judge(
			{
				state: { user_message: turnText.slice(0, MAX_USER_MESSAGE_CHARS), skills: catalog },
				questions: {
					needs_skill: {
						type: "noul",
						instructions: prompt.render(skillSuggestPrompt, { kind: "noul" }),
					},
					pick: {
						type: "choice",
						instructions: prompt.render(skillSuggestPrompt, { kind: "pick", options: optionNames }),
						criteria: Object.fromEntries(optionNames.map(option => [option, null])),
					},
				},
			},
			options,
		);
		if ((answers.needs_skill.noul ?? 0) < MIN_CONFIDENCE) return undefined;
		const pick = answers.pick;
		if (pick.choice === NONE_CHOICE || (pick.confidence ?? 0) < MIN_CONFIDENCE) return undefined;
		return catalog.some(skill => skill.name === pick.choice) ? pick.choice : undefined;
	} catch (error) {
		logger.debug("skill-suggest: evaluation failed; skipping suggestion", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

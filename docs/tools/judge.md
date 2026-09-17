# judge

> Return calibrated typed judgments (noul probability, option choice, weighted score) for supplied state via the TypeSafe System One (Jev) API.

## Source
- Entry: `packages/coding-agent/src/tools/judge.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/judge.md`
- Key collaborators:
  - `packages/coding-agent/src/typesafe/client.ts` — `evaluateTypeSafe` fetch wrapper over `POST https://api.typesafe.ai/v1/systemone`; `getTypeSafeApiKey` resolves `TYPESAFE_API_KEY` through `getEnvApiKey("typesafe")`.
  - `packages/ai/src/stream.ts` — `LEGACY_ENV_KEYS` maps `typesafe` → `TYPESAFE_API_KEY`.
  - `packages/coding-agent/src/tools/index.ts` — built-in tool registration and `judge.enabled` gate.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | `unknown` | Yes | The object or text being judged; forwarded verbatim as the request `state`. |
| `questions` | `Record<string, { type: "noul" \| "choice" \| "score"; instructions: unknown; criteria?: unknown }>` | Yes | Map of question id to typed question. `noul` asks for P(yes); `choice` selects among options described in `instructions`/`criteria`; `score` asks for a weighted level. |
| `model` | `string` | No | TypeSafe model override; defaults to `jev-latest`. |

## Outputs
The tool returns a single text content block plus structured `details`.

- `content`: `[{ type: "text", text: string }]` — JSON of `{ model, answers, usage }`.
- `details`: `JudgeToolDetails`
  - `result?: TypeSafeEvaluateResult` — `model`, `answers` (keyed like `questions`), optional `usage` token counts.
  - `error?: string` — set on failure instead of `result`.

Answer fields by question type:
- `noul` → `noul: number` (P(yes) in 0..1).
- `choice` → `choice: string`, `probabilities: Record<string, number>`, `confidence`, `legend`.
- `score` → `score: number`, `confidence`.

Answers whose `type` does not match the question's declared `type` are dropped; malformed entries are skipped.

## Errors
- Missing `TYPESAFE_API_KEY` → error result: "TypeSafe is not configured. Set TYPESAFE_API_KEY to enable the judge tool."
- Non-2xx upstream response → error result carrying the HTTP status and a truncated body.
- Malformed response (missing `answers` map) → error result.
- Caller abort → `ToolAbortError` propagates (not an error result).

## Approval
`approval: "read"` — a network read; no workspace mutation. Enabled by `judge.enabled` (default `true`); the tool is `loadMode: "discoverable"`, so it mounts under `xd://judge` when the xdev transport is active.

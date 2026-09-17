Judge: calibrated typed judgments over supplied state via the session's judgment backend (`providers.judgmentProvider` — TypeSafe System One when authenticated, else the tiny/smol chat bridge).

Use for ranking, verification, routing, and extraction decisions where a calibrated answer beats free-form reasoning. NOT for generating text or reasoning — it returns judgments, not prose.

- `state`: the object or text being judged.
- `questions`: map of question id → `{ type, instructions, criteria? }`. Question types:
  - `noul` → answer carries `noul`: P(yes) in 0..1.
  - `choice` → answer carries `choice` (selected option), `probabilities` (per-option), `confidence`. `criteria` maps each option to a rubric string or null.
  - `score` → answer carries `score` (weighted level), `probabilities`, `confidence`. `criteria` is an ordered array of level descriptions.

Returns `{ api, provider, model, answers, usage }` where `answers` mirrors the `questions` keys.
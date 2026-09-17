Judge: calibrated typed judgments over supplied state via TypeSafe System One (Jev).

Use for ranking, verification, routing, and extraction decisions where a calibrated answer beats free-form reasoning. NOT for generating text or reasoning — it returns judgments, not prose.

- `state`: the object or text being judged.
- `questions`: map of question id → `{ type, instructions, criteria? }`. Question types:
  - `noul` → answer carries `noul`: P(yes) in 0..1.
  - `choice` → answer carries `choice` (selected option), `probabilities` (per-option), `confidence`, and `legend` (option labels).
  - `score` → answer carries `score` (weighted level) and `confidence`.
- `model`: optional TypeSafe model override (default `jev-latest`).

Returns `{ model, answers, usage }` where `answers` mirrors the `questions` keys. Answers whose type does not match the question are dropped. Requires `TYPESAFE_API_KEY`.

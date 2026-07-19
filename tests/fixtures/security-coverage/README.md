# Security Coverage Fixtures

Pinned snapshot fixtures used by `tests/security-coverage.test.cjs` to assert
that `scanForInjection` (gsd-ng/bin/lib/security.cjs) detects representative
attack samples and avoids flagging benign multi-language content.

Tests run fully offline against the JSONL files committed in this directory.

## Fixture entry shape

Every line in every `*.jsonl` file is a JSON object with these fields:

```
{ "id": "string (unique within file)",
  "source_dataset": "Lakera/gandalf_ignore_instructions" | "deepset/prompt-injections" | "garak/promptinject" | "hand-authored",
  "text": "string (the prompt under test)",
  "expected_label": 0 | 1,
  "attack_family": "string (e.g. direct-injection, benign, multilingual-direct-injection, homoglyph-evasion, goal-hijacking, prompt-leaking, context-reset, authority-claim, roleplay-framing)"
}
```

`expected_label` semantics:
- `0` — benign content that MUST NOT be flagged (false-positive guard)
- `1` — attack content that MUST be flagged at one of the recognised tiers

## Sources

| File | Source dataset | License | URL |
|------|----------------|---------|-----|
| `lakera-gandalf-sample.jsonl` | Lakera/gandalf_ignore_instructions | MIT | https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions |
| `deepset-injection-sample.jsonl` | deepset/prompt-injections | Apache-2.0 | https://huggingface.co/datasets/deepset/prompt-injections |
| `garak-promptinject-sample.jsonl` | NVIDIA/garak — promptinject probe | Apache-2.0 | https://github.com/NVIDIA/garak |
| `multilang-patterns.jsonl` | hand-authored | (this repo) | n/a |
| `homoglyph-patterns.jsonl` | hand-authored (added by Plan 50-02) | (this repo) | n/a |
| `gsd-prose-benign.jsonl` | hand-authored | (this repo) | n/a |

Full license texts: see [LICENSE](./LICENSE).

## `gsd-prose-benign.jsonl` — the GSD-prose false-positive corpus

Driven by `tests/security-fp-corpus.test.cjs`, not by `security-coverage.test.cjs`.

**Every entry is `expected_label: 0`.** Nothing in this file is an attack. Each entry is
GSD-shaped planning or documentation prose that *describes* detector behaviour — the kind of
text that fills a `REQUIREMENTS.md`, `ROADMAP.md`, `*-PLAN.md` or `codebase/*.md`.

**Why it exists.** The false-positive behaviour this corpus pins was measured over a workspace
`.planning/` directory: 69 files tripping the blocking tier and 11 files tripping entropy at
H = 5.52–5.61. `.planning/` is not part of this repository and does not exist in a fresh clone,
so a test living in `tests/` cannot reach it. Freezing only a walk of this repository would gate
a near-zero number while the actual finding stayed unguarded. This corpus reproduces those
patterns inside the submodule, where the suite can reach them.

**Entries were authored for this purpose, not vendored.** No workspace file is copied verbatim
and no third-party license applies.

### Additional fields

Beyond the shared schema above, entries carry:

```
{ "rule_family": "string — the rule ID this entry is written to trip (absent on non-family entries)",
  "provenance": "string — the kind of document the prose is modelled on",
  "class": "self-referential" | "entropy-marginal" | "realistic-high-entropy" | "ordinary-prose-control",
  "measured_H": "number — max windowed Shannon entropy (entropy-bearing entries only)",
  "trips_entropy": "boolean — measured outcome (realistic-high-entropy entries only)" }
```

`class` semantics (49 entries total):

| Class | Count | Meaning |
|-------|-------|---------|
| `self-referential` | 28 | Documentation describing a rule, which therefore matches that rule. Seven families × 4 entries. A tolerable FP class in a security tool's own repository. |
| `entropy-marginal` | 8 | Identifier-dense GSD prose whose entropy lands in H = 5.40–5.65, straddling the 5.5 threshold. Four trip entropy, four do not. |
| `realistic-high-entropy` | 3 | Content classes that plausibly appear in a real repository and are not inside a fenced code block: pinned action SHAs, lockfile integrity digests, a UUID table. Outcome is **measured and recorded**, never presumed. |
| `ordinary-prose-control` | 10 | Ordinary GSD prose with no security vocabulary. **Must trip zero patterns** — asserted outright, with no budget allowance. |

Measured outcome for the content classes: the base64 digest run trips entropy at H = 5.84,
while the SHA pins (H = 4.88) and the UUID table (H = 4.38) do not. Lowercase hex spans a
16-character alphabet and so cannot reach 5.5 at any length; base64 spans 64 and comfortably can.

`measured_H` is computed with the scanner's own Shannon function and windowing
(`WINDOW = 256`, `STEP = 128`, `MIN_SEGMENT = 64`), so the value is comparable to what
`scanForInjection` sees.

This file is excluded from the repository walk in `tests/security-fp-corpus.test.cjs` — like the
attack fixtures beside it, it contains rule-tripping text by design and would poison the walk
baseline.

## Refresh procedure

Fixtures are pinned snapshots. To refresh:

1. Re-export from the source dataset using its native field names.
2. Reshape each row into the schema above:
   - Lakera Gandalf: `text` → `text`, all rows `expected_label: 1`, `attack_family: "direct-injection"`.
   - deepset: `label=0` → `expected_label: 0, attack_family: "benign"`; `label=1` → `expected_label: 1, attack_family: "direct-injection"`.
   - Garak promptinject: rogue-string template → `text`; `attack_family ∈ {"goal-hijacking","prompt-leaking"}`.
3. Replace the file in this directory; re-run `npm test` from `gsd-ng/`.

`source_dataset` strings MUST match the canonical values exactly — the test
suite asserts on them.

Combined fixture size budget: under 500 KB across all `*.jsonl` files.

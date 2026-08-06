# Nyquist Evidence Tiers

> What counts as evidence that a requirement is verified, and what only looks like it.
> Read by `@~/.claude/gsd-ng/workflows/validate-phase.md`, `@~/.claude/agents/gsd-nyquist-auditor.md`,
> and by anyone authoring a row in a `VALIDATION.md` Per-Task Verification Map.

A phase is promoted when every row in its verification map is green under an admissible tier.
This file defines the three tiers and — more importantly — the line between a contract that
detects a regression and one that is a green light wired to nothing.

There are three tiers: **TIER-A** (executable automated), **TIER-M** (grep contract over
markdown), and **manual-only**. A row records its tier in the Test Type column, so a
compliance claim decomposes into `N automated / M tier-M / K manual-only` and nobody has to
take the aggregate on faith.

---

## TIER-A — executable automated

A test that runs the code under test and asserts on its observable behavior. Unit,
integration, smoke; any framework. This is the default and the strongest tier, and nothing
about it changes here.

A row is TIER-A when its Automated Command executes the implementation. `node --test
tests/roadmap.test.cjs` against `roadmap.cjs` is TIER-A. A command that greps a markdown file
is not, no matter how it is spelled.

---

## TIER-M — grep contract over markdown

Much of this codebase *is* markdown: agent prompts, workflow definitions, references,
templates. Behavior specified in those files has no runtime to exercise, so under a
TIER-A-only rule those requirements can never be verified and the phases that own them can
never be compliant. TIER-M closes that hole — narrowly, because a bad grep contract is worse
than no test at all.

**A grep contract is admissible only when all four clauses hold. Three of four is not a
pass.**

### Clause 1 — required-content assertion

`assert.match` against a pattern encoding the *behavior*, at a named anchor.

Matching a heading the template already ships does not count. The pattern must discriminate
between the pre-change file and the post-change file: if it would have passed before the work
was done, it is not evidence that the work was done.

Anchor the assertion to a region, not the whole document. "The file mentions X and also
mentions Y somewhere in 1100 lines" is the weak form; "X and Y co-occur within 600 characters"
is the claim that actually encodes the behavior.

### Clause 2 — forbidden-content assertion

`assert.doesNotMatch` against the pre-change string, the escape hatch that was removed, or the
anti-pattern the requirement bans.

A contract with only a positive arm cannot detect a regression that *adds* something. Most
regressions in prose are additions: a re-introduced escape hatch, a second code path that
contradicts the first, a helpful clarification that reverses the rule.

### Clause 3 — discrimination self-test — **load-bearing**

Run the pattern against a synthetic counterfactual it MUST reject, and assert the rejection.
Run each forbidden-content pattern against a synthetic instance of the anti-pattern it MUST
catch, and assert the catch.

**This is the clause that makes the tier real, and it is the one most likely to be skipped.**
Without it, a typo'd regex passes green forever: the contract reports success, the requirement
is recorded as verified, and nothing anywhere is being checked. A positive arm alone proves
the pattern matched *something*; only a counterfactual proves it would have failed on the
wrong file.

The in-tree precedent is `tests/docs-grep-lint.test.cjs:27-30`:

> *"Structure: synthetic-input self-tests prove the detectors catch what they claim to;
> real-doc tests assert zero violations across the linted file set. A regression in a detector
> would silently let real bugs through, so the self-tests are load-bearing."*

`tests/terminal-html-lint.test.cjs` and `tests/comment-hygiene-lint.test.cjs` are two more
instances of the same shape. Keep the counterfactuals together in one map so the self-tests
read as a block and cannot be dropped quietly, one at a time.

### Clause 4 — named, resolvable subject

The VALIDATION row names `file:anchor` — which file carries the behavior, and where in it.
Both the asserted file and the test file must resolve in `git ls-tree HEAD`.

Health check W026 enforces this. A citation that resolves only in the working directory is a
local artifact, not reproducible evidence; a test file cited for two months while unreachable
from HEAD is the defect that motivated the check.

---

## Explicitly inadmissible — the rubber-stamp list

Named so the tier cannot widen by drift:

- **`fs.existsSync(f)` alone.** A contract that asserts a file exists is worthless — it
  passes against an empty file, a file whose content was reverted, and a file that says the
  opposite of the requirement.
- **`assert.ok(content.length > 0)`**, or any assertion an empty-but-present file satisfies.
- **Matching a string the assertion itself defines**, or a heading shipped by the template.
  The template shipped it; the phase's work did not put it there.
- **Matching a filename or a path** rather than a behavior.
- **A positive arm with no negative arm** — fails clause 2.
- **Any contract without a discrimination self-test** — fails clause 3, *including one whose
  positive and negative arms both look reasonable.* Looking reasonable is not the property
  being tested.

---

## Manual-only

Genuine manual-only entries survive. They no longer poison the phase.

A phase may be promoted with manual-only entries when **each** carries a dated justification
and a named human owner, and the count is published in frontmatter as `manual_only_count: N`.

The reasoning: compliance stays honest by staying *measurable*. A phase claiming compliance
with `manual_only_count: 14` is visibly weaker than one with `0`, and no aggregate hides the
difference. The alternative — refusing to promote any phase with a manual entry — does not
produce more rigor, it produces phases that give up on the gate entirely and rows that get
relabelled until they pass.

An undated, unowned manual-only entry is not a carve-out. It is a pending row wearing a
different word, and it blocks promotion.

---

## Worked pair

Both drawn from a real row in
`.planning/phases/46-discuss-phase-gap-detection-and-checker-coverage/46-VALIDATION.md`:

```
| discuss-phase lineage depth 1 only | 03 | 2 | Phase 46 goal | manual | grep check | N/A — workflow markdown | ⬜ pending |
```

The behavior is real and lives at `gsd-ng/workflows/discuss-phase.md:483` — lineage resolution
traces direct parents only and must not recurse.

### Inadmissible

```js
test('discuss-phase covers lineage', () => {
  const p = path.join(REPO_ROOT, 'gsd-ng/workflows/discuss-phase.md');
  assert.ok(fs.existsSync(p));
  assert.match(fs.readFileSync(p, 'utf8'), /lineage/i);
});
```

Fails clause 1 (the word `lineage` appears in the file's headings regardless of the
requirement), clause 2 (no forbidden arm — a re-introduced recursive traversal passes), and
clause 3 (no counterfactual — every markdown file mentioning lineage passes). The `existsSync`
call adds nothing at all. This is green and verifies nothing.

### Admissible

```js
const DISCUSS = readDoc('gsd-ng/workflows/discuss-phase.md');
const DEPTH_ONE = /Depth 1 only[^\n]{0,80}Do NOT recursively traverse/i;
const RECURSES = /(?:recursively|transitively)[^\n]{0,60}(?:traverse|resolve)[^\n]{0,60}parent/i;

const COUNTERFACTUALS = {
  // Names lineage without bounding the traversal.
  unbounded: 'Trace the Depends on chain to surface parent phase constraints.',
  // Bounds it the wrong way.
  recursive: 'Recursively traverse each parent phase chain to full depth.',
};

test('lineage resolution is bounded to direct parents', () => {
  assert.match(DISCUSS, DEPTH_ONE, 'the depth bound must be stated, not implied');
  assert.doesNotMatch(DISCUSS, RECURSES, 'nothing may reinstate recursive traversal');
});

test('the depth patterns discriminate', () => {
  assert.doesNotMatch(COUNTERFACTUALS.unbounded, DEPTH_ONE);
  assert.match(COUNTERFACTUALS.recursive, RECURSES);
  assert.doesNotMatch(COUNTERFACTUALS.recursive, DEPTH_ONE);
});
```

Clause 1: the pattern pairs the bound with the instruction, so prose merely mentioning lineage
does not satisfy it. Clause 2: `RECURSES` catches the regression that *adds* a recursive path.
Clause 3: both counterfactuals are asserted, so a typo in either pattern turns the suite red
instead of silently green. Clause 4: the row cites
`gsd-ng/workflows/discuss-phase.md:483` and the test file, both resolvable in HEAD.

Prose rules get read once. A worked pair gets copied — that is why this section exists.

---

## What TIER-M cannot do

TIER-M verifies that a prompt, workflow or template **says** a thing. It does not verify that
an agent **behaves** that way.

Where the requirement is behavior, a TIER-M contract is a proxy, and the row should say so —
put the proxy nature in the row rather than in a reviewer's head. A workflow instructing an
orchestrator to route into validation is asserted present, anchored and gated; whether a live
run reaches the workflow is a different claim, and only an executed run establishes it.

Being explicit about the ceiling is what keeps the tier from becoming a universal solvent. The
failure mode is not authoring a bad contract on purpose; it is relabelling every awkward
behavioral requirement as TIER-M because the file that describes it can be grepped.

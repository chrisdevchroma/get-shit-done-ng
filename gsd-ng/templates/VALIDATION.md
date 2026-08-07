---
phase: {N}
slug: {phase-slug}
status: draft
nyquist_compliant: false
manual_only_count: 0
evidence_tiers: { automated: 0, tier_m: 0, manual: 0 }
wave_0_complete: false
created: {date}
---

# Phase {N} — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | {pytest 7.x / jest 29.x / vitest / go test / other} |
| **Config file** | {path or "none — Wave 0 installs"} |
| **Quick run command** | `{quick command}` |
| **Full suite command** | `{full command}` |
| **Estimated runtime** | ~{N} seconds |

---

## Sampling Rate

- **After every task commit:** Run `{quick run command}`
- **After every plan wave:** Run `{full suite command}`
- **Before `{{COMMAND_PREFIX}}verify-work`:** Full suite must be green
- **Max feedback latency:** {N} seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| {N}-01-01 | 01 | 1 | REQ-{XX} | unit | `{command}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*Test Type: `unit` · `integration` · `smoke` · `regression` · `TIER-M` · `manual` · `plan-sourced`*

*`TIER-M` is a grep contract over markdown. It is admissible evidence only when all four
clauses in `@~/.claude/gsd-ng/references/nyquist-evidence-tiers.md` hold — required arm,
forbidden arm, discrimination self-test, resolvable subject. Three of four is not a pass.*

*`File Exists` is enforced, not decorative: health check W026 resolves every cited test path
against `git ls-tree HEAD` and reports a row citing a file absent from the tree as phantom
evidence. A citation that resolves only in your working directory is not evidence anyone else
can reproduce.*

---

## Wave 0 Requirements

- [ ] `{tests/test_file.py}` — stubs for REQ-{XX}
- [ ] `{tests/conftest.py}` — shared fixtures
- [ ] `{framework install}` — if no framework detected

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Tier | Anchor | Why Manual | Owner | Dated | Test Instructions |
|----------|-------------|------|--------|------------|-------|-------|-------------------|
| {behavior} | REQ-{XX} | manual | {file:anchor} | {reason} | {name} | {YYYY-MM-DD} | {steps} |

*If none: "All phase behaviors have automated verification."*

*A carve-out records what is unverifiable and who owns verifying it. An entry with no owner
and no date is not a carve-out — it is a pending row wearing a different word, and it blocks
promotion. `manual_only_count` in frontmatter must equal the number of rows here.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < {N}s
- [ ] Every Manual-Only row has a tier, an anchor, an owner and a date
- [ ] `manual_only_count` and `evidence_tiers` match the tables above
- [ ] Compliance flag promoted by `{{COMMAND_PREFIX}}validate-phase` (never set by hand, and never by the planner)

**Approval:** {pending / approved YYYY-MM-DD}

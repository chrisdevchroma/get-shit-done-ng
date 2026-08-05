# Memory Templates

Templates seeded into `{{MEMORY_DIR}}` during project initialization based on detected workspace topology.

## Category Mapping

The ROADMAP listed three workspace categories. They map to templates as follows:

| Category | Template | Rationale |
|----------|----------|-----------|
| dev-workspace (submodule) | `multi-boundary.md` | Submodule topology has commit-boundary hazards |
| monorepo | `multi-boundary.md` | Same commit-boundary hazards as submodule |
| standalone | (none) | No structural hazards to guard against |

`multi-boundary.md` covers both submodule and monorepo categories because they share the same hazard class: committing changes at the wrong directory level. Standalone projects have no multi-boundary risk and receive no seeded memories.

## Adding Templates

Future templates should follow the frontmatter format:

```yaml
---
name: Short display name
description: One-line description (used in {{PROJECT_RULES_FILE}} Memories section)
type: feedback
---
```

Broader workspace-type-specific templates (Cargo workspace, Go workspace, Bazel) are deferred to the GSD plugin system.

# GSD-NG Configuration

This project uses [GSD-NG](https://github.com/gsd-build/gsd-ng) for spec-driven development.

<!-- ONLY:copilot -->

## Skills

GSD skills are available in the `skills/gsd-*/` directories. Use them by name (e.g., `gsd-new-project`, `gsd-plan-phase`).

## Agents

GSD agents are available in the `agents/` directory as `.agent.md` files.

## Workflows

The GSD workflow engine lives in `gsd-ng/workflows/`. Agents and skills reference these workflows automatically.

<!-- /ONLY:copilot -->
<!-- ONLY:opencode -->

## Commands

GSD commands are available as `command/gsd-*.md`. Use them by name (e.g., `/gsd-new-project`, `/gsd-plan-phase`).

## Agents

GSD agents are available as `agent/gsd-*.md`, each declaring `mode: subagent`.

## Plugin

The GSD plugin loads from `plugin/gsd-core.js`.

## Workflows

The GSD workflow engine lives in `gsd-ng/workflows/`. Agents and commands reference these workflows automatically.

<!-- /ONLY:opencode -->

## Important

- Follow the workflow system — do not skip phases or bypass planning
- Use `gsd-ng/` for all GSD engine files
- The `.planning/` directory contains project state — read but do not manually edit

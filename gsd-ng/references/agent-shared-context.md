<project_context>
Before executing, discover project context:

**Project instructions:** Read `./{{PROJECT_RULES_FILE}}` if it exists in the working directory. Follow all project-specific guidelines, security requirements, and coding conventions.

**Project skills:** Check `{{CONFIG_DIR}}/skills/` or `.agents/skills/` directory if either exists:
1. List available skills (subdirectories)
2. Read `SKILL.md` for each skill (lightweight index ~130 lines)
3. Load specific `rules/*.md` files as needed during implementation
4. Do NOT load full `{{PROJECT_RULES_FILE}}` files (100KB+ context cost)
5. Follow skill rules relevant to your current task

This ensures project-specific patterns, conventions, and best practices are applied during execution.
</project_context>

**ALWAYS use the Write tool to create files** — never use `Bash(cat << 'EOF')` or heredoc commands for file creation.

---
description: Create git commits with user approval and no Claude attribution
---

# Commit Changes

You are tasked with creating git commits for the changes made during this session.

## Process:

1. **Think about what changed:**
   - Review the conversation history and understand what was accomplished
   - Run `git status` to see current changes
   - Run `git diff` to understand the modifications
   - Consider whether changes should be one commit or multiple logical commits

2. **Plan your commit(s):**
   - Identify which files belong together
   - Draft clear, descriptive commit messages
   - Use imperative mood in commit messages
   - Focus on why the changes were made, not just what

3. **Present your plan to the user:**
   - List the files you plan to add for each commit
   - Show the commit message(s) you'll use
   - Ask: "I plan to create [N] commit(s) with these changes. Shall I proceed?"

# Backend changes
git add src/services/*.ts src/data/*.ts
git commit -m "🐛 fix: validation logic in document service"

# Frontend changes
git add src/components/*.vue
git commit -m "✨ feat: add client dashboard filters"

# Test updates
git add tests/*.test.ts
git commit -m "🧪 test: add file upload validation tests"

# Configuration/Dependencies
git add package*.json
git commit -m "📦 build: upgrade dependencies"

# Documentation
git add *.md docs/*
git commit -m "📝 docs: update API documentation"
```

**Execute upon confirmation:**
   - Use `git add` with specific files (never use `-A` or `.`)
   - Create commits with your planned messages
   - Show the result with `git log --oneline -n [number]`

## Important:
- **NEVER add co-author information or Claude attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with Claude" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them

## Remember:
- You have the full context of what was done in this session
- Group related changes together
- Keep commits focused and atomic when possible
- The user trusts your judgment - they asked you to commit

## Commit Message Guidelines
- Start with emoji prefix and type (see below)
- Keep under 50 characters for subject line
- Focus on what and why, not how
- No mentions of tools or authors

### Commit Types
| Prefix | Type | Use for |
|--------|------|---------|
| ✨ | feat | New features |
| 🐛 | fix | Bug fixes |
| 🔧 | chore | Maintenance, config, dependencies |
| ♻️ | refactor | Code restructuring (no behavior change) |
| 📦 | build | Build system, dependencies |
| 🧪 | test | Adding or updating tests |
| 📝 | docs | Documentation only |
| 🎨 | style | Code style, formatting (no logic change) |
| ⚡ | perf | Performance improvements |
| 🔒 | security | Security fixes |

### Examples
- `✨ feat: add file type validation`
- `🐛 fix: null reference in authentication`
- `♻️ refactor: simplify document service`
- `🔧 chore: update linting rules`
- `📦 build: upgrade dependencies`

## Important Notes
- Changes are committed locally only
- No automatic push to origin
- Review each commit before proceeding
- Use `git log --oneline` to verify commits

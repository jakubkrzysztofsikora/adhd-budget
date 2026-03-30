---
description: Create worktree and launch implementation session for a plan
---

1. set up worktree for implementation:
1a. create a new worktree with branch name based on feature: `git worktree add ../[feature-name] -b feature/[feature-name]`

2. determine required data:

- feature/task name
- branch name
- path to plan file (use relative path from project root)
- implementation approach

**IMPORTANT PATH USAGE:**
- Always use relative paths from the project root
- Plan files are typically in: `docs/plans/IMPL-description.md`
- This ensures paths work consistently across worktrees

3. confirm with the user by sending a message:

```
Based on the input, I plan to create a worktree with the following details:

worktree path: ../[feature-name]
branch name: feature/[feature-name]
path to plan file: docs/plans/IMPL-description.md

Next steps:
1. Create the worktree
2. Begin implementation following the plan
3. When complete and tests pass, create a commit
4. Create a PR

Does this look correct?
```

incorporate any user feedback then:

4. create the worktree and inform the user:
```
Created worktree at ../[feature-name]

To work in the new worktree:
cd ../[feature-name]

Implementation plan: docs/plans/IMPL-description.md
```

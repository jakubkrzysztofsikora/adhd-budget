---
description: Debug issues by investigating logs, database state, and git history
---

# Debug

You are tasked with helping debug issues during manual testing or implementation. This command allows you to investigate problems by examining logs, database state, and git history without editing files. Think of this as a way to bootstrap a debugging session without using the primary window's context.

## Initial Response

When invoked WITH a plan/context reference:
```
I'll help debug issues with [plan/context]. Let me understand the current state.

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages?

I'll investigate the logs, application state, and git history to help figure out what's happening.
```

When invoked WITHOUT parameters:
```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on?
- What specific problem occurred?
- When did it last work?

I can investigate logs, application state, and recent changes to help identify the issue.
```

## Environment Information

You have access to these key investigation areas:

**Logs**:
- Application logs (check project documentation for location)
- Service logs (web server, API, background jobs)
- System logs if relevant

**Application State**:
- Database queries (if applicable)
- Cache state (Redis, etc.)
- File system state

**Git State**:
- Check current branch, recent commits, uncommitted changes
- Similar to how `commit` and `describe_pr` commands work

**Service Status**:
- Check if services are running: `ps aux | grep [service-name]`
- Check Docker containers: `docker ps`
- Check port availability: `lsof -i :[port]`

## Process Steps

### Step 1: Understand the Problem

After the user describes the issue:

1. **Read any provided context** (plan or reference):
   - Understand what they're implementing/testing
   - Note which phase or step they're on
   - Identify expected vs actual behavior

2. **Quick state check**:
   - Current git branch and recent commits
   - Any uncommitted changes
   - When the issue started occurring

### Step 2: Investigate the Issue

Spawn parallel Task agents for efficient investigation:

```
Task 1 - Check Recent Logs:
Find and analyze the most recent logs for errors:
1. Identify log locations based on project structure
2. Search for errors, warnings, or issues around the problem timeframe
3. Look for stack traces or repeated errors
4. Note relevant context from logs
5. Check for service startup/shutdown messages
Return: Key errors/warnings with timestamps
```

```
Task 2 - Application State:
Check the current application state:
1. If database exists, check relevant tables/collections
2. Query recent data related to the issue
3. Look for stuck states or anomalies
4. Check cache state if applicable
5. Verify expected data exists
Return: Relevant state findings
```

```
Task 3 - Git and File State:
Understand what changed recently:
1. Check git status and current branch
2. Look at recent commits: git log --oneline -10
3. Check uncommitted changes: git diff
4. Verify expected files exist
5. Look for any file permission issues
Return: Git state and any file issues
```

### Step 3: Present Findings

Based on the investigation, present a focused debug report:

```markdown
## Debug Report

### What's Wrong
[Clear statement of the issue based on evidence]

### Evidence Found

**From Logs**:
- [Error/warning with timestamp and location]
- [Pattern or repeated issue]

**From Application State**:
- [Finding from database/cache]
- [Relevant state information]

**From Git/Files**:
- [Recent changes that might be related]
- [File state issues]

### Root Cause
[Most likely explanation based on evidence]

### Next Steps

1. **Try This First**:
   ```bash
   [Specific command or action]
   ```

2. **If That Doesn't Work**:
   - Restart services (check project documentation for commands)
   - Check browser console for client-side errors (F12)
   - Run with debug logging enabled (check project documentation)

### Can't Access?
Some issues might be outside my reach:
- Browser console errors (F12 in browser)
- External service state
- System-level issues

Would you like me to investigate something specific further?
```

## Important Notes

- **Focus on manual testing scenarios** - This is for debugging during implementation
- **Always require problem description** - Can't debug without knowing what's wrong
- **Read files completely** - No limit/offset when reading context
- **Think like `commit` or `describe_pr`** - Understand git state and changes
- **Guide back to user** - Some issues (browser console, etc.) are outside reach
- **No file editing** - Pure investigation only

## Quick Reference

**Find Latest Logs**:
```bash
# Check project documentation for log locations
# Common patterns:
ls -t logs/*.log | head -1
tail -f logs/application.log
journalctl -u [service-name] -n 100
```

**Application State**:
```bash
# For SQL databases:
sqlite3 [database-file] ".tables"
# For PostgreSQL/MySQL, use appropriate client

# For Docker containers:
docker logs [container-name] --tail 100

# For cache (Redis example):
redis-cli info
```

**Service Check**:
```bash
ps aux | grep [service-name]
docker ps
lsof -i :[port-number]
```

**Git State**:
```bash
git status
git log --oneline -10
git diff
```

Remember: This command helps you investigate without burning the primary window's context. Perfect for when you hit an issue during manual testing and need to dig into logs, application state, or git history.

#!/usr/bin/env node

const fs = require('fs');

// Read input from stdin
let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);

    // Check if this is a Bash tool use
    if (input.tool_name === 'Bash') {
      const command = input.tool_input?.command || '';
      const exitCode = input.tool_response?.exitCode;
      const stdout = input.tool_response?.stdout || '';
      const stderr = input.tool_response?.stderr || '';

      // Check if the command contains "dotnet test"
      if (command.includes('dotnet test')) {
        // Check if tests failed (non-zero exit code or output contains failure indicators)
        const testsFailed = exitCode !== 0 ||
                           stdout.includes('Failed!') ||
                           stdout.includes('Total tests:') && stdout.includes('Failed:') &&
                           !stdout.includes('Failed:     0');

        if (testsFailed) {
          // Add strong reminder about not skipping failing tests
          const output = {
            additionalContext: `
⚠️  CRITICAL REMINDER ⚠️

NEVER SKIP FAILING TESTS WITHOUT APPROVAL

Tests have failed. You must:
1. Analyze the test failures carefully
2. Fix the underlying issues causing the failures
3. Re-run the tests to verify the fixes
4. NEVER proceed to the next task while tests are failing
5. NEVER comment out or skip failing tests unless explicitly approved by the user

Test failures indicate real problems that must be addressed.
`
          };

          console.log(JSON.stringify(output));
        } else {
          // Tests passed - optional positive reinforcement
          const output = {
            additionalContext: '✓ All tests passed successfully.'
          };
          console.log(JSON.stringify(output));
        }
      }
    }

    // Exit with 0 to continue normal flow
    process.exit(0);

  } catch (error) {
    // If there's an error, log it to stderr but don't block
    console.error(`Hook error: ${error.message}`);
    process.exit(0);
  }
});

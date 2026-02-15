#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read input from stdin
let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);

    // Path to claude.md in project root
    const claudeMdPath = path.join(process.cwd(), 'claude.md');

    // Check if claude.md exists
    if (fs.existsSync(claudeMdPath)) {
      const claudeMdContent = fs.readFileSync(claudeMdPath, 'utf-8');

      // Return additional context to be injected
      const output = {
        additionalContext: `
# Project Context (from claude.md)

${claudeMdContent}

---
`
      };

      console.log(JSON.stringify(output));
    }

    // Exit with 0 to allow the prompt to proceed
    process.exit(0);

  } catch (error) {
    // If there's an error, log it to stderr but still allow the prompt
    console.error(`Hook error: ${error.message}`);
    process.exit(0);
  }
});

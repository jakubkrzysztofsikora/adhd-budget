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

    let contextInfo = [];

    // Check for running processes/tasks (example: look for common task files)
    const taskFiles = [
      '.claude/tasks.json',
      'TODO.md',
      '.github/ISSUE_TEMPLATE',
      'package.json'
    ];

    contextInfo.push('='.repeat(60));
    contextInfo.push('SESSION START - Current Project Context');
    contextInfo.push('='.repeat(60));

    // Display git status
    const { execSync } = require('child_process');
    try {
      const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
      const gitStatus = execSync('git status --short', { encoding: 'utf-8' }).trim();

      contextInfo.push('');
      contextInfo.push('Git Status:');
      contextInfo.push(`  Branch: ${gitBranch}`);
      if (gitStatus) {
        contextInfo.push(`  Modified files: ${gitStatus.split('\n').length}`);
      } else {
        contextInfo.push('  Working tree clean');
      }
    } catch (e) {
      // Not a git repo or git not available
    }

    // Display TODO information if available
    const todoMdPath = path.join(process.cwd(), 'TODO.md');
    if (fs.existsSync(todoMdPath)) {
      const todoContent = fs.readFileSync(todoMdPath, 'utf-8');
      const todoLines = todoContent.split('\n').filter(line =>
        line.trim().startsWith('- [ ]') || line.trim().startsWith('- [x]')
      );

      if (todoLines.length > 0) {
        const pending = todoLines.filter(l => l.includes('[ ]')).length;
        const completed = todoLines.filter(l => l.includes('[x]')).length;

        contextInfo.push('');
        contextInfo.push('TODO.md Tasks:');
        contextInfo.push(`  Pending: ${pending}`);
        contextInfo.push(`  Completed: ${completed}`);
      }
    }

    // Display package.json info
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      contextInfo.push('');
      contextInfo.push('Project Info:');
      contextInfo.push(`  Name: ${packageJson.name || 'N/A'}`);
      contextInfo.push(`  Version: ${packageJson.version || 'N/A'}`);

      if (packageJson.scripts) {
        const scriptCount = Object.keys(packageJson.scripts).length;
        contextInfo.push(`  Available scripts: ${scriptCount}`);
      }
    }

    // Check if claude.md exists
    const claudeMdPath = path.join(process.cwd(), 'claude.md');
    if (fs.existsSync(claudeMdPath)) {
      contextInfo.push('');
      contextInfo.push('✓ claude.md found - project context will be loaded on each prompt');
    }

    contextInfo.push('='.repeat(60));
    contextInfo.push('');

    // Print to stdout so Claude sees it
    console.log(contextInfo.join('\n'));

    // Exit with 0 to continue session start
    process.exit(0);

  } catch (error) {
    // If there's an error, log it to stderr but still allow session to start
    console.error(`Hook error: ${error.message}`);
    process.exit(0);
  }
});

#!/bin/bash
#
# Install git hooks for ADHD Budget Assistant
#

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

echo "Installing git hooks..."

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Copy pre-commit hook
if [ -f "$SCRIPTS_DIR/pre-commit.hook" ]; then
    cp "$SCRIPTS_DIR/pre-commit.hook" "$HOOKS_DIR/pre-commit"
    chmod +x "$HOOKS_DIR/pre-commit"
    echo "✓ Installed pre-commit hook"
else
    echo "✗ pre-commit.hook not found in scripts directory"
    exit 1
fi

echo ""
echo "Git hooks installed successfully!"
echo "The pre-commit hook will run tests before each commit."
echo ""
echo "To bypass the hook (NOT RECOMMENDED):"
echo "  git commit --no-verify"
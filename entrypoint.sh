#!/bin/bash
set -e

# Initialize .claude config directory for Claude Code CLI
mkdir -p "$HOME/.claude"

# Create settings that allow the Agent SDK to run headless
cat > "$HOME/.claude/settings.json" << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Skill",
      "Bash",
      "Write",
      "Read",
      "Edit"
    ],
    "deny": []
  }
}
SETTINGS

# Ensure project .claude/skills directory exists
mkdir -p /app/.claude/skills

echo "Claude Code config initialized at $HOME/.claude"

exec node dist/index.js

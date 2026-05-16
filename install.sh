#!/bin/bash
# ============================================================
# claude-code-mcp — installer
# Clones the repo, builds, and registers the MCP bridge.
# Usage: curl -fsSL https://raw.githubusercontent.com/juliantang/claude-code-mcp/main/install.sh | bash
# ============================================================

set -e

INSTALL_DIR="$HOME/Projects/claude-code-mcp"
REPO_URL="https://github.com/juliantang/claude-code-mcp.git"
CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

echo ""
echo "=== Claude Code MCP Bridge Installer ==="
echo ""

# ── Check dependencies ────────────────────────────────────

if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Install from https://nodejs.org and re-run."
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "ERROR: npm not found. Install from https://nodejs.org and re-run."
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "ERROR: Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code and re-run."
  exit 1
fi

echo "✓ Node $(node --version), npm $(npm --version), claude found"

# ── Clone or update repo ──────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "✓ Repo already exists at $INSTALL_DIR — pulling latest..."
  cd "$INSTALL_DIR" && git pull
else
  echo "Cloning repo to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── Install and build ─────────────────────────────────────

echo "Installing dependencies..."
npm install --silent

echo "Building..."
npm run build

echo "✓ Build complete"

# ── Register in claude_desktop_config.json ────────────────

python3 - << PYEOF
import json, os

config_path = os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")

if not os.path.exists(config_path):
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    config = {}
else:
    with open(config_path) as f:
        try:
            config = json.load(f)
        except json.JSONDecodeError:
            import shutil
            shutil.copy(config_path, config_path + ".bak")
            config = {}

config.setdefault("mcpServers", {})["claude-code-bridge"] = {
    "command": "node",
    "args": [os.path.expanduser("~/Projects/claude-code-mcp/dist/index.js")]
}

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

print("✓ Registered in claude_desktop_config.json")
PYEOF

# ── Done ──────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Installation complete."
echo ""
echo "  Restart Cowork (or Claude Desktop) to"
echo "  activate the MCP bridge."
echo ""
echo "  Tools available after restart:"
echo "    claude_run_task"
echo "    claude_get_task_status"
echo "    claude_list_tasks"
echo "    claude_cancel_task"
echo "    claude_list_projects"
echo "============================================"
echo ""

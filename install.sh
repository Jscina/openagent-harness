#!/usr/bin/env bash
set -e

REPO="Jscina/openagent-harness"
INSTALL_DIR="$HOME/.openagent-harness"

echo "🚀 Installing openagent-harness..."

for cmd in bun jq curl tar; do
	if ! command -v "$cmd" &>/dev/null; then
		echo "❌ Error: $cmd is required but not installed."
		exit 1
	fi
done

echo "📦 Fetching latest release from $REPO..."
RELEASE_JSON=$(curl -s "https://api.github.com/repos/$REPO/releases/latest")
LATEST_TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name // empty')

if [ -z "$LATEST_TAG" ]; then
	echo "❌ Could not determine latest release tag."
	echo "Please ensure you have created a GitHub Release with pre-built artifacts."
	exit 1
fi

echo "🏷️  Found release: $LATEST_TAG"

# Start fresh by wiping old installations (the native binary is no longer needed)
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

ASSET_NAME="openagent-harness-plugin.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET_NAME"

echo "📥 Downloading plugin bundle: $ASSET_NAME..."
HTTP_CODE=$(curl -sL -w "%{http_code}" -o "$INSTALL_DIR/plugin.tar.gz" "$DOWNLOAD_URL")

if [ "$HTTP_CODE" != "200" ]; then
	echo "❌ Failed to download plugin (HTTP $HTTP_CODE): $DOWNLOAD_URL"
	exit 1
fi

tar -xzf "$INSTALL_DIR/plugin.tar.gz" -C "$INSTALL_DIR"
rm "$INSTALL_DIR/plugin.tar.gz"

echo "📦 Installing plugin dependencies..."
(cd "$INSTALL_DIR" && bun install)

echo "🔌 Registering plugin..."
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_PATH="$INSTALL_DIR/harness.ts"

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_FILE" ]; then
	echo "{}" >"$CONFIG_FILE"
fi

OLD_PLUGIN_PATH="$INSTALL_DIR/plugin/harness.ts"
tmp_file=$(mktemp)
jq --arg path "$PLUGIN_PATH" --arg old_path "$OLD_PLUGIN_PATH" '
	.plugin = ((.plugin // []) | if type == "array" then (map(select(. != $old_path)) | if index($path) == null then . + [$path] else . end) else [., $path] end) |
	.agent.build.disable = true |
	.agent.plan.disable = true |
	.agent.explorer.fallback_models = ["ollama/qwen3-coder", "anthropic/claude-haiku-4-5"] |
	."agent"."builder-junior".fallback_models = ["ollama/qwen3-coder", "anthropic/claude-haiku-4-5"] |
	.mcp.websearch = {"type": "remote", "url": "https://mcp.exa.ai/mcp"} |
	.mcp.context7 = {"type": "remote", "url": "https://mcp.context7.com/mcp"} |
	.mcp.grep_app = {"type": "remote", "url": "https://mcp.grep.app"}
' "$CONFIG_FILE" >"$tmp_file"
mv "$tmp_file" "$CONFIG_FILE"

# Clean up old binary if it was installed by the old harness
OLD_BIN="$HOME/.local/bin/openagent-harness"
if [ -f "$OLD_BIN" ]; then
	rm "$OLD_BIN"
	echo "🗑️  Removed legacy native binary: $OLD_BIN"
fi

echo ""
echo "============================================================"
echo "🎉 Installation complete!"
echo "✅ Plugin installed to $INSTALL_DIR"
echo "✅ Plugin registered in $CONFIG_FILE"
echo "✅ Agents will be installed automatically on first run"
echo "============================================================"

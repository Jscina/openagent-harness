#!/usr/bin/env bash
set -e

REPO="Jscina/openagent-harness"
INSTALL_DIR="$HOME/.openagent-harness"
BIN_DIR="$HOME/.local/bin"

echo "🚀 Installing openagent-harness..."

for cmd in bun jq curl tar; do
	if ! command -v "$cmd" &>/dev/null; then
		echo "❌ Error: $cmd is required but not installed."
		exit 1
	fi
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
if [ "$OS" = "linux" ]; then
	if [ "$ARCH" = "x86_64" ]; then
		TARGET="x86_64-unknown-linux-gnu"
	elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
		TARGET="aarch64-unknown-linux-gnu"
	else
		echo "❌ Unsupported architecture: $ARCH"
		exit 1
	fi
elif [ "$OS" = "darwin" ]; then
	if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
		TARGET="aarch64-apple-darwin"
	else
		TARGET="x86_64-apple-darwin"
	fi
else
	echo "❌ Unsupported OS: $OS"
	exit 1
fi

mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

echo "📦 Fetching latest release from $REPO..."
RELEASE_JSON=$(curl -s "https://api.github.com/repos/$REPO/releases/latest")
LATEST_TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name // empty')

if [ -z "$LATEST_TAG" ]; then
	echo "❌ Could not determine latest release tag."
	echo "Please ensure you have created a GitHub Release with pre-built artifacts."
	exit 1
fi

echo "🏷️  Found release: $LATEST_TAG"

echo "📥 Downloading source..."
curl -sL "https://github.com/$REPO/archive/refs/tags/$LATEST_TAG.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1

ASSET_NAME="openagent-harness-$TARGET.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET_NAME"

echo "📥 Downloading binary: $ASSET_NAME..."
HTTP_CODE=$(curl -sL -w "%{http_code}" -o "$INSTALL_DIR/bin.tar.gz" "$DOWNLOAD_URL")

if [ "$HTTP_CODE" != "200" ]; then
	echo "❌ Failed to download binary (HTTP $HTTP_CODE): $DOWNLOAD_URL"
	exit 1
fi

tar -xzf "$INSTALL_DIR/bin.tar.gz" -C "$INSTALL_DIR"
rm "$INSTALL_DIR/bin.tar.gz"

mv "$INSTALL_DIR/openagent-harness" "$BIN_DIR/openagent-harness"
chmod +x "$BIN_DIR/openagent-harness"

echo "⚙️  Installing OpenCode agents..."
"$BIN_DIR/openagent-harness" install

echo "📦 Installing plugin dependencies..."
(cd "$INSTALL_DIR/plugin" && bun install)

echo "🔌 Registering plugin..."
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_PATH="$INSTALL_DIR/plugin/harness.ts"

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_FILE" ]; then
	echo "{}" >"$CONFIG_FILE"
fi

tmp_file=$(mktemp)
jq --arg path "$PLUGIN_PATH" '
	.plugin = ((.plugin // []) | if type == "array" then (if index($path) == null then . + [$path] else . end) else [., $path] end) |
	.agent.build.disable = true |
	.agent.plan.disable = true |
	.agent.explorer.fallback_models = ["ollama/qwen3-coder", "anthropic/claude-haiku-4-5"] |
	."agent"."builder-junior".fallback_models = ["ollama/qwen3-coder", "anthropic/claude-haiku-4-5"] |
	.mcp.websearch = {"type": "remote", "url": "https://mcp.exa.ai/mcp"} |
	.mcp.context7 = {"type": "remote", "url": "https://mcp.context7.com/mcp"} |
	.mcp.grep_app = {"type": "remote", "url": "https://mcp.grep.app"}
' "$CONFIG_FILE" >"$tmp_file"
mv "$tmp_file" "$CONFIG_FILE"

echo ""
echo "============================================================"
echo "🎉 Installation complete!"
echo "✅ Agents installed to $HOME/.config/opencode/agents/"
echo "✅ Plugin registered in $CONFIG_FILE"
echo "✅ Binary installed to $BIN_DIR/openagent-harness"
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
	echo "⚠️  WARNING: $BIN_DIR is not in your PATH."
	echo "Please add the following to your shell profile (.bashrc, .zshrc, etc.):"
	echo ""
	echo "export PATH=\"$BIN_DIR:\$PATH\""
	echo ""
fi
echo "You can now run 'openagent-harness' from anywhere!"
echo "============================================================"

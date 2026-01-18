#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Scraping Controller - Native Host Installer${NC}"
echo "============================================"
echo

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.webcrawlerapi.scraper"

# Check if extension ID is provided
if [ -z "$1" ]; then
    echo -e "${YELLOW}Usage: ./install.sh <extension-id>${NC}"
    echo
    echo "To find your extension ID:"
    echo "  1. Go to chrome://extensions/"
    echo "  2. Enable 'Developer mode'"
    echo "  3. Find 'Scraping Controller'"
    echo "  4. Copy the ID (32 character string)"
    echo
    exit 1
fi

EXTENSION_ID="$1"
echo "Extension ID: $EXTENSION_ID"

# Check Node.js is installed
echo
echo -e "${YELLOW}Checking Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi
echo "Node.js version: $(node --version)"

# Install dependencies
echo
echo -e "${YELLOW}Installing dependencies...${NC}"
cd "$SCRIPT_DIR"
pnpm install --silent

# Make the script executable
chmod +x index.js

# Get full path to node and script
NODE_PATH=$(which node)
SCRIPT_PATH="$SCRIPT_DIR/index.js"

# Create a wrapper script that Chrome can execute
WRAPPER_PATH="$SCRIPT_DIR/scraper-native-host"
cat > "$WRAPPER_PATH" << EOF
#!/bin/bash
exec "$NODE_PATH" "$SCRIPT_PATH"
EOF
chmod +x "$WRAPPER_PATH"

echo -e "${GREEN}Created wrapper: $WRAPPER_PATH${NC}"

# Create the manifest
echo
echo -e "${YELLOW}Creating native messaging manifest...${NC}"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "HTTP server bridge for Scraping Controller extension",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

# Determine the correct manifest location based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_MANIFEST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    BRAVE_MANIFEST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    CHROME_MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_MANIFEST_DIR="$HOME/.config/chromium/NativeMessagingHosts"
    BRAVE_MANIFEST_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
else
    echo -e "${RED}Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

# Install for Chrome
if [ -d "$(dirname "$CHROME_MANIFEST_DIR")" ] || [[ "$OSTYPE" == "darwin"* ]]; then
    mkdir -p "$CHROME_MANIFEST_DIR"
    echo "$MANIFEST_CONTENT" > "$CHROME_MANIFEST_DIR/$HOST_NAME.json"
    echo -e "${GREEN}Installed for Chrome: $CHROME_MANIFEST_DIR/$HOST_NAME.json${NC}"
fi

# Install for Chromium
if [ -d "$(dirname "$CHROMIUM_MANIFEST_DIR")" ]; then
    mkdir -p "$CHROMIUM_MANIFEST_DIR"
    echo "$MANIFEST_CONTENT" > "$CHROMIUM_MANIFEST_DIR/$HOST_NAME.json"
    echo -e "${GREEN}Installed for Chromium: $CHROMIUM_MANIFEST_DIR/$HOST_NAME.json${NC}"
fi

# Install for Brave
if [ -d "$(dirname "$BRAVE_MANIFEST_DIR")" ] || [[ "$OSTYPE" == "darwin"* ]]; then
    mkdir -p "$BRAVE_MANIFEST_DIR"
    echo "$MANIFEST_CONTENT" > "$BRAVE_MANIFEST_DIR/$HOST_NAME.json"
    echo -e "${GREEN}Installed for Brave: $BRAVE_MANIFEST_DIR/$HOST_NAME.json${NC}"
fi

echo
echo -e "${GREEN}Installation complete!${NC}"
echo
echo "Next steps:"
echo "  1. Reload the extension in chrome://extensions/"
echo "  2. Click 'Connect' in the extension popup"
echo "  3. Check logs: tail -f /tmp/scraper-native-host.log"
echo
echo "To uninstall, run: ./uninstall.sh"

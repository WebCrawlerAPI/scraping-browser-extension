#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Scraping Controller - Native Host Uninstaller${NC}"
echo "=============================================="
echo

HOST_NAME="com.webcrawlerapi.scraper"

# Determine manifest locations based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
    CHROMIUM_MANIFEST="$HOME/Library/Application Support/Chromium/NativeMessagingHosts/$HOST_NAME.json"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    CHROME_MANIFEST="$HOME/.config/google-chrome/NativeMessagingHosts/$HOST_NAME.json"
    CHROMIUM_MANIFEST="$HOME/.config/chromium/NativeMessagingHosts/$HOST_NAME.json"
else
    echo -e "${RED}Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

# Remove Chrome manifest
if [ -f "$CHROME_MANIFEST" ]; then
    rm "$CHROME_MANIFEST"
    echo -e "${GREEN}Removed Chrome manifest${NC}"
fi

# Remove Chromium manifest
if [ -f "$CHROMIUM_MANIFEST" ]; then
    rm "$CHROMIUM_MANIFEST"
    echo -e "${GREEN}Removed Chromium manifest${NC}"
fi

# Remove binary
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scraper-native-host" ]; then
    rm "$SCRIPT_DIR/scraper-native-host"
    echo -e "${GREEN}Removed native host binary${NC}"
fi

# Remove log file
if [ -f "/tmp/scraper-native-host.log" ]; then
    rm "/tmp/scraper-native-host.log"
    echo -e "${GREEN}Removed log file${NC}"
fi

echo
echo -e "${GREEN}Uninstall complete!${NC}"

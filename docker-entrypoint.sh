#!/bin/sh
set -e

CONFIG=/app/config.js

# If a config file is mounted, use it directly
if [ -f "$CONFIG" ]; then
  exec node dist/index.js "$CONFIG"
fi

# Otherwise require at minimum IONSYNC_PASSWORD
if [ -z "$IONSYNC_PASSWORD" ]; then
  echo ""
  echo "ERROR: No config file found at $CONFIG and IONSYNC_PASSWORD is not set."
  echo ""
  echo "Either:"
  echo "  1. Set the IONSYNC_PASSWORD environment variable (see docker-compose.yml)"
  echo "  2. Mount a config.js file: -v ./config.js:/app/config.js:ro"
  echo ""
  exit 1
fi

# Generate config.js from environment variables.
# Single-quoted heredoc — shell variables are NOT expanded here;
# the resulting file reads process.env.* at Node.js runtime instead.
cat > "$CONFIG" << 'JS'
export default {
  password: process.env.IONSYNC_PASSWORD,
  port:     Number(process.env.IONSYNC_PORT     ?? 3000),
  host:     process.env.IONSYNC_HOST            ?? "0.0.0.0",
  appDir:   "/app",
  dataDir:  "/data",
  cleanup: {
    intervalSecs:         Number(process.env.IONSYNC_CLEANUP_INTERVAL   ?? 3600),
    versionsPerFile:      Number(process.env.IONSYNC_VERSIONS_PER_FILE  ?? 5),
    keepDeletedFilesSecs: Number(process.env.IONSYNC_KEEP_DELETED_SECS  ?? 604800),
  },
  logs: { level: Number(process.env.IONSYNC_LOG_LEVEL ?? 3) },
};
JS

exec node dist/index.js "$CONFIG"

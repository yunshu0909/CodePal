#!/bin/bash
# Run one TTS job under launchd, then remove the submitted launchd job label.
LABEL="$1"
PYBIN="$2"
SCRIPT="$3"
VOICEFILE="$4"

"$PYBIN" "$SCRIPT" --file "$VOICEFILE"
launchctl remove "$LABEL" >/dev/null 2>&1 || true

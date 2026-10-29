#!/bin/sh
# ccswitchboard: Claude Code statusLine command that keeps the subscription
# limits for the pinned message.
#   IN:  the status line JSON on stdin (Claude Code sends it on every update).
#   OUT: ~/.local/state/ccswitchboard/statusline.json, 0600, replaced
#        atomically: {"ts": <epoch s>, "rate_limits": {...}} — only when the
#        payload has rate_limits (subscribers, after the first API response).
#        usage-poll.ts turns it into usage.json for the pin.
#   INV: no credentials are read and nothing is sent anywhere; the numbers
#        are the ones Claude Code itself shows.
#   INV: whatever status line ran before keeps working: the payload goes on
#        to the command in CCSB_STATUSLINE_NEXT, or to Orca's own status line
#        hook when it is installed, and its output is what Claude Code prints.
#        (Orca leaves a status line it did not write alone.)
# Install: "statusLine": {"type": "command",
#          "command": "/bin/sh $HOME/opt/ccswitchboard/usage/statusline.sh"}

payload=$(cat)
dir="${CCSB_USAGE_DIR:-$HOME/.local/state/ccswitchboard}"

case "$payload" in
  *'"rate_limits"'*)
    if command -v jq >/dev/null 2>&1; then
      (
        umask 077
        mkdir -p "$dir" 2>/dev/null
        tmp="$dir/statusline.json.tmp-$$"
        if printf '%s' "$payload" | jq -c --argjson ts "$(date +%s)" \
             'select(.rate_limits | type == "object") | {ts: $ts, rate_limits: .rate_limits}' >"$tmp" 2>/dev/null \
           && [ -s "$tmp" ]; then
          mv -f "$tmp" "$dir/statusline.json"
        else
          rm -f "$tmp"
        fi
      ) 2>/dev/null
    fi
    ;;
esac

next="${CCSB_STATUSLINE_NEXT-}"
if [ -z "$next" ] && [ -f "$HOME/.orca/agent-hooks/claude-statusline.sh" ] && [ -x "$HOME/.orca/agent-hooks/claude-statusline.sh" ]; then
  next="/bin/sh $HOME/.orca/agent-hooks/claude-statusline.sh"
fi
if [ -n "$next" ]; then
  printf '%s' "$payload" | sh -c "$next"
fi
exit 0

#!/bin/bash
# A stand-in for the Herdr CLI. It answers in Herdr's response shape and records every call, so
# tests drive dispatch, interruption, and reconciliation through the real external interface.
set -u
dir="$HERDR_FAKE_DIR"
printf '%s\n' "$(printf '%s ' "$@" | tr '\n' ' ')" >> "$dir/calls.log"

group="${1:-}"
sub="${2:-}"
key="$group-$sub"
shift 2 || true

if [ -f "$dir/$key.garbage" ]; then
  echo "herdr: the answer was lost"
  exit 1
fi
if [ -f "$dir/$key.error" ]; then
  code=$(cat "$dir/$key.error")
  printf '{"id":"cli:%s:%s","error":{"code":"%s","message":"the fake refused"}}\n' "$group" "$sub" "$code"
  exit 0
fi

value_of() {
  local wanted="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$wanted" ]; then
      printf '%s' "${2:-}"
      return
    fi
    shift
  done
}

case "$key" in
  worktree-create)
    repo=$(value_of --cwd "$@")
    path=$(value_of --path "$@")
    branch=$(value_of --branch "$@")
    base=$(value_of --base "$@")
    git -C "$repo" worktree add -b "$branch" "$path" "$base" >/dev/null 2>&1 || exit 7
    printf '%s\n' "$path" >> "$dir/worktrees"
    if [ -f "$dir/block-brief" ]; then
      mkdir -p "$path/.operator/local/brief.md"
    fi
    printf '{"id":"cli:worktree:create","result":{"type":"worktree_created","workspace":{"workspace_id":"w1"},"worktree":{"path":"%s","branch":"%s","is_linked_worktree":true}}}\n' "$path" "$branch"
    ;;
  worktree-list)
    entries=""
    if [ -f "$dir/worktrees" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        entries="$entries,{\"path\":\"$line\",\"is_linked_worktree\":true,\"open_workspace_id\":\"w1\"}"
      done < "$dir/worktrees"
    fi
    printf '{"id":"cli:worktree:list","result":{"type":"worktree_list","worktrees":[%s]}}\n' "${entries#,}"
    ;;
  pane-list)
    printf '{"id":"cli:pane:list","result":{"type":"pane_list","panes":[{"pane_id":"w1:p1","workspace_id":"w1"}]}}\n'
    ;;
  agent-start)
    name="${1:-}"
    printf '%s' "$name" > "$dir/agent-live"
    printf '{"id":"cli:agent:start","result":{"type":"agent_started","argv":[],"agent":{"name":"%s","pane_id":"w1:p1","agent_status":"idle","cwd":"%s"}}}\n' "$name" "$(cat "$dir/worktrees" 2>/dev/null | tail -1)"
    ;;
  agent-prompt)
    name="${1:-}"
    printf '%s\n' "${2:-}" > "$dir/last-prompt"
    printf '{"id":"cli:agent:prompt","result":{"type":"agent_prompted","agent":{"name":"%s","pane_id":"w1:p1","agent_status":"working"}}}\n' "$name"
    ;;
  agent-get)
    name="${1:-}"
    if [ -f "$dir/agent-live" ]; then
      printf '{"id":"cli:agent:get","result":{"type":"agent_info","agent":{"name":"%s","pane_id":"w1:p1","agent_status":"working"}}}\n' "$name"
    else
      printf '{"id":"cli:agent:get","error":{"code":"agent_not_found","message":"agent target %s not found"}}\n' "$name"
    fi
    ;;
  *)
    printf '{"id":"cli:%s:%s","error":{"code":"unsupported_method","message":"the fake does not answer %s"}}\n' "$group" "$sub" "$key"
    ;;
esac

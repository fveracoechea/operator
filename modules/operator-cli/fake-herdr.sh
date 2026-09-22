#!/bin/bash
# A stand-in for the Herdr CLI. It answers in Herdr's response shape and records every call, so
# tests drive dispatch, interruption, reconciliation, and cleanup through the real external
# interface. One file under `agents/` marks each live agent, so a test stops one and keeps another.
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
# `<key>.kill` ends the caller before the effect happens, which is the interruption a crashed
# Operator leaves behind: an intent recorded, and nothing done.
if [ -f "$dir/$key.kill" ]; then
  kill -9 "$PPID" 2>/dev/null
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

refuse() {
  printf '{"id":"cli:%s:%s","error":{"code":"%s","message":"%s"}}\n' "$group" "$sub" "$1" "$2"
  exit 0
}

# Every worktree row is `workspace|path|repo|branch`, so one workspace names exactly one checkout.
worktree_row() {
  [ -f "$dir/worktrees" ] || return 1
  grep "^$1|" "$dir/worktrees" | tail -1
}

# `<key>.lost` performs the effect and then loses the answer, which is how an uncertain
# external operation reaches the caller with its effect already landed.
answer() {
  case "$key" in
  worktree-create)
    repo=$(value_of --cwd "$@")
    path=$(value_of --path "$@")
    branch=$(value_of --branch "$@")
    base=$(value_of --base "$@")
    git -C "$repo" worktree add -b "$branch" "$path" "$base" >/dev/null 2>&1 || exit 7
    count=$(( $(cat "$dir/next-workspace" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$count" > "$dir/next-workspace"
    workspace="w$count"
    printf '%s|%s|%s|%s\n' "$workspace" "$path" "$repo" "$branch" >> "$dir/worktrees"
    if [ -f "$dir/block-brief" ]; then
      mkdir -p "$path/.operator/local/brief.md"
    fi
    printf '{"id":"cli:worktree:create","result":{"type":"worktree_created","workspace":{"workspace_id":"%s"},"worktree":{"path":"%s","branch":"%s","is_linked_worktree":true}}}\n' "$workspace" "$path" "$branch"
    ;;
  worktree-list)
    entries=""
    if [ -f "$dir/worktrees" ]; then
      while IFS='|' read -r workspace path repo branch; do
        [ -n "$path" ] || continue
        # A real Herdr record can omit a handle, such as a worktree whose workspace is closed.
        if [ -f "$dir/worktree-handles-missing" ]; then
          entries="$entries,{\"path\":\"$path\",\"branch\":null,\"is_linked_worktree\":true,\"open_workspace_id\":null}"
        else
          entries="$entries,{\"path\":\"$path\",\"branch\":\"$branch\",\"is_linked_worktree\":true,\"open_workspace_id\":\"$workspace\"}"
        fi
      done < "$dir/worktrees"
    fi
    printf '{"id":"cli:worktree:list","result":{"type":"worktree_list","worktrees":[%s]}}\n' "${entries#,}"
    ;;
  worktree-remove)
    workspace=$(value_of --workspace "$@")
    row=$(worktree_row "$workspace") || refuse "workspace_not_found" "no workspace $workspace"
    [ -n "$row" ] || refuse "workspace_not_found" "no workspace $workspace"
    path=$(printf '%s' "$row" | cut -d'|' -f2)
    repo=$(printf '%s' "$row" | cut -d'|' -f3)
    # `pretend-removed` answers success while the checkout stays, which is what a caller that
    # trusts a success answer instead of reading Herdr back would accept as done.
    if [ -f "$dir/pretend-removed" ]; then
      printf '{"id":"cli:worktree:remove","result":{"type":"worktree_removed","path":"%s"}}\n' "$path"
      exit 0
    fi
    # Herdr refuses an unsafe removal instead of forcing it, and so does the fake.
    git -C "$repo" worktree remove "$path" >/dev/null 2>&1 ||
      refuse "worktree_not_removable" "the checkout at $path is not safe to remove"
    grep -v "^$workspace|" "$dir/worktrees" > "$dir/worktrees.next" || true
    mv "$dir/worktrees.next" "$dir/worktrees"
    printf '{"id":"cli:worktree:remove","result":{"type":"worktree_removed","path":"%s"}}\n' "$path"
    ;;
  pane-list)
    workspace=$(value_of --workspace "$@")
    printf '{"id":"cli:pane:list","result":{"type":"pane_list","panes":[{"pane_id":"%s:p1","workspace_id":"%s"}]}}\n' "$workspace" "$workspace"
    ;;
  pane-process-info)
    pane=$(value_of --pane "$@")
    entries=""
    if [ -f "$dir/pane-processes" ]; then
      while IFS='|' read -r pid name cmdline; do
        [ -n "$pid" ] || continue
        entries="$entries,{\"pid\":$pid,\"name\":\"$name\",\"argv0\":\"$name\",\"cmdline\":\"$cmdline\"}"
      done < "$dir/pane-processes"
    fi
    printf '{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"%s","shell_pid":100,"foreground_process_group_id":100,"foreground_processes":[%s]}}}\n' "$pane" "${entries#,}"
    ;;
  agent-start)
    name="${1:-}"
    pane=$(value_of --pane "$@")
    mkdir -p "$dir/agents"
    printf '%s' "$pane" > "$dir/agents/$name"
    printf '{"id":"cli:agent:start","result":{"type":"agent_started","argv":[],"agent":{"name":"%s","pane_id":"%s","agent_status":"idle","cwd":""}}}\n' "$name" "$pane"
    ;;
  agent-prompt)
    name="${1:-}"
    printf '%s\n' "${2:-}" > "$dir/last-prompt"
    printf '{"id":"cli:agent:prompt","result":{"type":"agent_prompted","agent":{"name":"%s","pane_id":"w1:p1","agent_status":"working"}}}\n' "$name"
    ;;
  agent-get)
    name="${1:-}"
    if [ -f "$dir/agents/$name" ]; then
      printf '{"id":"cli:agent:get","result":{"type":"agent_info","agent":{"name":"%s","pane_id":"%s","agent_status":"working"}}}\n' "$name" "$(cat "$dir/agents/$name")"
    else
      printf '{"id":"cli:agent:get","error":{"code":"agent_not_found","message":"agent target %s not found"}}\n' "$name"
    fi
    ;;
  agent-list)
    entries=""
    if [ -d "$dir/agents" ]; then
      for marker in "$dir/agents"/*; do
        [ -f "$marker" ] || continue
        entries="$entries,{\"name\":\"$(basename "$marker")\",\"pane_id\":\"$(cat "$marker")\",\"agent_status\":\"idle\"}"
      done
    fi
    printf '{"id":"cli:agent:list","result":{"type":"agent_list","agents":[%s]}}\n' "${entries#,}"
    ;;
  agent-send-keys)
    name="${1:-}"
    if [ ! -f "$dir/agents/$name" ]; then
      refuse "agent_not_found" "agent target $name not found"
    fi
    if [ ! -f "$dir/agent-stop-refused" ]; then
      rm -f "$dir/agents/$name"
      [ -f "$dir/keep-processes" ] || rm -f "$dir/pane-processes"
    fi
    printf '{"id":"cli:agent:send_keys","result":{"type":"keys_sent","agent":{"name":"%s","pane_id":"w1:p1","agent_status":"idle"}}}\n' "$name"
    ;;
  *)
    printf '{"id":"cli:%s:%s","error":{"code":"unsupported_method","message":"the fake does not answer %s"}}\n' "$group" "$sub" "$key"
    ;;
  esac
}

response=$(answer "$@")
status=$?
[ "$status" -eq 0 ] || exit "$status"

if [ -f "$dir/$key.lost" ]; then
  echo "herdr: the answer was lost"
  exit 1
fi

printf '%s\n' "$response"

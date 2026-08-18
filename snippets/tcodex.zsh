# Open Codex in a tmux window for a path or remembered project name.
# Window 0 is a persistent launcher shell named "codex-central".
tcodex() {
  local target_dir
  local window_name
  local tmux_session="${TCODEX_SESSION_NAME:-codex}"
  local central_name="${TCODEX_CENTRAL_NAME:-codex-central}"
  local codex_command="${TCODEX_COMMAND:-codex}"
  local helper_id
  local zero_id
  local new_window_id
  local query="${*:-$PWD}"
  local -a candidates
  local -a helper_ids
  local -a project_roots
  local root

  if [[ -n "$TCODEX_PROJECT_ROOTS" ]]; then
    project_roots=("${(@s/:/)TCODEX_PROJECT_ROOTS}")
  else
    project_roots=("$HOME/projects" "$HOME/workspace")
  fi

  if [[ -d "$query" ]]; then
    target_dir="${query:A}"
  elif [[ "$query" != */* ]]; then
    for root in "${project_roots[@]}"; do
      candidates+=(
        "$root/$query"(N/)
        "$root"/*/"$query"(N/)
      )
    done

    if (( ${#candidates} == 1 )); then
      target_dir="${candidates[1]:A}"
    elif (( ${#candidates} > 1 )); then
      print -u2 "tcodex: multiple directories match: $query"
      printf '  %s\n' "${candidates[@]}" >&2
      return 1
    fi
  fi

  if [[ -z "$target_dir" ]] && command -v zoxide >/dev/null 2>&1; then
    target_dir="$(zoxide query -- "$@" 2>/dev/null)"
  fi

  if [[ -z "$target_dir" || ! -d "$target_dir" ]]; then
    print -u2 "tcodex: directory not found: $query"
    return 1
  fi

  window_name="${target_dir:t}"

  if [[ -n "$TMUX" ]]; then
    tmux_session="$(tmux display-message -p '#S')" || return 1
  elif ! tmux has-session -t "=$tmux_session" 2>/dev/null; then
    tmux new-session -d -s "$tmux_session" -n "$central_name" -c "$PWD" || return 1
  fi

  helper_ids=("${(@f)$(tmux list-windows -t "=$tmux_session" \
    -f "#{==:#{window_name},$central_name}" -F '#{window_id}')}" )
  helper_id="${helper_ids[1]}"

  if [[ -z "$helper_id" ]]; then
    helper_id="$(tmux new-window -d -P -F '#{window_id}' \
      -t "$tmux_session:" -n "$central_name" -c "$PWD")" || return 1
  fi

  tmux rename-window -t "$helper_id" "$central_name"
  tmux set-window-option -t "$helper_id" automatic-rename off

  zero_id="$(tmux list-windows -t "=$tmux_session" \
    -f '#{==:#{window_index},0}' -F '#{window_id}')"

  if [[ "$helper_id" != "$zero_id" ]]; then
    if [[ -n "$zero_id" ]]; then
      tmux swap-window -d -s "$helper_id" -t "$zero_id" || return 1
    else
      tmux move-window -d -s "$helper_id" -t "$tmux_session:0" || return 1
    fi
  fi

  new_window_id="$(tmux new-window -d -P -F '#{window_id}' \
    -t "$tmux_session:" -c "$target_dir" -n "$window_name")" || return 1
  tmux send-keys -t "$new_window_id" -l "$codex_command" || return 1
  tmux send-keys -t "$new_window_id" Enter || return 1
  tmux select-window -t "$new_window_id" || return 1

  if [[ -z "$TMUX" ]]; then
    tmux attach-session -t "=$tmux_session"
  fi
}

#!/bin/zsh
# setup-env.sh — Add CC_CONNECT_CONFIG_PATH to shell profiles
# Usage:
#   ./setup-env.sh              # preview what would be added
#   ./setup-env.sh --apply      # actually write to profiles
#   ./setup-env.sh --unset      # remove from profiles

CONFIG_PATH="${HOME}/.cc-connect/config.toml"
WORK_DIR="${HOME}/.cc-connect"
LINE_CONFIG="export CC_CONNECT_CONFIG_PATH=\"${CONFIG_PATH}\""
LINE_WORK="export CC_CONNECT_WORK_DIR=\"${WORK_DIR}\""
MARKER="# cc-connect-config-ui env"

profiles=()
[[ -f "${HOME}/.zshrc" ]] && profiles+=("${HOME}/.zshrc")
[[ -f "${HOME}/.bash_profile" ]] && profiles+=("${HOME}/.bash_profile")
[[ -f "${HOME}/.profile" ]] && profiles+=("${HOME}/.profile")

# If no profiles exist, create .zshrc
if [[ ${#profiles[@]} -eq 0 ]]; then
  touch "${HOME}/.zshrc"
  profiles+=("${HOME}/.zshrc")
fi

preview() {
  echo "Will add to profiles: ${profiles[*]}"
  echo ""
  echo "  ${LINE_CONFIG}"
  echo "  ${LINE_WORK}"
}

apply() {
  for profile in "${profiles[@]}"; do
    # Check if already present
    if grep -q "${MARKER}" "${profile}" 2>/dev/null; then
      echo "Already configured in ${profile}"
      continue
    fi
    echo "" >> "${profile}"
    echo "${MARKER}" >> "${profile}"
    echo "${LINE_CONFIG}" >> "${profile}"
    echo "${LINE_WORK}" >> "${profile}"
    echo "Added to ${profile}"
  done

  # Also set via launchctl for GUI apps (current session)
  if command -v launchctl &>/dev/null; then
    launchctl setenv CC_CONNECT_CONFIG_PATH "${CONFIG_PATH}" 2>/dev/null || true
    launchctl setenv CC_CONNECT_WORK_DIR "${WORK_DIR}" 2>/dev/null || true
    echo "Set via launchctl for current GUI session"
  fi
  echo "Done. Restart your terminal or run: source ~/.zshrc"
}

unset_env() {
  for profile in "${profiles[@]}"; do
    if grep -q "${MARKER}" "${profile}" 2>/dev/null; then
      # Remove marker line + 2 env lines after it
      sed -i '' "/${MARKER}/{
        N;N;d
      }" "${profile}"
      echo "Removed from ${profile}"
    fi
  done

  if command -v launchctl &>/dev/null; then
    launchctl unsetenv CC_CONNECT_CONFIG_PATH 2>/dev/null || true
    launchctl unsetenv CC_CONNECT_WORK_DIR 2>/dev/null || true
  fi
  echo "Environment variables unset"
}

case "${1:-}" in
  --apply)   apply ;;
  --unset)   unset_env ;;
  *)         preview ;;
esac

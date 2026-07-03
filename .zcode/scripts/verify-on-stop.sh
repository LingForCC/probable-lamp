#!/usr/bin/env bash
# Runs typecheck + lint after each turn (Stop event) and reports failures
# back to the conversation. Exits 0 so it never blocks the session — failures
# are surfaced as additionalContext instead.
set -u

cd "${ZCODE_PROJECT_DIR:-$(dirname "$0")/../..}"

typecheck_output="$(npm run typecheck 2>&1)"
typecheck_status=$?

lint_output="$(npm run lint 2>&1)"
lint_status=$?

# No problems — pass silently.
if [ "$typecheck_status" -eq 0 ] && [ "$lint_status" -eq 0 ]; then
  exit 0
fi

# Build a report for the model to act on.
{
  echo "# Verification failed on Stop hook"
  echo
  if [ "$typecheck_status" -ne 0 ]; then
    echo "## \`npm run typecheck\` failed"
    echo '```'
    echo "$typecheck_output"
    echo '```'
    echo
  fi
  if [ "$lint_status" -ne 0 ]; then
    echo "## \`npm run lint\` failed"
    echo '```'
    echo "$lint_output"
    echo '```'
  fi
  echo "Please review the errors above from the previous turn and fix them before finishing."
} | jq -Rs '{additionalContext: .}'

exit 0

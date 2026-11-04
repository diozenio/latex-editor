#!/bin/bash
cmd=$(jq -r '.tool_input.command // ""')
if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' \
   && ! printf '%s' "$cmd" | grep -q 'CLAUDE_COMMIT_SKILL=1'; then
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "Commits must go through the staged-atomic-commits skill. Stage the changes, invoke the skill with the Skill tool, and let it create the commits."}}'
fi
exit 0

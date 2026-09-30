#!/usr/bin/env bash
# Self-contained smoke test: starts kaiju on a spare port with the example workspace and a throwaway
# data dir, exercises the REST API and automation, and stops it. Exit code 0 = all checks passed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-18790}"; TOKEN="smoke-$RANDOM"; DATA="$(mktemp -d)"
B="http://localhost:$PORT/rest/api/3"; AUTH=(-u "svc@mock.local:$TOKEN")
KAIJU_PORT=$PORT KAIJU_TOKEN=$TOKEN KAIJU_DATA_DIR="$DATA" node "$ROOT/src/server.js" > "$DATA/server.log" 2>&1 &
PID=$!; trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$DATA"' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/serverInfo" && break; sleep 0.25; done
pass=0; fail=0
check() { if [[ "$2" == *"$3"* ]]; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; echo "     expected to contain: $3"; echo "     got: ${2:0:300}"; fi; }
j() { curl -s "${AUTH[@]}" -H 'Content-Type: application/json' "$@"; }
check "401 without credentials" "$(curl -s -w '%{http_code}' "$B/myself")" "401"
check "myself" "$(j "$B/myself")" '"emailAddress":"svc@mock.local"'
check "project list" "$(j "$B/project")" '"key":"DEMO"'
check "fields include custom" "$(j "$B/field")" '"id":"customfield_10016"'
check "create issue" "$(j -X POST "$B/issue" -d '{"fields":{"project":{"key":"DEMO"},"issuetype":{"name":"Task"},"summary":"Smoke","customfield_10016":2}}')" '"key":"DEMO-7"'
check "select needs {value}" "$(j -X PUT "$B/issue/DEMO-7" -d '{"fields":{"customfield_10020":"Dev"}}')" "Specify a valid"
check "unknown field rejected" "$(j -X PUT "$B/issue/DEMO-7" -d '{"fields":{"customfield_1":"x"}}')" "cannot be set"
check "update ok (204)" "$(j -w '%{http_code}' -X PUT "$B/issue/DEMO-7" -d '{"fields":{"customfield_10020":{"value":"Dev"}}}')" "204"
check "hidden email" "$(j "$B/issue/DEMO-3?fields=assignee")" '"displayName":"Chris Park"'
check "no email leaked" "$(j "$B/issue/DEMO-3?fields=assignee" | grep -c chris@example.com || true)" "0"
check "search jql" "$(j -G --data-urlencode 'jql=parent = DEMO-2 ORDER BY key' "$B/search/jql")" '"key":"DEMO-3"'
check "bad jql is 400" "$(j -w '%{http_code}' -G --data-urlencode 'jql=status ==' "$B/search/jql")" "400"
check "transitions" "$(j "$B/issue/DEMO-4/transitions")" '"name":"Done"'
check "transition 204" "$(j -w '%{http_code}' -X POST "$B/issue/DEMO-4/transitions" -d '{"transition":{"id":"41"}}')" "204"
sleep 0.5
check "automation closed parent" "$(j "$B/issue/DEMO-2?fields=status")" '"name":"Done"'
check "attachment needs XSRF header" "$(curl -s "${AUTH[@]}" -w '%{http_code}' -F "file=@$ROOT/package.json" "$B/issue/DEMO-7/attachments")" "403"
check "attachment upload" "$(curl -s "${AUTH[@]}" -H 'X-Atlassian-Token: no-check' -F "file=@$ROOT/package.json" "$B/issue/DEMO-7/attachments")" '"filename":"package.json"'
check "v2 plain comment" "$(j -X POST "http://localhost:$PORT/rest/api/2/issue/DEMO-7/comment" -d '{"body":"hi"}')" '"body":"hi"'
check "changelog" "$(j "$B/issue/DEMO-7/changelog")" '"field":"Environment"'
check "manual rule + smart values" "$(curl -s -X POST "http://localhost:$PORT/_mock/api/issue/DEMO-2/automation/notify")" '"pointsInt":"5"'
check "incoming webhook" "$(curl -s -X POST -H 'X-Automation-Webhook-Token: demo-webhook-token' -H 'Content-Type: application/json' "http://localhost:$PORT/_mock/automation/webhook/inbound" -d '{"issues":["DEMO-5"],"message":"yo"}')" '"status":"SUCCESS"'
check "unsupported endpoint is explicit" "$(j "$B/issue/DEMO-1/worklog")" "does not implement"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]

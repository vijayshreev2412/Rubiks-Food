#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
TASK_TITLE_PREFIX="${TASK_TITLE_PREFIX:-SDLC demo}"
FAILURE_KEYWORD="${WORKER_FAILURE_KEYWORD:-[fail-worker]}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
MAX_POLLS="${MAX_POLLS:-20}"
MODE="${MODE:-happy}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --api-base-url <url>        Backend base URL (default: ${API_BASE_URL})
  --task-title-prefix <text>  Prefix for generated tasks (default: ${TASK_TITLE_PREFIX})
  --failure-keyword <text>    Keyword that triggers worker failure (default: ${FAILURE_KEYWORD})
  --poll-interval <seconds>   Poll interval for task status checks (default: ${POLL_INTERVAL_SECONDS})
  --max-polls <count>         Max poll attempts per task (default: ${MAX_POLLS})
  --mode <happy|failure|both> Scenario mode (default: ${MODE})
  --simulate-failure          Alias for --mode failure
  --help                      Show this help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --api-base-url)
        API_BASE_URL="$2"
        shift 2
        ;;
      --task-title-prefix)
        TASK_TITLE_PREFIX="$2"
        shift 2
        ;;
      --failure-keyword)
        FAILURE_KEYWORD="$2"
        shift 2
        ;;
      --poll-interval)
        POLL_INTERVAL_SECONDS="$2"
        shift 2
        ;;
      --max-polls)
        MAX_POLLS="$2"
        shift 2
        ;;
      --mode)
        MODE="$2"
        shift 2
        ;;
      --simulate-failure)
        MODE="failure"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ "$MODE" != "happy" && "$MODE" != "failure" && "$MODE" != "both" ]]; then
    echo "Invalid mode: ${MODE}. Expected happy, failure, or both." >&2
    exit 1
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

wait_for_backend() {
  local retries=20
  local delay=2
  local i
  for ((i = 1; i <= retries; i++)); do
    if curl -fsS "${API_BASE_URL}/health" >/dev/null; then
      return
    fi
    sleep "$delay"
  done
  echo "Backend is not healthy at ${API_BASE_URL}" >&2
  exit 1
}

create_task() {
  local title="$1"
  local description="$2"

  curl -fsS -X POST "${API_BASE_URL}/api/tasks" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg title "$title" --arg description "$description" '{title: $title, description: $description}')"
}

fetch_task() {
  local task_id="$1"

  curl -fsS "${API_BASE_URL}/api/tasks" \
    | jq --argjson task_id "$task_id" '.[] | select(.id == $task_id)'
}

print_task_status_line() {
  local task_json="$1"
  local id status attempts last_error
  id="$(jq -r '.id' <<<"$task_json")"
  status="$(jq -r '.status' <<<"$task_json")"
  attempts="$(jq -r '.worker_attempts // 0' <<<"$task_json")"
  last_error="$(jq -r '.last_error // ""' <<<"$task_json")"

  echo "task_id=${id} status=${status} attempts=${attempts} last_error=\"${last_error}\""
}

poll_until_status() {
  local task_id="$1"
  local expected_status="$2"
  local poll
  local task_json status output_file

  output_file="$(mktemp)"
  for ((poll = 1; poll <= MAX_POLLS; poll++)); do
    task_json="$(fetch_task "$task_id")"
    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
      echo "Task ${task_id} not found while polling" >&2
      rm -f "$output_file"
      exit 1
    fi

    print_task_status_line "$task_json" >&2
    printf '%s' "$task_json" >"$output_file"
    status="$(jq -r '.status' <<<"$task_json")"
    if [[ "$status" == "$expected_status" ]]; then
      cat "$output_file"
      rm -f "$output_file"
      return
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  echo "Task ${task_id} did not reach expected status '${expected_status}' within polling window" >&2
  if [[ -s "$output_file" ]]; then
    echo "Last seen task payload:" >&2
    jq '.' "$output_file" >&2
  fi
  rm -f "$output_file"
  exit 1
}

main() {
  parse_args "$@"
  require_cmd curl
  require_cmd jq

  wait_for_backend

  local success_status="" failure_status="" success_final_json="" failure_final_json=""

  if [[ "$MODE" == "happy" || "$MODE" == "both" ]]; then
    local success_task_title success_task_json success_task_id
    success_task_title="${TASK_TITLE_PREFIX}: happy path"
    echo "Creating healthy task: ${success_task_title}"
    success_task_json="$(create_task "$success_task_title" "Expected to move to queued")"
    success_task_id="$(jq -r '.id' <<<"$success_task_json")"
    success_final_json="$(poll_until_status "$success_task_id" "queued")"
    success_status="$(jq -r '.status' <<<"$success_final_json")"
  fi

  if [[ "$MODE" == "failure" || "$MODE" == "both" ]]; then
    local failure_task_title failure_task_json failure_task_id
    failure_task_title="${TASK_TITLE_PREFIX}: ${FAILURE_KEYWORD}"
    echo "Creating failing task: ${failure_task_title}"
    failure_task_json="$(create_task "$failure_task_title" "Expected to fail and hit retry/dead-letter flow")"
    failure_task_id="$(jq -r '.id' <<<"$failure_task_json")"
    failure_final_json="$(poll_until_status "$failure_task_id" "failed")"
    failure_status="$(jq -r '.status' <<<"$failure_final_json")"
  fi

  echo "----- Summary -----"
  if [[ -n "$success_status" ]]; then
    echo "Healthy task final status: ${success_status}"
    echo "Healthy task payload:"
    echo "$success_final_json" | jq '.'
  fi
  if [[ -n "$failure_status" ]]; then
    echo "Failing task final status: ${failure_status}"
    echo "Failing task payload:"
    echo "$failure_final_json" | jq '.'
  fi

  echo "Demo scenario completed successfully."
}

main "$@"

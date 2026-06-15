#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_value() {
  local key="$1"
  local file="$APP_DIR/.env"

  [[ -f "$file" ]] || return 0

  sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*['\"]?([^'\"#[:space:]]+).*/\1/p" "$file" \
    | tail -n 1
}

HOST="${HOST:-$(env_value HOST)}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-$(env_value PORT)}"
PORT="${PORT:-3400}"
NODE_ENV="${NODE_ENV:-development}"
PID_FILE="${PID_FILE:-$APP_DIR/.server.pid}"
LOG_DIR="${LOG_DIR:-$APP_DIR/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/server.log}"

cd "$APP_DIR"
mkdir -p "$LOG_DIR"

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_until_stopped() {
  local pid="$1"
  local seconds="${2:-8}"

  for ((i = 0; i < seconds * 10; i += 1)); do
    if ! is_running "$pid"; then
      return 0
    fi
    sleep 0.1
  done

  return 1
}

terminate_pid() {
  local pid="$1"

  if [[ "$pid" == "$$" ]] || ! is_running "$pid"; then
    return 0
  fi

  echo "Stopping PID $pid"
  kill "$pid" 2>/dev/null || true

  if ! wait_until_stopped "$pid" 8; then
    echo "PID $pid did not stop after SIGTERM; sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    wait_until_stopped "$pid" 3 || true
  fi
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    return
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT" 2>/dev/null || true
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$PORT" 2>/dev/null \
      | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
      | sort -u
  fi
}

project_server_pids() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return
  fi

  while read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" == "$$" ]] && continue

    if [[ -L "/proc/$pid/cwd" ]] && [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$APP_DIR" ]]; then
      echo "$pid"
    fi
  done < <(pgrep -f 'node .*server\.js' || true)
}

stop_server() {
  local pid
  local pids=()

  if [[ -f "$PID_FILE" ]]; then
    pid="$(<"$PID_FILE")"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      pids+=("$pid")
    fi
  fi

  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(port_pids)

  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(project_server_pids)

  if ((${#pids[@]} > 0)); then
    while read -r pid; do
      terminate_pid "$pid"
    done < <(printf '%s\n' "${pids[@]}" | sort -u)
  fi

  rm -f "$PID_FILE"

  if [[ -n "$(port_pids)" ]]; then
    echo "Port $PORT is still in use after stopping candidates." >&2
    exit 1
  fi
}

start_server() {
  echo "Starting Telnyx dialer on http://$HOST:$PORT"
  echo "Logs: $LOG_FILE"

  if command -v setsid >/dev/null 2>&1; then
    HOST="$HOST" PORT="$PORT" NODE_ENV="$NODE_ENV" setsid node server.js >>"$LOG_FILE" 2>&1 < /dev/null &
  else
    HOST="$HOST" PORT="$PORT" NODE_ENV="$NODE_ENV" nohup node server.js >>"$LOG_FILE" 2>&1 < /dev/null &
  fi

  local pid="$!"
  echo "$pid" >"$PID_FILE"

  for _ in {1..50}; do
    if ! is_running "$pid"; then
      echo "Server exited during startup. Recent logs:" >&2
      tail -n 80 "$LOG_FILE" >&2 || true
      exit 1
    fi

    if port_pids | grep -qx "$pid"; then
      echo "Server restarted successfully with PID $pid"
      return 0
    fi

    sleep 0.1
  done

  echo "Server PID $pid started, but port $PORT was not detected as listening." >&2
  echo "Recent logs:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  exit 1
}

stop_server
start_server

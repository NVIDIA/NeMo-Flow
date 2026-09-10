#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

usage() {
    cat <<'EOF'
Remove the NeMo Relay CLI installed by install.sh.

Usage:
  uninstall.sh [--install-dir DIR] [--dry-run] [--force]
  uninstall.sh --help

Options:
  --install-dir DIR    Installation directory (default: $HOME/.local/bin on Unix,
                       %LOCALAPPDATA%\\nemo-relay\\bin on Git Bash/MSYS/Cygwin).
  --dry-run            Print the binary that would be removed without removing it.
  --force              Interactively offer to terminate active Relay client processes.
  -h, --help           Show this help text.

Examples:
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NeMo-Relay/main/uninstall.sh | sh
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NeMo-Relay/main/uninstall.sh | sh -s -- --install-dir "$HOME/bin"

This removes only the installed CLI binary. It does not remove PATH entries,
Relay configuration, observability output, or coding-agent integrations. It
refuses removal while this CLI has active Relay processes unless --force is used.
Active managed daemon processes always block removal, including with --force.
Close affected coding-agent sessions, allow shared workers to drain, then stop
the managed deployment through its service manager. Managed bundles, daemon
identity/trust state, and deployment services are preserved.
EOF
}

error() {
    printf 'nemo-relay uninstaller: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || error "required command not found: $1"
}

process_command() {
    ps -p "$1" -o command= 2>/dev/null | sed -n '1p'
}

process_name() {
    ps -p "$1" -o comm= 2>/dev/null | sed -n '1p' | awk '{ print $1 }'
}

process_executable_path() {
    if [ -L "/proc/$1/exe" ]; then
        readlink "/proc/$1/exe" 2>/dev/null
        return
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p'
    fi
}

canonical_path() {
    canonical_target=$1
    canonical_hops=0
    # Resolve the executable as well as its directory for process comparison.
    # A dangling link can still be removed without following its missing target.
    while [ -L "$canonical_target" ] && [ -e "$canonical_target" ]; do
        [ "$canonical_hops" -lt 40 ] || return 1
        canonical_link=$(readlink "$canonical_target") || return 1
        case "$canonical_link" in
            /*) canonical_target=$canonical_link ;;
            *) canonical_target="$(dirname -- "$canonical_target")/$canonical_link" ;;
        esac
        canonical_hops=$((canonical_hops + 1))
    done
    canonical_directory=$(CDPATH= cd -P -- "$(dirname -- "$canonical_target")" && pwd) || return 1
    printf '%s/%s\n' "$canonical_directory" "$(basename -- "$canonical_target")"
}

is_installed_relay_process() {
    process_pid=$1
    process_executable=$(process_executable_path "$process_pid")
    if [ -n "$process_executable" ]; then
        [ "$process_executable" = "$destination_identity" ]
        return
    fi
    process_args=$(process_command "$process_pid")
    case "$process_args" in
        "$destination"|"$destination "*) return 0 ;;
        *) return 1 ;;
    esac
}

process_parent_pid() {
    ps -p "$1" -o ppid= 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, ""); print }'
}

is_coding_agent_process() {
    agent_name=$(process_name "$1")
    agent_name=${agent_name##*/}
    case "$agent_name" in
        codex|codex.exe|Codex|Codex.exe|claude|claude.exe|pi|pi.exe)
            return 0
            ;;
    esac

    agent_command=$(process_command "$1")
    case " $agent_command " in
        *" codex "*|*" codex.exe "*|*"/codex "*|*"/codex.exe "*|*"/codex/"*|*"/@openai/codex/"*|\
        *" claude "*|*" claude.exe "*|*"/claude "*|*"/claude.exe "*|*"/claude/"*|\
        *" pi "*|*" pi.exe "*|*"/pi "*|*"/pi.exe "*|*"/pi/"*) return 0 ;;
        *) return 1 ;;
    esac
}

is_mcp_command() {
    case " $1 " in
        *" mcp "*) return 0 ;;
        *) return 1 ;;
    esac
}

active_relay_process_pids() {
    process_snapshot=$(ps -axww -o pid=,command=) || return 1
    for process_pid in $(printf '%s\n' "$process_snapshot" | awk -v name="$binary_name" '
        # Inspect the full command: an executable path may contain spaces.
        $0 ~ ("(^|[[:space:]]|/)" name "([[:space:]]|$)") { print $1 }
    '); do
        if is_installed_relay_process "$process_pid"; then
            printf '%s\n' "$process_pid"
        fi
    done
}

shutdown_target_pid() {
    relay_pid=$1
    relay_command=$(process_command "$relay_pid")
    if ! is_mcp_command "$relay_command"; then
        printf '%s\n' "$relay_pid"
        return 0
    fi

    parent_pid=$(process_parent_pid "$relay_pid")
    current_pid=$parent_pid
    while [ -n "$current_pid" ] && [ "$current_pid" -gt 1 ] 2>/dev/null; do
        if is_coding_agent_process "$current_pid"; then
            printf '%s\n' "$current_pid"
            return 0
        fi
        next_pid=$(process_parent_pid "$current_pid")
        [ "$next_pid" = "$current_pid" ] && break
        current_pid=$next_pid
    done
    printf '%s\n' "$relay_pid"
}

active_shutdown_target_pids() {
    relay_pids=$(active_relay_process_pids) || return 1
    for relay_pid in $relay_pids; do
        shutdown_target_pid "$relay_pid"
    done | awk 'NF && !seen[$0]++ { print }'
}

active_shutdown_target_exists() {
    expected_pid=$1
    relay_pids=$(active_relay_process_pids) || error 'could not inspect active processes before uninstall'
    for relay_pid in $relay_pids; do
        [ "$(shutdown_target_pid "$relay_pid")" = "$expected_pid" ] && return 0
    done
    return 1
}

process_identity() {
    ps -p "$1" -o ppid= -o lstart= 2>/dev/null | sed -n '1p' | awk '{$1 = $1; print}'
}

describe_process() {
    process_pid=$1
    process_args=$(process_command "$process_pid")
    if [ -n "$process_args" ]; then
        printf 'PID %s: %s\n' "$process_pid" "$process_args"
    else
        printf 'PID %s\n' "$process_pid"
    fi
}

confirm_shutdown() {
    process_pid=$1
    if ! printf 'Terminate %s and its child processes? [y/N] ' "$(describe_process "$process_pid")" >/dev/tty 2>/dev/null; then
        error "--force requires an interactive terminal to confirm each active process"
    fi
    if ! IFS= read -r response </dev/tty; then
        error "could not read process shutdown confirmation"
    fi
    case "$response" in
        y|Y|yes|YES|Yes) return 0 ;;
        *) return 1 ;;
    esac
}

child_pids() {
    ps -ax -o pid=,ppid= | awk -v parent="$1" '$2 == parent { print $1 }'
}

process_is_ancestor_of_uninstaller() {
    ancestor_pid=$1
    current_pid=$$
    while [ -n "$current_pid" ] && [ "$current_pid" -gt 1 ] 2>/dev/null; do
        [ "$current_pid" = "$ancestor_pid" ] && return 0
        next_pid=$(process_parent_pid "$current_pid")
        [ -z "$next_pid" ] && break
        [ "$next_pid" = "$current_pid" ] && break
        current_pid=$next_pid
    done
    return 1
}

terminate_process_tree() {
    for child_pid in $(child_pids "$1"); do
        terminate_process_tree "$child_pid"
    done
    kill -TERM "$1" 2>/dev/null || true
}

wait_for_process_exit() {
    wait_pid=$1
    wait_attempt=0
    while process_is_running "$wait_pid"; do
        if [ "$wait_attempt" -ge 5 ]; then
            error "process ${wait_pid} did not stop after termination was confirmed"
        fi
        sleep 1
        wait_attempt=$((wait_attempt + 1))
    done
}

process_is_running() {
    process_state=$(ps -p "$1" -o stat= 2>/dev/null | sed -n '1p' | awk '{$1 = $1; print}')
    case "$process_state" in
        ""|Z*) return 1 ;;
    esac
    kill -0 "$1" 2>/dev/null
}

check_managed_relay_processes() {
    # Managed workers can serve sessions outside their local process tree.
    # Check before mapping MCP processes to agents or requesting any shutdown.
    relay_pids=$(active_relay_process_pids) || error 'could not inspect active processes before uninstall'
    for relay_pid in $relay_pids; do
        case " $(process_command "$relay_pid") " in
            *" daemon "*)
                describe_process "$relay_pid" >&2
                if [ "$dry_run" -eq 1 ]; then
                    error 'dry run would refuse removal: active managed daemon deployment; close affected coding-agent sessions, allow shared workers to drain, then stop it through its service manager. --force cannot override this restriction'
                fi
                error 'active managed daemon deployment; close affected coding-agent sessions, allow shared workers to drain, then stop it through its service manager. --force cannot override this restriction'
                ;;
        esac
    done
}

stop_active_relay_processes() {
    check_managed_relay_processes
    active_targets=$(active_shutdown_target_pids) || error 'could not inspect active processes before uninstall'
    [ -n "$active_targets" ] || return 0

    printf '%s\n' 'Active Relay processes prevent uninstallation:' >&2
    for active_pid in $active_targets; do
        describe_process "$active_pid" >&2
    done
    if [ "$dry_run" -eq 1 ]; then
        error 'dry run would refuse removal until these processes exit'
    fi
    if [ "$force" -eq 0 ]; then
        error "refusing to uninstall while active Relay processes exist; close the coding agents and retry, or rerun with --force to confirm each process shutdown"
    fi
    for active_pid in $active_targets; do
        if process_is_ancestor_of_uninstaller "$active_pid"; then
            error "cannot terminate process ${active_pid} from within its own process tree; rerun the uninstaller from an independent terminal"
        fi
        confirmed_identity=$(process_identity "$active_pid")
        [ -n "$confirmed_identity" ] || error "process ${active_pid} exited before confirmation"
        if ! confirm_shutdown "$active_pid"; then
            error "uninstall cancelled; process ${active_pid} remains active"
        fi
        current_identity=$(process_identity "$active_pid")
        if [ -z "$current_identity" ] || [ "$current_identity" != "$confirmed_identity" ]; then
            error "process ${active_pid} changed after confirmation; refusing to terminate it"
        fi
        if ! active_shutdown_target_exists "$active_pid"; then
            error "process ${active_pid} changed after confirmation; refusing to terminate it"
        fi
        check_managed_relay_processes
        terminate_process_tree "$active_pid"
        wait_for_process_exit "$active_pid"
    done

    remaining_targets=$(active_shutdown_target_pids) || error 'could not inspect active processes before uninstall'
    [ -z "$remaining_targets" ] || error "refusing to uninstall because Relay processes remain active"
}

install_dir=""
install_dir_set=0
dry_run=0
force=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --install-dir)
            [ "$#" -ge 2 ] || error "--install-dir requires a directory"
            install_dir=$2
            install_dir_set=1
            shift 2
            ;;
        --install-dir=*)
            install_dir=${1#*=}
            install_dir_set=1
            shift
            ;;
        --dry-run)
            dry_run=1
            shift
            ;;
        --force)
            force=1
            shift
            ;;
        --)
            shift
            ;;
        -*)
            error "unknown option: $1"
            ;;
        *)
            error "unexpected argument: $1"
            ;;
    esac
done

require_command uname
require_command ps
require_command awk
require_command sed
require_command sleep
require_command readlink
require_command dirname
require_command basename
os=$(uname -s)
is_windows_shell=0

case "$os" in
    CYGWIN*|MINGW*|MSYS*)
        is_windows_shell=1
        ;;
esac

if [ "$install_dir_set" -eq 1 ]; then
    [ -n "$install_dir" ] || error "install directory must not be empty"
elif [ "$is_windows_shell" -eq 1 ]; then
    [ -n "${LOCALAPPDATA:-}" ] || error "LOCALAPPDATA must be set to choose the default Windows install directory"
    require_command cygpath
    local_app_data=$(cygpath -u "$LOCALAPPDATA") || error "could not translate LOCALAPPDATA for this shell"
    install_dir="${local_app_data}/nemo-relay/bin"
else
    install_dir="${HOME:+${HOME}/.local/bin}"
    [ -n "$install_dir" ] || error "install directory must not be empty"
fi

case "$install_dir" in
    -*)
        error "install directory must not begin with '-': ${install_dir}"
        ;;
esac

if [ -e "$install_dir" ] && [ ! -d "$install_dir" ]; then
    error "install path is not a directory: ${install_dir}"
fi

binary_name="nemo-relay"
if [ "$is_windows_shell" -eq 1 ]; then
    binary_name="nemo-relay.exe"
fi
destination="${install_dir}/${binary_name}"

if [ -d "$destination" ]; then
    error "install target is a directory: ${destination}"
fi

if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
    printf 'NeMo Relay CLI is not installed at %s\n' "$destination"
    exit 0
fi

destination_identity=$(canonical_path "$destination") || error "could not resolve install path: ${destination}"

stop_active_relay_processes

if [ "$dry_run" -eq 1 ]; then
    printf 'Would remove NeMo Relay CLI at %s\n' "$destination"
    exit 0
fi

rm -f "$destination" || error "could not remove ${destination}"
printf 'Removed NeMo Relay CLI from %s\n' "$destination"

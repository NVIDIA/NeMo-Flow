#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
uninstaller="${repo_root}/uninstall.sh"
test_root=$(mktemp -d)
tests_run=0
active_session_pid=""
active_child_pids=""

cleanup() {
    if [ -n "$active_session_pid" ]; then
        kill "$active_session_pid" 2>/dev/null || true
        wait "$active_session_pid" 2>/dev/null || true
    fi
    for cleanup_pid in $active_child_pids; do
        kill "$cleanup_pid" 2>/dev/null || true
        wait "$cleanup_pid" 2>/dev/null || true
    done
    rm -rf "$test_root"
    return 0
}
trap cleanup EXIT HUP INT TERM

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

run_command() {
    if run_output=$("$@" 2>&1); then
        run_status=0
    else
        run_status=$?
    fi
    return 0
}

run_interactive_uninstaller() {
    response=$1
    interactive_install_dir=$2
    case "$(uname -s)" in
        Darwin)
            if run_output=$(NEMO_RELAY_TEST_RESPONSE="$response" \
                NEMO_RELAY_TEST_UNINSTALLER="$uninstaller" \
                NEMO_RELAY_TEST_INSTALL_DIR="$interactive_install_dir" \
                expect -c '
                set response $env(NEMO_RELAY_TEST_RESPONSE)
                set uninstaller $env(NEMO_RELAY_TEST_UNINSTALLER)
                set install_dir $env(NEMO_RELAY_TEST_INSTALL_DIR)
                spawn sh $uninstaller --install-dir $install_dir --force
                expect {
                    -re {\[y/N\] } { send -- "$response\r"; exp_continue }
                    eof {}
                }
                set result [wait]
                exit [lindex $result 3]
            ' 2>&1); then
                run_status=0
            else
                run_status=$?
            fi
            ;;
        *)
            interactive_command="sh '$uninstaller' --install-dir '$interactive_install_dir' --force"
            if run_output=$(printf '%s\n' "$response" | script -q -e -c "$interactive_command" /dev/null 2>&1); then
                run_status=0
            else
                run_status=$?
            fi
            ;;
    esac
    return 0
}

assert_success() {
    [ "$run_status" -eq 0 ] || fail "expected success, got ${run_status}: ${run_output}"
    return 0
}

assert_failure() {
    [ "$run_status" -ne 0 ] || fail "expected failure: ${run_output}"
    return 0
}

assert_contains() {
    assert_actual=$1
    assert_expected=$2
    printf '%s\n' "$assert_actual" | grep -F -- "$assert_expected" >/dev/null || fail "expected '$assert_expected' in: $assert_actual"
    return 0
}

build_relay_fixture() {
    fixture_path=$1
    cc -x c -o "$fixture_path" - <<'EOF'
#include <unistd.h>

int main(void) {
    setsid();
    sleep(30);
    return 0;
}
EOF
}

test_interface_validation() {
    tests_run=$((tests_run + 1))

    run_command sh "$uninstaller" --help
    assert_success
    assert_contains "$run_output" 'Usage:'

    run_command sh "$uninstaller" --unknown
    assert_failure
    assert_contains "$run_output" 'unknown option'

    run_command sh "$uninstaller" unexpected
    assert_failure
    assert_contains "$run_output" 'unexpected argument'

    run_command env -u HOME sh "$uninstaller"
    assert_failure
    assert_contains "$run_output" 'install directory must not be empty'
    return 0
}

test_default_installation_removal() {
    tests_run=$((tests_run + 1))
    home_dir="${test_root}/default-home"
    install_dir="${home_dir}/.local/bin"
    mkdir -p "$install_dir"
    : >"${install_dir}/nemo-relay"

    run_command env HOME="$home_dir" sh "$uninstaller"
    assert_success
    [ ! -e "${install_dir}/nemo-relay" ] || fail 'default binary was not removed'
    assert_contains "$run_output" "Removed NeMo Relay CLI from ${install_dir}/nemo-relay"
    return 0
}

test_custom_installation_dry_run_and_removal() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/custom-bin"
    mkdir -p "$install_dir"
    : >"${install_dir}/nemo-relay"
    : >"${install_dir}/unrelated-tool"

    run_command sh "$uninstaller" --install-dir "$install_dir" --dry-run
    assert_success
    [ -e "${install_dir}/nemo-relay" ] || fail 'dry run removed the binary'
    assert_contains "$run_output" "Would remove NeMo Relay CLI at ${install_dir}/nemo-relay"

    run_command sh "$uninstaller" --install-dir "$install_dir"
    assert_success
    [ ! -e "${install_dir}/nemo-relay" ] || fail 'custom binary was not removed'
    [ -e "${install_dir}/unrelated-tool" ] || fail 'uninstaller removed an unrelated file'
    return 0
}

test_absent_installation_is_idempotent() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/absent-bin"

    run_command sh "$uninstaller" --install-dir "$install_dir"
    assert_success
    assert_contains "$run_output" "NeMo Relay CLI is not installed at ${install_dir}/nemo-relay"
    return 0
}

test_active_relay_process_refuses_removal() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/active-bin"
    relay_binary="${install_dir}/nemo-relay"
    mkdir -p "$install_dir"
    build_relay_fixture "$relay_binary"
    PATH="${install_dir}:$PATH" nemo-relay &
    session_pid=$!
    active_session_pid=$session_pid

    sleep 1
    kill -0 "$session_pid" 2>/dev/null || fail 'PATH-launched Relay fixture did not start'
    run_command sh "$uninstaller" --install-dir "$install_dir"
    assert_failure
    assert_contains "$run_output" 'refusing to uninstall while active Relay processes exist'
    [ -e "$relay_binary" ] || fail 'uninstaller removed an active binary'

    run_command sh "$uninstaller" --install-dir "$install_dir" --force
    assert_failure
    assert_contains "$run_output" '--force requires an interactive terminal'
    [ -e "$relay_binary" ] || fail 'non-interactive force removed an active binary'

    kill "$session_pid" 2>/dev/null || true
    wait "$session_pid" 2>/dev/null || true
    active_session_pid=""
    return 0
}

test_force_confirmation_controls_shutdown() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/force-bin"
    relay_binary="${install_dir}/nemo-relay"
    mkdir -p "$install_dir"
    build_relay_fixture "$relay_binary"
    nohup "$relay_binary" >/dev/null 2>&1 &
    session_pid=$!
    active_session_pid=$session_pid

    sleep 1
    run_interactive_uninstaller n "$install_dir"
    assert_failure
    assert_contains "$run_output" "uninstall cancelled; process ${session_pid} remains active"
    kill -0 "$session_pid" 2>/dev/null || fail 'rejected confirmation terminated the Relay process'
    [ -e "$relay_binary" ] || fail 'rejected confirmation removed the Relay binary'

    run_interactive_uninstaller y "$install_dir"
    assert_success
    [ ! -e "$relay_binary" ] || fail 'accepted confirmation did not remove the Relay binary'
    if kill -0 "$session_pid" 2>/dev/null; then
        fail 'accepted confirmation did not terminate the Relay process'
    fi
    wait "$session_pid" 2>/dev/null || true
    active_session_pid=""
    return 0
}

test_mcp_owner_is_prompted_once() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/mcp-owner-bin"
    relay_binary="${install_dir}/nemo-relay"
    agent_runner="${test_root}/codex"
    child_pid_file="${test_root}/mcp-child-pids"
    mkdir -p "$install_dir"
    build_relay_fixture "$relay_binary"
    cat >"$agent_runner" <<'EOF'
relay_binary=$1
child_pid_file=$2
"$relay_binary" mcp &
first_child=$!
"$relay_binary" mcp &
second_child=$!
printf '%s %s\n' "$first_child" "$second_child" >"$child_pid_file"
cleanup_agent() {
    trap - EXIT HUP INT TERM
    kill "$first_child" "$second_child" 2>/dev/null || true
    wait "$first_child" "$second_child" 2>/dev/null || true
    exit 0
}
trap cleanup_agent EXIT HUP INT TERM
wait "$first_child"
wait "$second_child"
EOF
    nohup sh "$agent_runner" "$relay_binary" "$child_pid_file" >/dev/null 2>&1 &
    agent_pid=$!
    active_session_pid=$agent_pid

    wait_attempt=0
    while [ ! -s "$child_pid_file" ]; do
        [ "$wait_attempt" -lt 20 ] || fail 'MCP owner fixture did not start'
        sleep 1
        wait_attempt=$((wait_attempt + 1))
    done
    active_child_pids=$(sed -n '1p' "$child_pid_file")

    run_interactive_uninstaller n "$install_dir"
    assert_failure
    assert_contains "$run_output" "uninstall cancelled; process ${agent_pid} remains active"
    prompt_count=$(printf '%s\n' "$run_output" | grep -c "Terminate PID ${agent_pid}:")
    [ "$prompt_count" -eq 1 ] || fail "expected one prompt for the shared MCP owner, got ${prompt_count}"
    kill -0 "$agent_pid" 2>/dev/null || fail 'rejected confirmation terminated the coding agent owner'

    run_interactive_uninstaller y "$install_dir"
    assert_success
    [ ! -e "$relay_binary" ] || fail 'accepted coding-agent confirmation did not remove the Relay binary'
    kill -0 "$agent_pid" 2>/dev/null && fail 'accepted confirmation did not terminate the coding agent owner'
    for child_pid in $active_child_pids; do
        kill -0 "$child_pid" 2>/dev/null && fail "accepted confirmation did not terminate MCP child ${child_pid}"
    done
    wait "$agent_pid" 2>/dev/null || true
    active_session_pid=""
    active_child_pids=""
    return 0
}

test_force_refuses_its_own_agent_tree() {
    tests_run=$((tests_run + 1))
    install_dir="${test_root}/self-tree-bin"
    relay_binary="${install_dir}/nemo-relay"
    agent_runner="${test_root}/self-tree/codex"
    mkdir -p "$install_dir" "$(dirname "$agent_runner")"
    build_relay_fixture "$relay_binary"
    cat >"$agent_runner" <<'EOF'
relay_binary=$1
uninstaller=$2
install_dir=$3
"$relay_binary" mcp &
relay_pid=$!
trap 'kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true' EXIT HUP INT TERM
sleep 1
sh "$uninstaller" --install-dir "$install_dir" --force
EOF

    run_command sh "$agent_runner" "$relay_binary" "$uninstaller" "$install_dir"
    assert_failure
    assert_contains "$run_output" 'from within its own process tree'
    [ -e "$relay_binary" ] || fail 'self-tree refusal removed the Relay binary'
    return 0
}

test_interface_validation
test_default_installation_removal
test_custom_installation_dry_run_and_removal
test_absent_installation_is_idempotent
test_active_relay_process_refuses_removal
test_force_confirmation_controls_shutdown
test_mcp_owner_is_prompted_once
test_force_refuses_its_own_agent_tree

printf 'PASS: %s CLI uninstaller groups\n' "$tests_run"

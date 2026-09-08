#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
uninstaller="${repo_root}/uninstall.sh"
test_root=$(mktemp -d)
tests_run=0
active_session_pid=""

cleanup() {
    if [ -n "$active_session_pid" ]; then
        kill "$active_session_pid" 2>/dev/null || true
        wait "$active_session_pid" 2>/dev/null || true
    fi
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
    cc -x c -o "$relay_binary" - <<'EOF'
#include <unistd.h>

int main(void) {
    sleep(30);
    return 0;
}
EOF
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

test_interface_validation
test_default_installation_removal
test_custom_installation_dry_run_and_removal
test_absent_installation_is_idempotent
test_active_relay_process_refuses_removal

printf 'PASS: %s CLI uninstaller groups\n' "$tests_run"

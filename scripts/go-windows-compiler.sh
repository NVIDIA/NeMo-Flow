#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

compiler="$1"
shift

filtered_arguments=()
for argument in "$@"; do
    if [[ "$argument" != "-mthreads" ]]; then
        filtered_arguments+=("$argument")
    fi
done

exec "$compiler" "${filtered_arguments[@]}"

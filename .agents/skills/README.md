<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Maintainer Skills

This directory contains on-demand guidance for specialized NeMo Relay
maintenance tasks. Codex discovers it directly; `.claude/skills` links here so
Claude Code uses the same source.

Use the repository guidance layers as follows:

- Always-loaded repository guidance owns facts and policies needed for most
  work, including scope, validation, naming, generated files, and
  external-action boundaries.
- A skill owns a specialized workflow or domain invariant that is relevant only
  when its description matches the task.
- A skill's `references/` directory owns conditional detail. Open only the
  reference required for the current mode.

Load at most the directly applicable maintainer skill. Skills must not require a
generic companion skill or a second skill merely for validation. Use
`CONTRIBUTING.md`, the `justfile`, and existing implementation patterns as the
sources of truth instead of copying general command catalogs into skill bodies.

Consumer-facing NeMo Relay usage skills live in top-level `skills/` and are
maintained independently for integrators and end users.

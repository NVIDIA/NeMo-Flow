<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NeMo Relay Repository Guidance

## Working Agreement

- Inspect the relevant code and existing patterns before editing. State material
  assumptions, keep the change scoped, and avoid unrelated cleanup.
- Prefer the smallest implementation and validation that prove the requested
  behavior. Do not add speculative abstractions or tests that mirror the code.
- Use `rg` for repository search and the `justfile` recipes for standard build,
  test, documentation, and packaging workflows. Run `just --list` to discover
  current recipes instead of relying on copied command catalogs.
- Preserve user changes in a dirty worktree. Do not edit generated or packaged
  outputs by hand; use the repository workflow that owns them.
- Never create, publish, comment on, or respond to a GitHub or GitLab pull
  request, merge request, or issue without explicit user approval.

## Architecture

- Rust is the runtime source of truth. Primary supported bindings are Rust,
  Python, and Node.js. Go and the raw C FFI are experimental and source-first.
- Scope stacks establish ownership, visibility, cleanup, and event parentage.
  Middleware and plugins operate within that scope model; events are emitted in
  Agent Trajectory Observability Format (ATOF) and consumed by subscribers or
  exporters.
- A public or observable runtime change requires identifying which bindings
  expose the affected contract. Keep those surfaces aligned, but do not modify
  or test an unrelated binding solely because the implementation is in Rust.
- Python wrappers live under `python/nemo_relay`, their PyO3 bridge under
  `crates/python`, Node.js under `crates/node`, and Go under `go/nemo_relay`.
- User documentation lives under `docs/`; Fern configuration and presentation
  live under `fern/`. Maintainer skills live under `.agents/skills` and are
  shared with Claude Code through `.claude/skills`.

## Validation

1. Decide which observable behavior and language surfaces can change.
2. During implementation, run the narrowest focused test or check that proves
   the behavior: usually one affected test, file, or module through its native
   runner rather than a canonical surface suite.
3. Before handoff, run the canonical suite only for each directly affected
   surface: `just test-rust`, `just test-python`, `just test-node`, or
   `just test-go`. Add binding suites for shared-runtime changes only when the
   binding's exposed or observable contract is affected.
4. Run integration, docs, packaging, FFI, generated-output, or build-only checks
   only when those surfaces change or the relevant test does not build them.
5. Use `uv run pre-commit run` for repository hooks; it checks the staged
   changes. Reserve `--all-files` for an explicit request, release preparation,
   or CI.

Documentation, comments, mechanical metadata, and other reversible low-impact
changes do not require language test suites unless they alter executable
examples, generated output, packaging, or build behavior. Report what was
validated and any relevant checks not run.

## Repository Conventions

- Keep SPDX headers on source, documentation, scripts, and configuration files.
  `SKILL.md` files instead start with YAML frontmatter containing `name` and
  `description`.
- Follow binding naming conventions: Rust and Python `snake_case`, C exports
  prefixed `nemo_relay_`, Go public APIs `PascalCase`, and Node.js `camelCase`.
- Use `serde_json::Value` through the repository `Json` alias where existing
  Rust runtime APIs expect JSON. Use `Result<T>` with `FlowError` in core paths.
- Preserve the existing tokio async model and callback or future lifetimes
  across bindings.
- Update public documentation and examples when public behavior, package names,
  supported bindings, or documented workflows change.
- Keep release-process policy in maintainer sources such as `RELEASING.md` and
  complete release history in GitHub Releases.
- Use signed-off commits and repository branch naming only when the user asks
  for commit or branch work. For PR work, read the current repository template.

## On-Demand Guidance

Load at most the directly applicable maintainer skill for specialized work such
as middleware, bindings, dynamic plugins, observability, CI, packaging,
documentation review, releases, or PR preparation. Do not load another skill
for generic coding behavior or validation; this file owns those policies.

See `CONTRIBUTING.md` and `docs/contribute/testing-and-docs.mdx` for contributor
details, and `.agents/skills/README.md` for the maintainer skill boundary.

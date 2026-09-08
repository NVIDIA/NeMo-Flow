---
name: rename-surfaces
description: Rename a NeMo Relay repository, package, crate, module, public symbol, import path, or brand surface across multiple consumers. Do not use for a file-local private rename.
license: Apache-2.0
---


# Perform A Repo Rename Or Surface Rename

Use this skill for coordinated naming changes such as repository renames, crate
prefix changes, package/module renames, import-path changes, FFI symbol renames,
or branding text updates that must preserve functional identifiers.

## Rename Buckets To Audit

- Repository references
- Rust crate names and module prefixes
- Python package name and top-level module
- Go module path and package paths
- Node package names
- C header names and symbol prefixes
- Docs, examples, CI, and integration packages

## Rules

- Separate **branding text** from **functional identifiers**.
- Preserve repository and import paths exactly where code depends on them.
- Update generated or generated-from-build surfaces such as
  `crates/ffi/nemo_relay.h` through the proper build step.
- Search for old names after the rename and validate every public language
  surface.

## Checklist

- [ ] Manifests updated
- [ ] Source imports and symbol names updated
- [ ] Docs and examples updated
- [ ] Integration packages and scripts updated
- [ ] No stale old names remain in tracked files where they would break behavior
- [ ] Every surface changed by the rename has focused validation

## References

- `README.md`
- `docs/getting-started/quick-start/index.mdx`
- `docs/reference/api/index.mdx`

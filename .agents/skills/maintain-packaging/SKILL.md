---
name: maintain-packaging
description: Add or change NeMo Relay packages, package metadata, module paths, generated artifacts, registry output, or release-facing build surfaces, including registering new unified-release surfaces with version automation. Do not use for a standalone project version bump, ordinary source builds, or tests.
license: Apache-2.0
---


# Maintain Release And Packaging Surfaces

Use this skill when a change affects how NeMo Relay is built, packaged, named, or
consumed outside the source tree.

## Audit Areas

- Rust `Cargo.toml` package names and workspace metadata
- Python packaging in `pyproject.toml`
- Python worker plugin SDK packaging in `python/plugin/pyproject.toml`
- Go module path in `go/nemo_relay/go.mod`
- Node workspace metadata in root `package.json` and `package-lock.json`
- Node package metadata in `crates/node/package.json`
- FFI header and library naming
- CI workflows, install commands, and example commands
- `justfile` build, test, clean, version, and package recipes for plugin crates
  and packages
- Release tags, release-note surfaces, and registry-facing version translation

## Checklist

- [ ] Every new package or plugin has an explicit versioning model: either it
      participates in the unified NeMo Relay release or it has an intentionally
      independent source of truth
- [ ] Package names, import paths, and module names are internally consistent
- [ ] Generated artifacts still land where downstream consumers expect
- [ ] Docs and examples use the current install/import/build commands
- [ ] CI references the same package names as local workflows
- [ ] Public packaging changes are reflected in release-facing docs
- [ ] For a new unified-release surface, its manifest version, lockfile entry,
      and internal NeMo Relay version pins are covered by `set_project_version`
      in the `justfile`; extend the owning helper and its fail-fast field checks
      in the same change when a value is not derived automatically, without
      adding a separate test that mirrors the helper's field list
- [ ] `nemo-relay-plugin` Rust and Python packages track the project SemVer
      policy and Python wheels use valid PEP 440 translation
- [ ] Release tags still use raw SemVer without a leading `v`
- [ ] Release history and release notes still point to GitHub Releases, not `CHANGELOG.md` or docs pages

## References

- `pyproject.toml`
- `python/plugin/pyproject.toml`
- `go/nemo_relay/go.mod`
- `package.json`
- `package-lock.json`
- `crates/node/package.json`
- `RELEASING.md`
- `.github/workflows/ci_python.yml`
- `.github/workflows/ci.yaml`
- `.gitlab-ci.yml`
- `justfile`

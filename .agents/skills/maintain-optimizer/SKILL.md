---
name: maintain-optimizer
description: Change NeMo Relay adaptive configuration, built-in adaptive components, reports, or binding helpers; also use when the task calls this surface optimizer. Do not use for generic plugin changes.
license: Apache-2.0
---


# Maintain Adaptive Surfaces

Use this skill when changing adaptive config schema, built-in sections, shared
plugin lifecycle, plugin registration, or binding-native helper
APIs.

## Public Boundary

The stable adaptive boundary is the config document plus the shared plugin
lifecycle:

- Config types and policies
- Built-in adaptive section helpers
- Plugin registration and composition
- Plugin lifecycle
- Reports and diagnostics

There is no separate public adaptive runtime handle.

See `docs/configure-plugins/adaptive/configuration.mdx` and
`docs/configure-plugins/about.mdx`.

## Keep In Sync

- `crates/adaptive`
- Shared plugin behavior in core and bindings
- Python adaptive/plugin wrappers in `python/nemo_relay/adaptive.py` and
  `python/nemo_relay/plugin.py`
- Go adaptive helpers under `go/nemo_relay/adaptive` plus shared plugin
  helpers in `go/nemo_relay`
- Node.js adaptive helpers and plugin wrappers
- Docs and examples that show canonical config shapes

## Checklist

- [ ] Dynamic config shape still matches the documented canonical model
- [ ] Typed helper constructors still map cleanly to the same config document
- [ ] Plugin lifecycle is consistent across languages
- [ ] Plugin context surfaces remain aligned
- [ ] Validation/report behavior remains documented and tested
- [ ] Any new component kind has docs, examples, and binding coverage

## Validation

- Run adaptive-focused Rust tests
- Run binding tests for every changed adaptive or plugin surface
- Update adaptive docs and any examples in the same branch

## References

- `docs/configure-plugins/adaptive/configuration.mdx`
- `docs/configure-plugins/adaptive/about.mdx`
- `docs/configure-plugins/adaptive/acg.mdx`
- `docs/configure-plugins/adaptive/adaptive-hints.mdx`
- `docs/build-plugins/about.mdx`
- `docs/build-plugins/configuration-and-validation.mdx`

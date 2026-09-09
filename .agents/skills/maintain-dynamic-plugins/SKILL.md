---
name: maintain-dynamic-plugins
description: Change NeMo Relay dynamic plugin loaders, manifests, native ABI, gRPC worker protocol, or Python worker SDK. Do not use for ordinary built-in plugin configuration.
license: Apache-2.0
---

# Maintain Dynamic Plugins

Use this skill for `plugin.kind = "rust_dynamic"`, `plugin.kind = "worker"`,
`nemo-relay-plugin`, `nemo-relay-worker`, `nemo-relay-worker-proto`,
`nemo-relay-types`, and the Python `nemo-relay-plugin` package.

## Rules

- Keep the stable boundary explicit: native plugins cross a C ABI; worker
  plugins cross `grpc-v1`.
- Do not pass Rust runtime types, trait objects, futures, or allocator-owned
  strings across the native dynamic-library boundary.
- Typed native middleware futures run on the SDK-owned Tokio executor. Keep
  subscribers synchronous and preserve raw synchronous ABI registrations.
- Define closed worker transport structures in protobuf when generated clients
  must enforce their fields. Keep open application payloads lossless by using
  `JsonValue` or `JsonEnvelope` rather than `google.protobuf.Value`.
- Keep `relay-plugin.toml` dynamic records separate from generic runtime
  components. Enabled dynamic records may synthesize internal component specs;
  disabled records stay inspectable but unloaded.
- Relay 0.8 establishes the native API 1 and `grpc-v1` canonical
  `ToolExecutionResult` baseline. Require every dynamic plugin to rebuild and
  declare a `compat.relay` range that excludes versions before 0.8. Recommend
  `>=0.8.0,<1.0`; open-ended or narrower 0.8-or-newer ranges are valid.
- Treat `compat.relay` as the plugin author's compatibility assertion, not
  proof that an artifact was rebuilt. Do not add a legacy raw-result adapter.
- Relay 0.8 retains the `grpc-v1` identifier and
  `nemo.relay.worker.v1` package while changing the tool-result protobuf types;
  every worker must regenerate its bindings and rebuild. Native ABI v4 permits
  append-only host-table extensions guarded by `struct_size`; existing fields
  must remain frozen at their original offsets. Incompatible native JSON,
  reordered or replaced native fields, or incompatible worker protobuf changes
  must bump `native_api` or `worker_protocol`.
- Do not add tests under `src`; Rust tests belong in crate `tests/` trees and
  Python SDK tests belong under `python/tests`.
- Native and worker plugins are trusted extensions. Document that native plugins
  are in-process and unsandboxed; worker plugins provide process isolation but
  not a security sandbox.

## Checklist

- [ ] Manifest validation covers kind, compatibility, load contract, integrity,
      capability mismatch, and disabled-plugin behavior.
- [ ] Native loader keeps libraries alive until registered callbacks are cleared
      and deregisters plugin kinds before unload.
- [ ] Worker activation covers process launch, token auth, handshake, validation,
      declarative registration, proxy rollback, cancellation, and shutdown.
- [ ] Rust and Python SDKs expose every supported registration surface.
- [ ] Runtime helpers cover marks, scopes, continuations, and isolated scope
      stacks.
- [ ] `plugins list`, `plugins inspect`, and `plugins validate` report lifecycle
      and compatibility status without leaking secret config.
- [ ] Top-level `doctor` reports resolved dynamic plugin and host configuration
      status.
- [ ] When detailed dynamic plugin guides exist, they keep Rust native, Python
      worker, and `grpc-v1` protocol details on separate pages.
- [ ] `justfile`, Codecov, and CI package/test workflows include new plugin
      crates and packages.

## Validation

Choose checks by the changed layer:

- Manifest or shared types: test the owning Rust crate.
- Native loader or ABI: prepare plugin fixtures and run the focused native
  plugin integration test.
- Worker protocol or host: test the worker crates and regenerate or test the
  Python worker SDK only when its protocol surface changes.
- Shared runtime behavior: run the Rust suite and only binding suites whose
  observable plugin behavior changes.
- Documentation or packaging: run their targeted checks only when changed.

Canonical surface suites prepare plugin fixtures. Before a raw focused native
or worker integration test, run `just build-test-plugin-fixtures`; never compile
fixtures inside an individual test case.

## References

- `crates/core/src/plugin/dynamic/`
- `crates/plugin`
- `crates/worker`
- `crates/worker-proto`
- `crates/types`
- `python/plugin`
- `examples/rust-native-plugin`
- `docs/build-plugins`
- `examples/python-grpc-worker-plugin`

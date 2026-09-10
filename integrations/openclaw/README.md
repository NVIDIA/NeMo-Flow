<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NeMo Relay for OpenClaw

`nemo-relay-openclaw` adds an in-process NeMo Relay provider to OpenClaw. It does not use the Relay Gateway, a plugin endpoint, or destination headers. OpenClaw's original stream function continues to own authentication and network transport while Relay wraps the real call inline.

## Models

Select an upstream model through the `nemo-relay` prefix:

```text
nemo-relay/<upstream-provider>/<upstream-model-id>
```

Model IDs may contain slashes. For example, `nemo-relay/openrouter/vendor/model` resolves provider `openrouter` and model ID `vendor/model`. Recursive references such as `nemo-relay/nemo-relay/...` fail closed.

The initial verified routes are:

| Provider        | OpenClaw API                             |
| --------------- | ---------------------------------------- |
| `openai`        | `openai-responses`, `openai-completions` |
| `openai-codex`  | `openai-chatgpt-responses`               |
| `anthropic`     | `anthropic-messages`                     |
| `google`        | `google-generative-ai`                   |
| `google-vertex` | `google-vertex`                          |
| `openrouter`    | `openai-completions`                     |

Unknown APIs and models that require a custom transport are rejected before execution. The resolved upstream model retains its OpenClaw compatibility metadata, prompt and reasoning behavior, tool schemas, parameters, runtime authentication, base URL, and request transport overrides.

## Configuration

Install the plugin and restart OpenClaw:

```bash
openclaw plugins install npm:nemo-relay-openclaw
openclaw gateway restart
```

Configure the plugin under `plugins.entries["nemo-relay"].config`:

```json
{
  "enabled": true,
  "plugins": {
    "version": 1,
    "components": []
  },
  "routing": {
    "favorites": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"]
  },
  "fallback": {
    "enabled": true
  }
}
```

`routing.favorites` publishes configured aliases in OpenClaw's model catalog. Other compatible routes can still be entered directly. `plugins` is the standard NeMo Relay plugin-host configuration and can install guardrails, request/execution/stream intercepts, adaptive behavior, subscribers, and exporters. The integration passes live payloads into Relay; Relay event sanitizers and observability configuration own content filtering. The legacy `backend` and `correlation` fields are accepted as deprecated no-ops for one release.

## Live lineage

The integration opens Relay handles at the authoritative OpenClaw lifecycle boundary:

```text
session
└── agent run
    ├── managed LLM call
    │   └── upstream provider execution
    ├── tool call
    └── subagent session
        └── subagent run
```

It stores only live identifiers and handles. It does not reconstruct calls from transcripts, message history, `agent_end`, or late timing events. Missing and ambiguous managed lineage fails closed. Unprefixed fallback telemetry remains fail open and pairs only live `llm_input`/`llm_output` hooks.

Only one active agent run per OpenClaw session is supported. A managed stream uses an exact `requestId`/run match when available, otherwise the session must contain exactly one active run. Subagent sessions wait up to one second for an authoritative spawn edge and never open an orphan scope. Incomplete handles have a five-minute TTL and a 1,024-record bound per category; shutdown drains them leaf to root as abandoned.

Assistant tool-call IDs are recorded as causal metadata on sibling tool spans. Run-mode subagents are structurally parented beneath the requester run. Long-lived subagent sessions are structurally parented beneath the requester session and carry requester-run causal metadata so they may safely outlive that run.

Use the admin-scoped `nemoRelay.status` method to inspect active counts and missing-run, ambiguous-run, orphan-subagent, and ambiguous-spawn-tool counters:

```bash
openclaw gateway call nemoRelay.status --json
```

## Middleware support

Managed model calls support Relay conditional guardrails, request intercepts, execution intercepts, stream execution intercepts, adaptive behavior, and observability on the real provider execution path. Tool calls support conditional guardrails, request intercepts, and live observability through OpenClaw's public before/after hooks.

Tool execution intercepts are the only unsupported Relay interception type because OpenClaw's public hooks do not expose the tool execution callback. The plugin intentionally does not use the undocumented `agentToolCallMiddleware` contract.

## Development

From the repository root, run:

```bash
just test-openclaw
npm run pack:check --workspace=nemo-relay-openclaw
```

Credentialed smoke tests for verified upstream families require the corresponding OpenClaw credentials and models. The default live smoke validates the real local `nemo-relay-node` lifecycle without making a provider network request.

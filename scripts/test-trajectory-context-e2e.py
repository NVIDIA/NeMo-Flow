# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise trajectory-context redaction against live Inference Hub APIs.

The harness intentionally sends one short, synthetic-secret-bearing request
through every provider wire format exposed by the configured Inference Hub.
It then reads the resulting OpenInference spans from Phoenix and verifies that
the secret and source-only fields did not leave the process.

Load ``NV_INFERENCEHUB_ENDPOINT`` and ``NV_INFERENCEHUB_KEY`` before running:

    set -a; source /path/to/.inference_secrets; set +a
    uv run python scripts/test-trajectory-context-e2e.py \
      --phoenix-url http://host:6006
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Callable, cast
from urllib.error import HTTPError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

import nemo_relay
from nemo_relay import llm, plugin, scope, subscribers
from nemo_relay.codecs import (
    AnthropicMessagesCodec,
    GeminiGenerateContentCodec,
    OpenAIChatCodec,
    OpenAIResponsesCodec,
)

Json = dict[str, Any] | list[Any] | str | int | float | bool | None


@dataclass(frozen=True)
class ProviderCase:
    name: str
    codec: Any
    request_content: Callable[[str, str], dict[str, Any]]
    request_headers: Callable[[str, str], dict[str, str]]
    request_path: Callable[[str], str]
    output_key: str
    output_keys: frozenset[str]
    gateway_origin: bool = False


def post_json(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    *,
    redirects_remaining: int = 1,
) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code in {301, 302, 307, 308} and redirects_remaining:
            location = error.headers.get("Location")
            if location:
                return post_json(
                    urljoin(url, location),
                    headers,
                    payload,
                    redirects_remaining=redirects_remaining - 1,
                )
        # Do not include headers or request bodies in failures: this harness is
        # deliberately safe to share as evidence.
        raise RuntimeError(f"provider returned HTTP {error.code} at {urlsplit(url).path}") from error


def get_json(url: str) -> dict[str, Any]:
    with urlopen(url, timeout=20) as response:
        return json.load(response)


def phoenix_attributes(span: dict[str, Any]) -> dict[str, Any]:
    attributes = span.get("attributes", {})
    if isinstance(attributes, dict):
        return attributes
    if not isinstance(attributes, list):
        return {}
    result: dict[str, Any] = {}
    for item in attributes:
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            result[item["key"]] = item.get("value")
    return result


def string_attribute(attributes: dict[str, Any], key: str) -> str | None:
    value = attributes.get(key)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for candidate in ("stringValue", "string_value", "value"):
            nested = value.get(candidate)
            if isinstance(nested, str):
                return nested
    return None


def phoenix_spans(phoenix_url: str, project: str) -> list[dict[str, Any]]:
    endpoint = f"{phoenix_url.rstrip('/')}/v1/projects/{quote(project, safe='')}/spans?limit=1000"
    document = get_json(endpoint)
    for key in ("data", "spans"):
        value = document.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def string_headers(headers: dict[str, Json]) -> dict[str, str]:
    if not all(isinstance(value, str) for value in headers.values()):
        raise AssertionError("Relay emitted a non-string HTTP header")
    return {key: value for key, value in headers.items() if isinstance(value, str)}


async def run_case(
    case: ProviderCase,
    *,
    endpoint: str,
    api_key: str,
    model: str,
    secret: str,
) -> dict[str, Any]:
    request_content = case.request_content(model, secret)
    request_headers = case.request_headers(api_key, secret)
    request = nemo_relay.LLMRequest(request_headers, request_content)
    forwarded: dict[str, Any] = {}
    raw_response: dict[str, Any] = {}

    async def invoke(outbound: nemo_relay.LLMRequest) -> Json:
        forwarded["headers"] = dict(outbound.headers)
        forwarded["content"] = copy.deepcopy(outbound.content)
        path = case.request_path(model)
        request_endpoint = endpoint.rstrip("/") + path
        if case.gateway_origin:
            parts = urlsplit(endpoint)
            request_endpoint = f"{parts.scheme}://{parts.netloc}{path}"
        response = await asyncio.to_thread(
            post_json,
            request_endpoint,
            string_headers(dict(outbound.headers)),
            outbound.content,
        )
        raw_response.update(response)
        try:
            case.codec.decode_response(response)
        except Exception as error:
            raise AssertionError(f"{case.name}: live response is not decodable") from error
        return response

    with scope.scope(
        f"trajectory-context-e2e-{case.name}",
        nemo_relay.ScopeType.Agent,
        metadata={"synthetic_secret": secret},
    ):
        try:
            result = await llm.execute(
                f"inferencehub-{case.name}",
                request,
                invoke,
                model_name=model,
                codec=case.codec,
                response_codec=case.codec,
            )
        except RuntimeError as error:
            raise RuntimeError(f"{case.name}: {error}") from error

    if result != raw_response:
        raise AssertionError(f"{case.name}: Relay changed the caller-facing response")
    forwarded_headers = forwarded.get("headers", {})
    headers_preserved = isinstance(forwarded_headers, dict) and all(
        forwarded_headers.get(key) == value for key, value in request_headers.items()
    )
    if forwarded.get("content") != request_content or not headers_preserved:
        raise AssertionError(
            f"{case.name}: trajectory sanitization changed the provider request "
            f"(content_equal={forwarded.get('content') == request_content}, "
            f"expected_header_keys={sorted(request_headers)}, "
            f"forwarded_header_keys={sorted(forwarded_headers) if isinstance(forwarded_headers, dict) else []})"
        )
    return {"provider": case.name, "response_keys": sorted(raw_response)[:20]}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--phoenix-url", required=True)
    result.add_argument("--model", default="nvidia/meta/llama-3.1-8b-instruct")
    result.add_argument("--project-prefix", default="trajectory-context-e2e")
    return result


async def main() -> int:
    args = parser().parse_args()
    endpoint = os.environ.get("NV_INFERENCEHUB_ENDPOINT", "").rstrip("/")
    api_key = os.environ.get("NV_INFERENCEHUB_KEY", "")
    if not endpoint or not api_key:
        raise RuntimeError("NV_INFERENCEHUB_ENDPOINT and NV_INFERENCEHUB_KEY must be set")

    run_id = uuid4().hex
    secret = f"E2E_SECRET_{run_id}"
    project = f"{args.project_prefix}-{datetime.now(UTC):%Y%m%d-%H%M%S}-{run_id[:8]}"
    cases = (
        ProviderCase(
            "openai_chat",
            OpenAIChatCodec(),
            lambda model, marker: {
                "model": model,
                "messages": [{"role": "user", "content": f"{marker}; reply only relay."}],
                "max_tokens": 8,
            },
            lambda key, marker: {"authorization": f"Bearer {key}", "x-e2e-secret": marker},
            lambda _model: "/chat/completions",
            "choices",
            frozenset({"id", "model", "choices", "usage"}),
        ),
        ProviderCase(
            "openai_responses",
            OpenAIResponsesCodec(),
            lambda model, marker: {"model": model, "input": f"{marker}; reply only relay.", "max_output_tokens": 8},
            lambda key, marker: {"authorization": f"Bearer {key}", "x-e2e-secret": marker},
            lambda _model: "/responses",
            "output",
            frozenset({"id", "model", "status", "output", "usage"}),
        ),
        ProviderCase(
            "anthropic_messages",
            AnthropicMessagesCodec(),
            lambda model, marker: {
                "model": model,
                "max_tokens": 8,
                "messages": [{"role": "user", "content": f"{marker}; reply only relay."}],
            },
            lambda key, marker: {"x-api-key": key, "anthropic-version": "2023-06-01", "x-e2e-secret": marker},
            lambda _model: "/messages",
            "content",
            frozenset({"id", "type", "role", "model", "stop_reason", "content", "usage"}),
        ),
        ProviderCase(
            "gemini_generate_content",
            GeminiGenerateContentCodec(),
            lambda _model, marker: {
                "contents": [{"role": "user", "parts": [{"text": f"{marker}; reply only relay."}]}],
                "generationConfig": {"maxOutputTokens": 8},
            },
            lambda key, marker: {"x-goog-api-key": key, "x-e2e-secret": marker},
            lambda model: f"/v1beta/models/{quote(model, safe='')}:generateContent",
            "candidates",
            frozenset({"responseId", "modelVersion", "candidates", "usageMetadata"}),
            gateway_origin=True,
        ),
    )

    telemetry = nemo_relay.OpenTelemetryConfig("openinference", f"{args.phoenix_url.rstrip('/')}/v1/traces")
    telemetry.service_name = "nemo-relay-trajectory-context-e2e"
    telemetry.instrumentation_scope = "nemo-relay-trajectory-context-e2e"
    telemetry.set_resource_attribute("openinference.project.name", project)
    telemetry.set_resource_attribute("e2e.run_id", run_id)
    subscriber = nemo_relay.OpenTelemetrySubscriber(telemetry)
    subscriber_name = f"trajectory-context-e2e-{run_id}"
    subscriber.register(subscriber_name)
    emitted_events: list[dict[str, Any]] = []
    emitted_name = f"trajectory-context-e2e-capture-{run_id}"

    def capture(event: nemo_relay.Event) -> None:
        if event.kind == "scope" and event.category == "llm":
            emitted_events.append(
                {
                    "name": event.name,
                    "scope_category": getattr(event, "scope_category", None),
                    "data": copy.deepcopy(event.data),
                }
            )

    subscribers.register(emitted_name, capture)

    results: list[dict[str, Any]] = []
    try:
        for case in cases:
            pii_config: Any = {
                "version": 1,
                "codec": case.name,
                "profiles": [{"mode": "builtin", "priority": 80, "builtin": {"preset": "trajectory_context"}}],
            }
            component = plugin.ComponentSpec(
                kind="pii_redaction",
                config=cast(Any, pii_config),
            )
            config = plugin.PluginConfig(components=[component])
            async with plugin.plugin(config):
                results.append(
                    await run_case(
                        case,
                        endpoint=endpoint,
                        api_key=api_key,
                        model=args.model,
                        secret=secret,
                    )
                )
        await subscribers.flush_async()
        subscriber.force_flush()
    finally:
        subscribers.deregister(emitted_name)
        subscriber.deregister(subscriber_name)
        subscriber.shutdown()

    serialized_events = json.dumps(emitted_events, sort_keys=True)
    if secret in serialized_events or api_key in serialized_events:
        raise AssertionError("subscriber retained a synthetic secret or API key")
    for case in cases:
        events = [event for event in emitted_events if case.name in event["name"]]
        if len(events) != 2:
            raise AssertionError(f"subscriber retained {len(events)} {case.name} events; expected start and end")
        start = next(event for event in events if event["scope_category"] == "start")
        end = next(event for event in events if event["scope_category"] == "end")
        if start["data"].get("headers") != {} or "[REDACTED]" not in json.dumps(start["data"]):
            raise AssertionError(f"{case.name}: subscriber did not retain a redacted minimal request")
        output = end["data"]
        if case.output_key not in output or not set(output).issubset(case.output_keys):
            raise AssertionError(f"{case.name}: subscriber retained a non-minimal response projection")
        items = output[case.output_key]
        if isinstance(items, list) and len(items) != 1:
            raise AssertionError(f"{case.name}: subscriber retained multiple source response items")

    # Phoenix receives spans asynchronously. A unique project makes the polling
    # deterministic and leaves the trace set available for manual inspection.
    spans: list[dict[str, Any]] = []
    for _ in range(20):
        spans = phoenix_spans(args.phoenix_url, project)
        if len(spans) >= len(cases):
            break
        await asyncio.sleep(1)
    if len(spans) < len(cases):
        raise AssertionError(f"Phoenix received {len(spans)} spans; expected at least {len(cases)}")

    serialized_spans = json.dumps(spans, sort_keys=True)
    if secret in serialized_spans or api_key in serialized_spans:
        raise AssertionError("Phoenix retained a synthetic secret or API key")

    llm_spans = [
        span
        for span in spans
        if span.get("span_kind") == "LLM"
        or string_attribute(phoenix_attributes(span), "openinference.span.kind") == "LLM"
    ]
    if len(llm_spans) != len(cases):
        raise AssertionError(f"Phoenix retained {len(llm_spans)} LLM spans; expected {len(cases)}")
    for case in cases:
        matches = [span for span in llm_spans if case.name in str(span.get("name", ""))]
        if len(matches) != 1:
            raise AssertionError(f"Phoenix did not retain exactly one {case.name} LLM span")
        attributes = phoenix_attributes(matches[0])
        input_value = string_attribute(attributes, "input.value")
        output_value = string_attribute(attributes, "output.value")
        if input_value is None or output_value is None:
            raise AssertionError(f"{case.name}: Phoenix span is missing input.value or output.value")
        if "[REDACTED]" not in input_value:
            raise AssertionError(f"{case.name}: Phoenix input is not redacted")
        if output_value != "[REDACTED]":
            output = json.loads(output_value)
            if case.output_key not in output or not set(output).issubset(case.output_keys):
                raise AssertionError(f"{case.name}: Phoenix retained a non-minimal response projection")

    print(
        json.dumps(
            {
                "status": "passed",
                "project": project,
                "providers": results,
                "llm_span_count": len(llm_spans),
                "phoenix_traces_url": f"{args.phoenix_url.rstrip('/')}/projects/{quote(project, safe='')}/traces",
                "oci_genai": "not exposed by the configured Inference Hub OpenAPI document",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

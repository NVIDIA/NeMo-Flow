// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[test]
fn control_client_has_a_bounded_configuration() {
    control_client().expect("control client");
}

#[tokio::test]
async fn default_port_process_origins_reach_handshake_transport_for_mcp_and_worker() {
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    // An explicit local proxy captures both HTTP requests and HTTPS CONNECT attempts without
    // binding privileged ports, requiring external DNS, or contacting a real daemon.
    let app = Router::new().fallback({
        let requests = Arc::clone(&requests);
        move || {
            requests.fetch_add(1, Ordering::SeqCst);
            async { StatusCode::BAD_GATEWAY }
        }
    });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let identity = MachineIdentity::generate().unwrap().identity;
    for raw in ["http://127.0.0.1:80/", "https://relay.example:443/"] {
        let origin = crate::daemon::common::address::explicit_daemon_origin(raw).unwrap();
        for role in [ComponentRole::Mcp, ComponentRole::Worker] {
            let before = requests.load(Ordering::SeqCst);
            let result =
                begin_handshake(&client, &origin, role, &identity, "default-port-test", None).await;
            assert!(matches!(
                result,
                Err(CliError::Upstream(_) | CliError::Launch(_))
            ));
            assert_eq!(requests.load(Ordering::SeqCst), before + 1);
        }
    }
    server.abort();
}

#[tokio::test]
async fn rejects_an_oversized_control_response_without_collecting_it() {
    let second_polled = Arc::new(AtomicBool::new(false));
    let endpoint_flag = Arc::clone(&second_polled);
    let chunks = futures_util::stream::iter([
        Ok::<_, Infallible>(Bytes::from(vec![b'a'; MAX_CONTROL_RESPONSE_BYTES + 1])),
        Ok(Bytes::from_static(b"b")),
    ])
    .inspect(move |item| {
        if item.as_ref().is_ok_and(|bytes| bytes.as_ref() == b"b") {
            endpoint_flag.store(true, Ordering::Release);
        }
    });
    let result = read_bounded_control_chunks(chunks, 0, |never| match never {}).await;

    let error = result.expect_err("oversized response must be rejected");
    assert!(
        error
            .error
            .to_string()
            .contains("daemon control response exceeded 262144 bytes")
    );
    assert!(!second_polled.load(Ordering::Acquire));
}

#[derive(Default)]
struct RetryState {
    json_bodies: Mutex<Vec<Bytes>>,
    empty_bodies: Mutex<Vec<Bytes>>,
}

#[tokio::test]
async fn idempotent_json_retry_reuses_the_exact_encoded_request() {
    async fn endpoint(State(state): State<Arc<RetryState>>, body: Bytes) -> Response {
        let attempt = {
            let mut bodies = state.json_bodies.lock().expect("json bodies");
            bodies.push(body);
            bodies.len()
        };
        if attempt == 1 {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Json(json!({"accepted": true})).into_response()
    }

    let state = Arc::new(RetryState::default());
    let origin = spawn(
        Router::new()
            .route("/control", post(endpoint))
            .with_state(Arc::clone(&state)),
    )
    .await;
    let result: Value = post_json_idempotent(
        &control_client().expect("client"),
        &format!("{origin}/control"),
        &json!({"sequence": 7, "request_id": "same"}),
        None,
        fast_retry_policy(),
    )
    .await
    .expect("transient response should be retried");

    assert_eq!(result, json!({"accepted": true}));
    let bodies = state.json_bodies.lock().expect("json bodies");
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
}

#[tokio::test]
async fn idempotent_empty_retry_reuses_the_exact_encoded_request() {
    async fn endpoint(State(state): State<Arc<RetryState>>, body: Bytes) -> StatusCode {
        let attempt = {
            let mut bodies = state.empty_bodies.lock().expect("empty bodies");
            bodies.push(body);
            bodies.len()
        };
        if attempt == 1 {
            StatusCode::BAD_GATEWAY
        } else {
            StatusCode::NO_CONTENT
        }
    }

    let state = Arc::new(RetryState::default());
    let origin = spawn(
        Router::new()
            .route("/control", post(endpoint))
            .with_state(Arc::clone(&state)),
    )
    .await;
    post_empty_idempotent(
        &control_client().expect("client"),
        &format!("{origin}/control"),
        &json!({"sequence": 8, "request_id": "same"}),
        fast_retry_policy(),
    )
    .await
    .expect("transient response should be retried");

    let bodies = state.empty_bodies.lock().expect("empty bodies");
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
}

#[tokio::test]
async fn control_response_failures_preserve_auth_status_and_json_context() {
    async fn invalid_json() -> Response {
        (StatusCode::OK, "not-json").into_response()
    }
    async fn unauthorized() -> Response {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": {"message": "bad session"}})),
        )
            .into_response()
    }
    async fn bad_request() -> Response {
        (StatusCode::BAD_REQUEST, "opaque rejection").into_response()
    }
    async fn declared_oversized() -> Response {
        Response::new(Body::from(vec![b'x'; MAX_CONTROL_RESPONSE_BYTES + 1]))
    }
    let origin = spawn(
        Router::new()
            .route("/invalid-json", post(invalid_json))
            .route("/unauthorized", post(unauthorized))
            .route("/bad-request", post(bad_request))
            .route("/oversized", post(declared_oversized)),
    )
    .await;
    let client = control_client().unwrap();

    let invalid: Result<Value, _> =
        post_json(&client, &format!("{origin}/invalid-json"), &json!({}), None).await;
    assert!(
        invalid
            .unwrap_err()
            .to_string()
            .contains("invalid daemon control response")
    );

    let unauthorized: Result<Value, _> =
        post_json(&client, &format!("{origin}/unauthorized"), &json!({}), None).await;
    assert!(
        matches!(unauthorized, Err(CliError::Unauthorized(message)) if message == "bad session")
    );

    let bad_request: Result<Value, _> =
        post_json(&client, &format!("{origin}/bad-request"), &json!({}), None).await;
    assert!(bad_request.unwrap_err().to_string().contains("HTTP 400"));

    let oversized: Result<Value, _> =
        post_json(&client, &format!("{origin}/oversized"), &json!({}), None).await;
    assert!(
        oversized
            .unwrap_err()
            .to_string()
            .contains("exceeded 262144 bytes")
    );

    let unauthorized = post_empty_idempotent(
        &client,
        &format!("{origin}/unauthorized"),
        &json!({}),
        fast_retry_policy(),
    )
    .await;
    assert!(matches!(unauthorized, Err(CliError::Unauthorized(_))));
}

#[tokio::test(start_paused = true)]
async fn bounded_control_retry_stops_on_permanent_error_and_total_deadline() {
    let permanent: Result<(), _> = retry_control(fast_retry_policy(), || async {
        Err(ControlAttemptError::permanent(CliError::Config(
            "permanent".into(),
        )))
    })
    .await;
    assert!(matches!(permanent, Err(CliError::Config(message)) if message == "permanent"));

    let timed_out: Result<(), _> = retry_control(
        ControlRetryPolicy::new(
            Duration::from_millis(5),
            Duration::from_millis(10),
            Duration::ZERO,
        ),
        std::future::pending,
    )
    .await;
    assert!(
        timed_out
            .unwrap_err()
            .to_string()
            .contains("attempt timed out")
    );
    assert!(is_transient_status(StatusCode::TOO_EARLY));
    assert!(!is_transient_status(StatusCode::BAD_REQUEST));
}

#[tokio::test(start_paused = true)]
async fn retry_control_honors_retry_after_and_caps_exponential_backoff() {
    let started = tokio::time::Instant::now();
    let mut attempts = 0;
    let value = retry_control(
        ControlRetryPolicy::new(
            Duration::from_secs(1),
            Duration::from_secs(10),
            Duration::from_millis(10),
        ),
        || {
            attempts += 1;
            async move {
                if attempts == 1 {
                    Err(
                        ControlAttemptError::transient(CliError::Launch("retry".into()))
                            .with_retry_after(Some(Duration::from_secs(2))),
                    )
                } else {
                    Ok(attempts)
                }
            }
        },
    )
    .await
    .expect("retry succeeds");
    assert_eq!(value, 2);
    assert_eq!(
        tokio::time::Instant::now() - started,
        Duration::from_secs(2)
    );

    assert_eq!(retry_backoff(Duration::ZERO, 10), Duration::ZERO);
    for attempt in 0..10 {
        let delay = retry_backoff(Duration::from_secs(1), attempt);
        assert!(delay >= Duration::from_millis(875));
        assert!(delay < Duration::from_millis(5_625));
    }
}

#[tokio::test]
async fn a_daemon_role_cannot_initiate_a_client_handshake() {
    let identity = MachineIdentity::generate().unwrap().identity;
    let result = begin_handshake(
        &control_client().unwrap(),
        "http://127.0.0.1:1",
        ComponentRole::Daemon,
        &identity,
        "daemon-client",
        None,
    )
    .await;
    let error = match result {
        Ok(_) => panic!("daemon role must be rejected before network I/O"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        CliError::Config(message) if message == "a daemon cannot initiate a daemon client handshake"
    ));
}

fn fast_retry_policy() -> ControlRetryPolicy {
    ControlRetryPolicy::new(
        Duration::from_secs(1),
        Duration::from_secs(2),
        Duration::ZERO,
    )
}

async fn spawn(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("local address");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    format!("http://{address}")
}

// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use tokio::net::TcpListener;

#[test]
fn launch_directive_is_the_only_directive_with_a_worker_bootstrap() {
    assert!(WorkerBootstrap::from_directive(BrokerDirective::UsePassThrough).is_none());
    assert!(
        WorkerBootstrap::from_directive(BrokerDirective::WaitForWorker { retry_after_ms: 10 })
            .is_none()
    );
}

#[test]
fn activation_timeout_uses_the_mcp_monotonic_clock() {
    let started = tokio::time::Instant::now();
    assert!(!activation_timed_out(
        "activation",
        "activation",
        started,
        started + Duration::from_millis(ACTIVATION_LIFETIME_MS - 1),
    ));
    assert!(activation_timed_out(
        "activation",
        "activation",
        started,
        started + Duration::from_millis(ACTIVATION_LIFETIME_MS),
    ));
    assert!(!activation_timed_out(
        "replacement",
        "activation",
        started,
        started + Duration::from_millis(ACTIVATION_LIFETIME_MS),
    ));
}

#[test]
fn daemon_heartbeat_interval_must_leave_a_safe_lease_margin() {
    assert!(validate_heartbeat_interval(999).is_err());
    assert_eq!(
        validate_heartbeat_interval(1_000).expect("minimum interval"),
        Duration::from_secs(1)
    );
    assert_eq!(
        validate_heartbeat_interval(MCP_LEASE_MS / 3).expect("maximum interval"),
        Duration::from_secs(10)
    );
    assert!(validate_heartbeat_interval(MCP_LEASE_MS / 3 + 1).is_err());
    assert!(validate_heartbeat_interval(u64::MAX).is_err());
    assert_eq!(
        MCP_HEARTBEAT_INTERVAL_MS + HEARTBEAT_RETRY_WINDOW_MS + 5_000,
        MCP_LEASE_MS,
        "a full retry window must still leave five seconds before lease expiry"
    );
}

#[test]
fn prescribed_worker_network_accepts_host_or_ipv4_and_rejects_unsafe_values() {
    assert_eq!(
        parse_worker_network_overrides(Some("Worker.Example.com"), Some("9443"))
            .expect("hostname override"),
        (Some("worker.example.com".into()), Some(9443))
    );
    assert_eq!(
        parse_worker_network_overrides(Some("192.0.2.10"), None).expect("IPv4 override"),
        (Some("192.0.2.10".into()), None)
    );
    assert!(parse_worker_network_overrides(Some("0.0.0.0"), None).is_err());
    assert!(parse_worker_network_overrides(Some("[::1]"), None).is_err());
    assert!(parse_worker_network_overrides(Some("https://worker.example.com"), None).is_err());
    assert!(parse_worker_network_overrides(None, Some("0")).is_err());
}

#[tokio::test]
async fn loopback_daemon_uses_loopback_worker_network_and_environment_overrides() {
    let _environment = crate::test_support::EnvScope::set(&[
        (WORKER_ADVERTISE_ENV, None),
        (WORKER_PORT_ENV, None),
    ]);
    let hint = worker_network_hint("http://127.0.0.1:47632")
        .await
        .expect("loopback daemon network hint");
    assert_eq!(hint.advertised_host, "127.0.0.1");
    assert_eq!(hint.port, None);

    for origin in ["http://127.0.0.1:80", "https://127.0.0.1:443"] {
        let hint = worker_network_hint(origin)
            .await
            .expect("default-port network hint");
        assert_eq!(hint.advertised_host, "127.0.0.1");
        assert_eq!(hint.port, None);
    }

    drop(_environment);
    let _environment = crate::test_support::EnvScope::set(&[
        (
            WORKER_ADVERTISE_ENV,
            Some(std::ffi::OsStr::new("worker.example")),
        ),
        (WORKER_PORT_ENV, Some(std::ffi::OsStr::new("9443"))),
    ]);
    let hint = worker_network_hint("http://127.0.0.1:47632")
        .await
        .expect("explicit network hint");
    assert_eq!(hint.advertised_host, "worker.example");
    assert_eq!(hint.port, Some(9443));
}

#[cfg(unix)]
#[test]
fn worker_network_environment_requires_unicode() {
    use std::os::unix::ffi::OsStrExt;

    let _environment = crate::test_support::EnvScope::set(&[(
        WORKER_ADVERTISE_ENV,
        Some(std::ffi::OsStr::from_bytes(b"worker-\xff")),
    )]);
    assert!(optional_environment(WORKER_ADVERTISE_ENV).is_err());
}

#[tokio::test]
async fn ipv6_only_daemon_has_no_supported_worker_route() {
    let _environment = crate::test_support::EnvScope::set(&[
        (WORKER_ADVERTISE_ENV, None),
        (WORKER_PORT_ENV, None),
    ]);
    assert!(worker_network_hint("http://[::1]:47632").await.is_err());
}

#[tokio::test]
async fn remote_daemon_rejects_an_explicit_loopback_worker_advertisement() {
    let _environment = crate::test_support::EnvScope::set(&[
        (
            WORKER_ADVERTISE_ENV,
            Some(std::ffi::OsStr::new("127.0.0.1")),
        ),
        (WORKER_PORT_ENV, None),
    ]);
    let error = worker_network_hint("https://192.0.2.1:8443")
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("cannot be loopback for a remote daemon"),
        "unexpected network validation error: {error}"
    );
}

#[tokio::test]
async fn remote_daemon_derives_a_concrete_non_loopback_worker_advertisement() {
    let _environment = crate::test_support::EnvScope::set(&[
        (WORKER_ADVERTISE_ENV, None),
        (WORKER_PORT_ENV, Some(std::ffi::OsStr::new("9443"))),
    ]);
    let hint = match worker_network_hint("https://192.0.2.1:8443").await {
        Ok(hint) => hint,
        Err(CliError::Io(error))
            if matches!(
                error.kind(),
                std::io::ErrorKind::NetworkUnreachable | std::io::ErrorKind::HostUnreachable
            ) =>
        {
            return;
        }
        Err(error) => panic!("unexpected route derivation error: {error}"),
    };
    assert!(
        !hint
            .advertised_host
            .parse::<Ipv4Addr>()
            .unwrap()
            .is_loopback()
    );
    assert_eq!(hint.port, Some(9443));
}

#[test]
fn spawned_worker_explicitly_removes_the_public_route_credential() {
    let bootstrap = WorkerBootstrap {
        activation_id: "activation".into(),
        activation_token: SensitiveString::new("secret").expect("secret"),
        deadline_unix_ms: u64::MAX,
        bind_ip: Ipv4Addr::LOCALHOST,
        port: 0,
        advertise_address: None,
    };
    let command = worker_command(
        std::path::Path::new("nemo-relay"),
        "http://127.0.0.1:47632",
        &bootstrap,
    );
    assert!(
        command
            .as_std()
            .get_envs()
            .any(|(name, value)| { name == ROUTE_TOKEN_ENV && value.is_none() })
    );
}

#[test]
fn worker_command_keeps_only_documented_network_arguments() {
    let bootstrap = WorkerBootstrap {
        activation_id: "activation".into(),
        activation_token: SensitiveString::new("secret").expect("secret"),
        deadline_unix_ms: u64::MAX,
        bind_ip: Ipv4Addr::UNSPECIFIED,
        port: 9443,
        advertise_address: Some("worker.example".into()),
    };
    let origin = explicit_daemon_origin("https://daemon.example:443/").unwrap();
    let command = worker_command(std::path::Path::new("nemo-relay"), &origin, &bootstrap);
    let arguments = command
        .as_std()
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        arguments,
        [
            "daemon",
            "worker",
            "--daemon-address",
            "https://daemon.example:443",
            "--bind",
            "0.0.0.0",
            "--port",
            "9443",
            "--advertise-address",
            "worker.example",
        ]
    );
}

#[test]
fn re_registration_preserves_sequence_until_the_daemon_rotates_the_session() {
    let mut lease = test_lease("http://127.0.0.1:1".into());
    lease.sequence = 7;
    lease.pending_heartbeat = Some(
        SessionRequest::new(
            lease.session_id.clone(),
            lease.session_token.clone(),
            lease.sequence,
            EmptyPayload::default(),
        )
        .expect("pending heartbeat"),
    );
    let same_session = Registration {
        directive: BrokerDirective::UsePassThrough,
        session_token: lease.session_token.clone(),
        heartbeat_interval: Duration::from_secs(5),
    };
    apply_registration(&mut lease, &same_session);
    assert_eq!(lease.sequence, 7);
    assert!(lease.pending_heartbeat.is_some());

    let rotated = Registration {
        directive: BrokerDirective::UsePassThrough,
        session_token: SensitiveString::new("rotated-session").expect("rotated token"),
        heartbeat_interval: Duration::from_secs(4),
    };
    apply_registration(&mut lease, &rotated);
    assert_eq!(lease.sequence, 0);
    assert!(lease.pending_heartbeat.is_none());
}

#[derive(Default)]
struct RequestLog {
    bodies: Mutex<Vec<Bytes>>,
}

#[tokio::test]
async fn transient_heartbeat_failure_keeps_the_session_and_exact_request() {
    async fn heartbeat(State(log): State<Arc<RequestLog>>, body: Bytes) -> Response {
        let attempt = {
            let mut bodies = log.bodies.lock().expect("heartbeat bodies");
            bodies.push(body);
            bodies.len()
        };
        if attempt == 1 {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        Json(McpHeartbeatResponse {
            directive: Some(BrokerDirective::UsePassThrough),
        })
        .into_response()
    }

    let log = Arc::new(RequestLog::default());
    let origin = spawn(
        Router::new()
            .route(MCP_HEARTBEAT_PATH, post(heartbeat))
            .with_state(Arc::clone(&log)),
    )
    .await;
    let mut lease = test_lease(origin);
    let response = renew_lease_with(&mut lease, fast_retry_policy())
        .await
        .expect("brief daemon failure should not end the MCP lease");

    assert!(matches!(
        response.directive,
        Some(BrokerDirective::UsePassThrough)
    ));
    assert_eq!(lease.sequence, 1);
    assert!(lease.pending_heartbeat.is_none());
    let bodies = log.bodies.lock().expect("heartbeat bodies");
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
}

#[tokio::test]
async fn release_retries_the_same_session_request() {
    async fn release_handler(State(log): State<Arc<RequestLog>>, body: Bytes) -> StatusCode {
        let attempt = {
            let mut bodies = log.bodies.lock().expect("release bodies");
            bodies.push(body);
            bodies.len()
        };
        if attempt == 1 {
            StatusCode::BAD_GATEWAY
        } else {
            StatusCode::NO_CONTENT
        }
    }

    let log = Arc::new(RequestLog::default());
    let origin = spawn(
        Router::new()
            .route(
                super::super::common::control::MCP_RELEASE_PATH,
                post(release_handler),
            )
            .with_state(Arc::clone(&log)),
    )
    .await;
    let mut lease = test_lease(origin);
    release(&mut lease).await;

    assert_eq!(lease.sequence, 1);
    let bodies = log.bodies.lock().expect("release bodies");
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
}

#[tokio::test]
async fn release_settles_a_pending_heartbeat_before_releasing() {
    async fn heartbeat(State(log): State<Arc<RequestLog>>, body: Bytes) -> Response {
        log.bodies.lock().unwrap().push(body);
        Json(McpHeartbeatResponse { directive: None }).into_response()
    }
    async fn released(State(log): State<Arc<RequestLog>>, body: Bytes) -> StatusCode {
        log.bodies.lock().unwrap().push(body);
        StatusCode::NO_CONTENT
    }
    let log = Arc::new(RequestLog::default());
    let origin = spawn(
        Router::new()
            .route(MCP_HEARTBEAT_PATH, post(heartbeat))
            .route(
                super::super::common::control::MCP_RELEASE_PATH,
                post(released),
            )
            .with_state(Arc::clone(&log)),
    )
    .await;
    let mut lease = test_lease(origin);
    lease.sequence = 1;
    lease.pending_heartbeat = Some(
        SessionRequest::new(
            lease.session_id.clone(),
            lease.session_token.clone(),
            1,
            EmptyPayload::default(),
        )
        .unwrap(),
    );
    release(&mut lease).await;
    assert_eq!(lease.sequence, 2);
    assert!(lease.pending_heartbeat.is_none());
    assert_eq!(log.bodies.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn release_stops_when_a_pending_heartbeat_cannot_be_settled() {
    let origin = spawn(Router::new().route(
        MCP_HEARTBEAT_PATH,
        post(|| async { StatusCode::UNAUTHORIZED }),
    ))
    .await;
    let mut lease = test_lease(origin);
    lease.sequence = 1;
    lease.pending_heartbeat = Some(
        SessionRequest::new(
            lease.session_id.clone(),
            lease.session_token.clone(),
            1,
            EmptyPayload::default(),
        )
        .unwrap(),
    );
    release(&mut lease).await;
    assert_eq!(lease.sequence, 1);
    assert!(lease.pending_heartbeat.is_some());
}

#[tokio::test]
async fn activation_failure_is_reported_with_an_authenticated_session_request() {
    async fn failed(State(log): State<Arc<RequestLog>>, body: Bytes) -> StatusCode {
        log.bodies.lock().expect("failure bodies").push(body);
        StatusCode::NO_CONTENT
    }
    let log = Arc::new(RequestLog::default());
    let origin = spawn(
        Router::new()
            .route(MCP_ACTIVATION_FAILED_PATH, post(failed))
            .with_state(Arc::clone(&log)),
    )
    .await;
    let mut lease = test_lease(origin);
    report_activation_failed(
        &mut lease,
        "activation-id",
        &CliError::Launch("worker failed safely".into()),
    )
    .await
    .expect("activation failure report");
    assert_eq!(lease.sequence, 1);
    let bodies = log.bodies.lock().expect("failure bodies");
    assert_eq!(bodies.len(), 1);
    let value: serde_json::Value = serde_json::from_slice(&bodies[0]).unwrap();
    assert_eq!(value["payload"]["activation_id"], "activation-id");
    assert_eq!(
        value["payload"]["reason"],
        "launcher error: worker failed safely"
    );
}

#[tokio::test]
async fn mcp_control_sequence_exhaustion_fails_without_network_io() {
    let mut lease = test_lease("http://127.0.0.1:1".into());
    lease.sequence = u64::MAX;
    assert!(
        renew_lease_with(&mut lease, fast_retry_policy())
            .await
            .is_err()
    );
    release(&mut lease).await;
    assert_eq!(lease.sequence, u64::MAX);
}

#[tokio::test]
async fn ready_directives_complete_without_spawning_or_polling() {
    let mut lease = test_lease("http://127.0.0.1:1".into());
    make_route_ready(&mut lease, BrokerDirective::UsePassThrough)
        .await
        .unwrap();
    make_route_ready(
        &mut lease,
        BrokerDirective::ReuseWorker {
            endpoint: "http://127.0.0.1:2".into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test(start_paused = true)]
async fn waiting_for_a_worker_refreshes_registration_and_surfaces_daemon_failure() {
    let mut lease = test_lease("http://127.0.0.1:1".into());
    let error = make_route_ready(
        &mut lease,
        BrokerDirective::WaitForWorker { retry_after_ms: 1 },
    )
    .await
    .expect_err("unreachable daemon");
    assert!(matches!(error, CliError::Upstream(_)));
}

fn test_lease(daemon_origin: String) -> McpLease {
    McpLease {
        client: control_client().expect("client"),
        daemon_origin,
        route_credential: RouteCredential::parse(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
        )
        .expect("route credential"),
        identity: MachineIdentity::generate().expect("identity").identity,
        session_id: "mcp-test-session".into(),
        session_token: SensitiveString::new("session-secret").expect("session token"),
        heartbeat_interval: Duration::from_secs(10),
        sequence: 0,
        pending_heartbeat: None,
    }
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

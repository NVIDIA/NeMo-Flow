// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::daemon::common::control::WorkerNetworkHintProof;
use crate::daemon::common::{client::begin_handshake, socket::Client, state::RouteCredential};

async fn daemon(pass: bool) -> (Arc<DaemonState>, String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = super::super::tests::test_daemon_state_at(
        pass,
        "",
        GatewayConfig::default(),
        origin.clone(),
    );
    let app = super::router(state.clone())
        .layer(axum::middleware::from_fn(connection_info))
        .into_make_service_with_connect_info::<SocketInfo>();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (state, origin, task)
}
async fn mcp(
    client: &Client,
    origin: &str,
    identity: &MachineIdentity,
    id: &str,
) -> McpRegisterResponse {
    let credential =
        RouteCredential::parse(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([42; 32]))
            .unwrap();
    let handshake = begin_handshake(
        client,
        origin,
        ComponentRole::Mcp,
        identity,
        id,
        Some(credential.digest()),
    )
    .await
    .unwrap();
    let worker_network = WorkerNetworkHintProof::sign(
        WorkerNetworkHint::new("127.0.0.1", None).unwrap(),
        origin,
        id,
        &handshake.proof.transcript.challenge_id,
        &identity.fingerprint(),
        identity,
    )
    .unwrap();
    let response: McpRegisterResponse = client
        .request(Command::RegisterMcp {
            request: McpRegisterRequest {
                proof: handshake.proof.clone(),
                worker_network,
            },
            credential: SensitiveString::new(credential.expose()).unwrap(),
        })
        .await
        .unwrap();
    handshake
        .authenticate_daemon(&response.daemon_proof)
        .unwrap();
    response
}
async fn wait_disconnected(state: &DaemonState, role: ComponentRole, id: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if lock(&state.sockets.peers)
                .get(&key(role, id))
                .is_some_and(|p| p.sender.is_none())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn loopback_idle_session_survives_old_lease_deadlines_and_releases_explicitly() {
    let (state, origin, task) = daemon(true).await;
    let identity = MachineIdentity::generate().unwrap().identity;
    let client = Client::default();
    let registration = mcp(&client, &origin, &identity, "idle").await;
    let Event::Directive {
        request_id,
        directive,
    } = client.next().await.unwrap()
    else {
        panic!("expected directive")
    };
    assert_eq!(directive, BrokerDirective::UsePassThrough);
    client.acknowledge(request_id).await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(120)).await;
    assert!(
        lock(&state.sockets.peers)[&key(ComponentRole::Mcp, "idle")]
            .sender
            .is_some()
    );
    assert_eq!(
        lock(&state.mcp_sessions)["idle"].lease_expires_at_unix_ms,
        u64::MAX
    );
    tokio::time::resume();
    client
        .request::<()>(Command::Release(
            SessionRequest::new(
                "idle".into(),
                registration.session_token,
                1,
                EmptyPayload::default(),
            )
            .unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(
        state
            .registry
            .snapshot(identity.fingerprint())
            .unwrap()
            .reference_count,
        0
    );
    task.abort();
}
#[tokio::test]
async fn replacement_connection_fences_old_callbacks_and_grace_expires_once() {
    let (state, origin, task) = daemon(true).await;
    let identity = MachineIdentity::generate().unwrap().identity;
    let first = Client::default();
    mcp(&first, &origin, &identity, "reconnect").await;
    let old_generation = lock(&state.sockets.peers)[&key(ComponentRole::Mcp, "reconnect")]
        .generation
        .clone();
    let second = Client::default();
    mcp(&second, &origin, &identity, "reconnect").await;
    disconnected(
        state.clone(),
        ComponentRole::Mcp,
        "reconnect".into(),
        old_generation,
    )
    .await;
    assert!(
        lock(&state.sockets.peers)[&key(ComponentRole::Mcp, "reconnect")]
            .sender
            .is_some()
    );
    assert_eq!(
        state
            .registry
            .snapshot(identity.fingerprint())
            .unwrap()
            .reference_count,
        1
    );
    drop(first);
    drop(second);
    wait_disconnected(&state, ComponentRole::Mcp, "reconnect").await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(29)).await;
    assert_eq!(
        state
            .registry
            .snapshot(identity.fingerprint())
            .unwrap()
            .reference_count,
        1
    );
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        state
            .registry
            .snapshot(identity.fingerprint())
            .unwrap()
            .reference_count,
        0
    );
    task.abort();
}
#[tokio::test]
async fn worker_ready_is_pushed_recovery_reprobes_and_drain_survives_disconnect() {
    let (state, origin, task) = daemon(false).await;
    let identity = MachineIdentity::generate().unwrap().identity;
    let client = Client::default();
    let mcp_registration = mcp(&client, &origin, &identity, "owner").await;
    let crate::daemon::common::control::WorkerBootstrap {
        activation_id,
        activation_token,
        ..
    } = crate::daemon::common::control::WorkerBootstrap::from_directive(mcp_registration.directive)
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = Client::default();
    let handshake = begin_handshake(
        &worker,
        &origin,
        ComponentRole::Worker,
        &identity,
        "worker",
        None,
    )
    .await
    .unwrap();
    let registration: WorkerRegisterResponse = worker
        .request(Command::RegisterWorker(WorkerRegisterRequest {
            proof: handshake.proof,
            worker_id: "worker".into(),
            endpoint: endpoint.clone(),
            activation_id,
            activation_token,
            tls_root_certificate: None,
        }))
        .await
        .unwrap();
    let data = registration.data_token.clone();
    let probe_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = probe_count.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                WORKER_PROBE_PATH,
                axum::routing::get(move |headers: HeaderMap| {
                    let data = data.clone();
                    let count = count.clone();
                    async move {
                        assert_eq!(headers[WORKER_TOKEN_HEADER], data.expose());
                        count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        StatusCode::NO_CONTENT
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let ready = SessionRequest::new(
        "worker".into(),
        registration.session_token.clone(),
        1,
        WorkerReadyPayload {
            worker_id: "worker".into(),
        },
    )
    .unwrap();
    worker
        .request::<()>(Command::Ready(ready.clone()))
        .await
        .unwrap();
    worker.request::<()>(Command::Ready(ready)).await.unwrap();
    loop {
        if matches!(
            client.next().await.unwrap(),
            Event::Directive {
                directive: BrokerDirective::ReuseWorker { .. },
                ..
            }
        ) {
            break;
        }
    }
    let target = lock(&state.worker_sessions)["worker"]
        .pending_target
        .clone();
    drop(worker);
    wait_disconnected(&state, ComponentRole::Worker, "worker").await;
    assert!(!target.control_available());
    assert!(matches!(
        state
            .registry
            .current_directive(identity.fingerprint(), &McpSessionId::new("owner").unwrap())
            .unwrap(),
        BrokerDirective::WaitForWorker { .. }
    ));
    let restored = Client::default();
    let handshake = begin_handshake(
        &restored,
        &origin,
        ComponentRole::Worker,
        &identity,
        "worker",
        None,
    )
    .await
    .unwrap();
    let recovered: WorkerRegisterResponse = restored
        .request(Command::RecoverWorker(WorkerRecoverRequest {
            proof: handshake.proof,
            worker_id: "worker".into(),
            endpoint: endpoint.clone(),
            tls_root_certificate: None,
            generation_grant: registration.generation_grant.clone(),
        }))
        .await
        .unwrap();
    assert!(!target.control_available());
    restored
        .request::<()>(Command::Ready(
            SessionRequest::new(
                "worker".into(),
                recovered.session_token,
                1,
                WorkerReadyPayload {
                    worker_id: "worker".into(),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap();
    assert!(target.control_available());
    assert!(probe_count.load(std::sync::atomic::Ordering::Relaxed) >= 2);
    client
        .request::<()>(Command::Release(
            SessionRequest::new(
                "owner".into(),
                mcp_registration.session_token,
                1,
                EmptyPayload::default(),
            )
            .unwrap(),
        ))
        .await
        .unwrap();
    let event = restored.next().await.unwrap();
    assert!(matches!(event, Event::Drain { .. }));
    if let Event::Drain { request_id, .. } = event {
        restored.acknowledge(request_id).await.unwrap();
    }
    assert!(
        restored
            .request::<()>(Command::Ready(
                SessionRequest::new(
                    "worker".into(),
                    registration.session_token,
                    2,
                    WorkerReadyPayload {
                        worker_id: "worker".into()
                    }
                )
                .unwrap()
            ))
            .await
            .is_err()
    );
    drop(restored);
    wait_disconnected(&state, ComponentRole::Worker, "worker").await;
    let draining = Client::default();
    let handshake = begin_handshake(
        &draining,
        &origin,
        ComponentRole::Worker,
        &identity,
        "worker",
        None,
    )
    .await
    .unwrap();
    let _: WorkerRegisterResponse = draining
        .request(Command::RecoverWorker(WorkerRecoverRequest {
            proof: handshake.proof,
            worker_id: "worker".into(),
            endpoint,
            tls_root_certificate: None,
            generation_grant: registration.generation_grant,
        }))
        .await
        .unwrap();
    assert!(matches!(
        draining.pending_event().await,
        Some(Event::Drain { .. })
    ));
    assert!(!target.control_available());
    task.abort();
    server.abort();
}
#[tokio::test]
async fn unauthenticated_and_legacy_control_requests_are_rejected() {
    let (_state, origin, task) = daemon(true).await;
    let client = Client::default();
    client.connect(&origin, ComponentRole::Mcp).await.unwrap();
    assert!(matches!(
        client
            .request::<()>(Command::Acknowledge {
                request_id: "unknown".into()
            })
            .await,
        Err(CliError::Unauthorized(_))
    ));
    let response = reqwest::Client::new()
        .post(format!("{origin}/_nemo-relay/control/v1/mcp/heartbeat"))
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    task.abort();
}
#[tokio::test]
async fn slow_consumer_queue_is_bounded_and_cancels_connection() {
    let (sender, _receiver) = mpsc::channel(QUEUE_CAPACITY);
    let cancel = Arc::new(Notify::new());
    let mut peer = Peer {
        generation: "test".into(),
        sender: Some(sender),
        cancel: cancel.clone(),
        disconnected: None,
        ready: false,
        acknowledgments: HashMap::new(),
        last_acknowledged: None,
        drain: None,
    };
    for _ in 0..=QUEUE_CAPACITY {
        Hub::emit(
            &mut peer,
            Event::Directive {
                request_id: "event".into(),
                directive: BrokerDirective::UsePassThrough,
            },
        );
    }
    tokio::time::timeout(Duration::from_millis(100), cancel.notified())
        .await
        .unwrap();
}

type RawSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn raw_request(socket: &mut RawSocket, command: Command) -> serde_json::Value {
    use tokio_tungstenite::tungstenite::Message as Wire;
    let request = ControlRequest {
        request_id: uuid::Uuid::now_v7().to_string(),
        command,
    };
    socket
        .send(Wire::Text(serde_json::to_string(&request).unwrap().into()))
        .await
        .unwrap();
    loop {
        let Wire::Text(text) = socket.next().await.unwrap().unwrap() else {
            continue;
        };
        if let Event::Reply {
            request_id,
            status,
            payload,
        } = serde_json::from_str(&text).unwrap()
            && request_id == request.request_id
        {
            assert!((200..300).contains(&status));
            return payload;
        }
    }
}
async fn raw_mcp(origin: &str) -> RawSocket {
    use crate::daemon::common::control::{descriptor, fresh_nonce};
    use crate::daemon::common::protocol::HandshakeTranscript;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "{}{path}",
        origin.replacen("http", "ws", 1),
        path = crate::daemon::common::socket::MCP_SOCKET_PATH
    ))
    .await
    .unwrap();
    let identity = MachineIdentity::generate().unwrap().identity;
    let credential =
        RouteCredential::parse(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([42; 32]))
            .unwrap();
    let request = ChallengeRequest {
        initiator: descriptor(ComponentRole::Mcp),
        initiator_instance_id: "raw".into(),
        initiator_public_identity: identity.public_identity(),
        initiator_fingerprint: identity.fingerprint(),
        initiator_nonce: fresh_nonce().unwrap(),
    };
    let challenge: ChallengeResponse =
        serde_json::from_value(raw_request(&mut socket, Command::Challenge(request.clone())).await)
            .unwrap();
    let transcript = HandshakeTranscript {
        daemon_target: origin.into(),
        initiator: request.initiator,
        responder: challenge.daemon,
        initiator_instance_id: "raw".into(),
        responder_instance_id: challenge.daemon_instance_id,
        selected_protocol: crate::daemon::common::protocol::PROTOCOL_V2,
        initiator_public_identity: identity.public_identity(),
        responder_public_identity: challenge.daemon_public_identity,
        initiator_fingerprint: identity.fingerprint(),
        responder_fingerprint: challenge.daemon_fingerprint,
        challenge_id: challenge.challenge.id,
        initiator_nonce: request.initiator_nonce,
        responder_nonce: challenge.challenge.nonce,
        route_token_digest: Some(credential.digest()),
    };
    let proof = crate::daemon::common::control::RegistrationProof {
        initiator_proof: transcript.sign(ComponentRole::Mcp, &identity).unwrap(),
        transcript,
    };
    let worker_network = WorkerNetworkHintProof::sign(
        WorkerNetworkHint::new("127.0.0.1", None).unwrap(),
        origin,
        "raw",
        &proof.transcript.challenge_id,
        &identity.fingerprint(),
        &identity,
    )
    .unwrap();
    raw_request(
        &mut socket,
        Command::RegisterMcp {
            request: McpRegisterRequest {
                proof,
                worker_network,
            },
            credential: SensitiveString::new(credential.expose()).unwrap(),
        },
    )
    .await;
    // Drain the initial pushed directive before checking idle traffic.
    let tokio_tungstenite::tungstenite::Message::Text(text) = socket.next().await.unwrap().unwrap()
    else {
        panic!("expected directive")
    };
    let Event::Directive { request_id, .. } = serde_json::from_str(&text).unwrap() else {
        panic!("expected directive")
    };
    raw_request(&mut socket, Command::Acknowledge { request_id }).await;
    socket
}
#[tokio::test]
async fn loopback_socket_sends_no_periodic_frames() {
    let (state, origin, task) = daemon(true).await;
    let mut socket = raw_mcp(&origin).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(120)).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(1), socket.next())
            .await
            .is_err()
    );
    assert!(
        lock(&state.sockets.peers)[&key(ComponentRole::Mcp, "raw")]
            .sender
            .is_some()
    );
    task.abort();
}
#[tokio::test]
async fn remote_keepalive_requires_the_matching_pong() {
    use tokio_tungstenite::tungstenite::Message as Wire;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = super::super::tests::test_daemon_state_at(
        true,
        "",
        GatewayConfig::default(),
        origin.clone(),
    );
    let work = state.clone();
    let app = Router::new().route(crate::daemon::common::socket::MCP_SOCKET_PATH, axum::routing::get(move |ws: WebSocketUpgrade| {
        let state = work.clone();
        async move { ws.on_upgrade(move |socket| run(state, ComponentRole::Mcp, false, socket)) }
    }));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut socket = raw_mcp(&origin).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(30)).await;
    tokio::time::resume();
    // Receiving a ping queues Tungstenite's automatic pong, but does not flush it. Drop
    // the read future here and advance time without another socket operation.
    assert!(matches!(
        socket.next().await.unwrap().unwrap(),
        Wire::Ping(_)
    ));
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(11)).await;
    tokio::time::resume();
    wait_disconnected(&state, ComponentRole::Mcp, "raw").await;
    task.abort();
}
#[tokio::test]
async fn malformed_and_oversized_frames_close_the_socket_without_registering() {
    use tokio_tungstenite::tungstenite::Message as Wire;
    let (state, origin, task) = daemon(true).await;
    for text in [
        "not json".to_owned(),
        "x".repeat(MAX_CONTROL_BODY_BYTES + 1),
    ] {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "{}{path}",
            origin.replacen("http", "ws", 1),
            path = crate::daemon::common::socket::MCP_SOCKET_PATH
        ))
        .await
        .unwrap();
        let _ = socket.send(Wire::Text(text.into())).await;
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(!matches!(closed, Some(Ok(Wire::Text(_)))));
    }
    assert!(lock(&state.mcp_sessions).is_empty());
    task.abort();
}

#[tokio::test]
async fn restart_defers_replacement_until_the_generation_recovery_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let identity = MachineIdentity::generate().unwrap().identity;
    let mut state = super::super::tests::test_daemon_state_at(
        false,
        "",
        GatewayConfig::default(),
        origin.clone(),
    );
    state
        .active_worker_generations
        .publish(identity.fingerprint(), "prior-worker-generation")
        .unwrap();
    Arc::get_mut(&mut state).unwrap().sockets = Hub::restarting(HashMap::from([(
        identity.fingerprint(),
        "prior-worker-generation".into(),
    )]));
    recover_after_restart(state.clone());
    let app = super::router(state.clone())
        .layer(axum::middleware::from_fn(connection_info))
        .into_make_service_with_connect_info::<SocketInfo>();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = Client::default();
    let registration = mcp(&client, &origin, &identity, "restart").await;
    assert!(matches!(
        registration.directive,
        BrokerDirective::WaitForWorker { .. }
    ));
    let Event::Directive { request_id, .. } = client.next().await.unwrap() else {
        panic!("expected directive")
    };
    client.acknowledge(request_id).await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(state.sockets.deferred(identity.fingerprint()));
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    let event = tokio::time::timeout(Duration::from_secs(5), client.next())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        event,
        Event::Directive {
            directive: BrokerDirective::LaunchWorker { .. },
            ..
        }
    ));
    assert!(
        !state
            .active_worker_generations
            .matches(identity.fingerprint(), "prior-worker-generation")
            .unwrap()
    );
    task.abort();
}

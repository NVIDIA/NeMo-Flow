// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

#[tokio::test]
#[allow(
    clippy::result_large_err,
    reason = "Tungstenite fixes the upgrade callback error type"
)]
async fn secure_control_connects_without_a_preinstalled_crypto_provider() {
    const ORIGIN_ENV: &str = "NEMO_RELAY_TEST_FRESH_WSS_ORIGIN";
    if let Ok(origin) = std::env::var(ORIGIN_ENV) {
        assert!(rustls::crypto::CryptoProvider::get_default().is_none());
        for role in [ComponentRole::Mcp, ComponentRole::Worker] {
            Client::default().connect(&origin, role).await.unwrap();
        }
        return;
    }

    let certificate = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let certificate_path = temp.path().join("daemon.pem");
    std::fs::write(&certificate_path, certificate.cert.pem()).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![certificate.cert.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(certificate.key_pair.serialize_der().into()),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("https://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        for path in [MCP_SOCKET_PATH, WORKER_SOCKET_PATH] {
            let (stream, _) = listener.accept().await.unwrap();
            let stream = acceptor.accept(stream).await.unwrap();
            tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), path);
                    Ok(response)
                },
            )
            .await
            .unwrap();
        }
    });
    // Isolate the process-wide provider from other tests and trust only this fixture's CA.
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "daemon::common::socket::tests::secure_control_connects_without_a_preinstalled_crypto_provider",
                "--nocapture",
            ])
            .env(ORIGIN_ENV, origin)
            .env("SSL_CERT_FILE", certificate_path)
            .env("SSL_CERT_DIR", temp.path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("fresh WSS client timed out")
    .unwrap();
    assert!(
        output.status.success(),
        "fresh WSS client failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("both control roles must complete their WSS upgrade")
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn reconnect_attempts_are_bounded_by_one_monotonic_grace_window() {
    let started = tokio::time::Instant::now();
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let result: Result<(), CliError> = retry(|| {
        attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        async { Err(failure("unavailable")) }
    })
    .await;
    assert!(result.is_err());
    assert_eq!(started.elapsed(), GRACE);
    assert!((5..25).contains(&attempts.load(std::sync::atomic::Ordering::Relaxed)));
}

#[tokio::test(start_paused = true)]
async fn a_hung_reconnect_attempt_does_not_extend_grace() {
    let started = tokio::time::Instant::now();
    let result: Result<(), CliError> = retry(std::future::pending).await;
    assert!(result.is_err());
    assert_eq!(started.elapsed(), GRACE);
}

#[tokio::test]
async fn remote_cleartext_is_rejected_before_connecting() {
    for origin in ["http://192.0.2.1:80", "http://daemon.example:80"] {
        let error = Client::default()
            .connect(origin, ComponentRole::Mcp)
            .await
            .unwrap_err();
        assert!(
            matches!(error, CliError::Config(ref message) if message == "non-loopback daemon addresses must use https")
        );
    }
}

#[tokio::test(start_paused = true)]
async fn delayed_recovery_uses_only_the_remaining_grace() {
    let deadline = tokio::time::Instant::now() + GRACE;
    tokio::time::advance(Duration::from_secs(12)).await;
    let started = tokio::time::Instant::now();
    let result: Result<(), CliError> = retry_until(deadline, std::future::pending).await;
    assert!(result.is_err());
    assert_eq!(started.elapsed(), Duration::from_secs(18));
    let result: Result<(), CliError> = retry_until(deadline, || async {
        panic!("expired recovery must not start an attempt")
    })
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn queued_disconnect_keeps_its_original_recovery_deadline() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.send(Message::Close(None)).await.unwrap();
    });
    let client = Client::default();
    client.connect(&origin, ComponentRole::Mcp).await.unwrap();
    server.await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if client.0.lock().await.as_ref().unwrap().task.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let deadline = client.recovery_deadline().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(12)).await;
    assert!(client.next().await.is_err());
    assert_eq!(client.recovery_deadline().await, deadline);
}

// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

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

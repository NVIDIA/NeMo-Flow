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

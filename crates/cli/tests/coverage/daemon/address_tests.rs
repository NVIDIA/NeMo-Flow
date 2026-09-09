// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn daemon_target_requires_tls_away_from_loopback() {
    assert!(daemon_url("http://127.0.0.1:47632").is_ok());
    assert!(daemon_url("https://relay.example.com:443").is_ok());
    assert!(daemon_url("http://relay.example.com:47632").is_err());
    assert!(daemon_url("https://0.0.0.0:47632").is_err());
    assert!(daemon_url("https://[::]:47632").is_err());
    assert!(daemon_url("https://relay.example.com").is_err());
}

#[test]
fn worker_port_zero_is_implicit_only() {
    assert_eq!(
        worker_socket(Ipv4Addr::LOCALHOST, None).unwrap(),
        "127.0.0.1:0".parse().unwrap()
    );
    assert!(worker_socket(Ipv4Addr::LOCALHOST, Some(0)).is_err());
    assert!(worker_socket(Ipv4Addr::new(10, 0, 0, 1), None).is_err());
}

#[test]
fn process_origins_preserve_default_ports_across_revalidation() {
    for raw in [
        "https://relay.example.com:443/",
        "http://127.0.0.1:80/",
        "https://[::1]:443/",
        "https://relay.example.com:8443/",
    ] {
        let origin = explicit_daemon_origin(raw).unwrap();
        assert_eq!(origin, raw.trim_end_matches('/'));
        assert_eq!(explicit_daemon_origin(&origin).unwrap(), origin);
        assert!(daemon_url(&origin).is_ok());
    }
    assert!(explicit_daemon_origin("https://relay.example.com").is_err());
}

#[test]
fn unspecified_worker_requires_concrete_advertisement() {
    let local: SocketAddr = "0.0.0.0:43210".parse().unwrap();
    assert!(worker_advertised_address(local, None).is_err());
    assert_eq!(
        worker_advertised_address(local, Some("worker.example.com")).unwrap(),
        "worker.example.com:43210"
    );
    assert!(worker_advertised_address(local, Some("::")).is_err());
    for host in [
        "worker.internal:8443",
        "https://worker.internal",
        "worker/path",
        "user@host",
        "[::1]:8443",
        "-worker",
        "worker-",
        "valid.-worker",
        "worker-.valid",
        &"a".repeat(254),
    ] {
        assert!(
            worker_advertised_address(local, Some(host)).is_err(),
            "{host}"
        );
    }
    for host in ["2001:db8::1", "[2001:db8::1]"] {
        assert_eq!(
            worker_advertised_address(local, Some(host)).unwrap(),
            "[2001:db8::1]:43210"
        );
    }
}

#[test]
fn concrete_worker_bind_rejects_advertisement() {
    let local: SocketAddr = "127.0.0.1:43210".parse().unwrap();
    assert_eq!(
        worker_advertised_address(local, None).unwrap(),
        local.to_string()
    );
    assert!(worker_advertised_address(local, Some("worker.example.com")).is_err());
}

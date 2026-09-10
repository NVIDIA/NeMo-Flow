// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::agents::CodingAgent;
use crate::test_support::{EnvScope, PLUGIN_CONFIG_TEST_LOCK};

#[tokio::test]
async fn managed_integration_registry_round_trips_and_deduplicates_install_directories() {
    let _guard = PLUGIN_CONFIG_TEST_LOCK.lock().await;
    let config = tempfile::tempdir().unwrap();
    let install = tempfile::tempdir().unwrap();
    let _environment = EnvScope::set(&[("XDG_CONFIG_HOME", Some(config.path().as_os_str()))]);
    assert!(
        registered_install_dirs(CodingAgent::Codex)
            .unwrap()
            .is_empty()
    );
    register_managed_integration(CodingAgent::Codex, install.path()).unwrap();
    register_managed_integration(CodingAgent::Codex, install.path()).unwrap();
    assert_eq!(
        registered_install_dirs(CodingAgent::Codex).unwrap(),
        [install.path().canonicalize().unwrap()]
    );
    assert!(
        registered_install_dirs(CodingAgent::ClaudeCode)
            .unwrap()
            .is_empty()
    );
    unregister_managed_integration(CodingAgent::Codex, install.path()).unwrap();
    unregister_managed_integration(CodingAgent::Codex, install.path()).unwrap();
    assert!(
        registered_install_dirs(CodingAgent::Codex)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn malformed_managed_integration_registry_is_reported() {
    let _guard = PLUGIN_CONFIG_TEST_LOCK.lock().await;
    let config = tempfile::tempdir().unwrap();
    let _environment = EnvScope::set(&[("XDG_CONFIG_HOME", Some(config.path().as_os_str()))]);
    let path = managed_integrations_registry_path().unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"not-json").unwrap();
    assert!(read_managed_integrations_registry().is_err());
    assert!(registered_install_dirs(CodingAgent::Codex).is_err());
}

#[test]
fn persisted_state_must_match_the_selected_layout() {
    let directory = tempfile::tempdir().unwrap();
    let layout = PluginLayout::new(CodingAgent::Codex, directory.path());
    let valid = PluginState {
        marketplace_root: layout.marketplace_root.clone(),
        plugin_root: layout.plugin_root.clone(),
        host_plugin_removed: false,
        host_marketplace_removed: false,
        plugin_setup_installed: false,
        marker_absent_recovery: false,
    };
    layout.validate_persisted_state(&valid).unwrap();
    let invalid = PluginState {
        plugin_root: directory.path().join("outside"),
        ..valid
    };
    assert!(layout.validate_persisted_state(&invalid).is_err());
    assert!(!HostRegistrationProgress::default().any_added());
    assert!(
        HostRegistrationProgress {
            host_plugin_added: true,
            host_marketplace_added: false,
        }
        .any_added()
    );
}

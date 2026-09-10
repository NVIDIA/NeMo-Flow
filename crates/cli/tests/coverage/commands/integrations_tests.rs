// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn explicit_refresh_directory_targets_only_marketplace_hosts() {
    let directory = tempfile::tempdir().expect("temporary install directory");
    let targets = refresh_targets(Some(directory.path())).expect("refresh targets");
    assert_eq!(targets.len(), CodingAgent::MARKETPLACE_HOSTS.len());
    for (agent, install_dir) in targets {
        assert!(CodingAgent::MARKETPLACE_HOSTS.contains(&agent));
        assert_ne!(agent, CodingAgent::Pi);
        assert_eq!(install_dir, directory.path().canonicalize().unwrap());
    }
}

#[test]
fn missing_explicit_refresh_directory_is_preserved_for_diagnostics() {
    let directory = tempfile::tempdir().expect("temporary parent");
    let missing = directory.path().join("not-created");
    let targets = refresh_targets(Some(&missing)).expect("refresh targets");
    assert!(
        targets
            .iter()
            .all(|(_, install_dir)| install_dir == &missing)
    );
}

#[test]
fn dry_run_with_no_managed_install_is_a_successful_no_op() {
    let directory = tempfile::tempdir().expect("temporary install directory");
    let command = IntegrationsCommand {
        command: IntegrationsSubcommand::Refresh(RefreshCommand {
            install_dir: Some(directory.path().to_path_buf()),
            dry_run: true,
        }),
    };
    assert_eq!(execute(command).expect("refresh no-op"), ExitCode::SUCCESS);
}

#[test]
fn dry_run_attempts_every_persisted_target_without_mutating_invalid_state() {
    let directory = tempfile::tempdir().expect("temporary install directory");
    let state = crate::installation::marketplace::marketplace_state_path(
        CodingAgent::Codex,
        directory.path(),
    );
    std::fs::write(&state, b"not valid state").unwrap();
    let result = execute(IntegrationsCommand {
        command: IntegrationsSubcommand::Refresh(RefreshCommand {
            install_dir: Some(directory.path().to_path_buf()),
            dry_run: true,
        }),
    })
    .expect("dry-run refresh");
    assert_eq!(result, ExitCode::SUCCESS);
    assert_eq!(std::fs::read(state).unwrap(), b"not valid state");
}

#[test]
fn unmanaged_local_marketplace_artifacts_remain_untouched() {
    let directory = tempfile::tempdir().expect("temporary install directory");
    let (marketplace, _) = crate::installation::marketplace::marketplace_install_roots(
        CodingAgent::ClaudeCode,
        directory.path(),
    );
    std::fs::create_dir_all(marketplace).unwrap();
    assert_eq!(
        execute(IntegrationsCommand {
            command: IntegrationsSubcommand::Refresh(RefreshCommand {
                install_dir: Some(directory.path().to_path_buf()),
                dry_run: true,
            }),
        })
        .unwrap(),
        ExitCode::SUCCESS
    );
}

#[test]
fn implicit_refresh_targets_include_each_default_marketplace_host_once() {
    let directory = tempfile::tempdir().unwrap();
    let _environment = crate::test_support::EnvScope::set(&[
        ("XDG_CONFIG_HOME", Some(directory.path().as_os_str())),
        ("HOME", Some(directory.path().as_os_str())),
        ("USERPROFILE", Some(directory.path().as_os_str())),
    ]);
    let targets = refresh_targets(None).expect("implicit refresh targets");
    for agent in CodingAgent::MARKETPLACE_HOSTS {
        assert_eq!(
            targets.iter().filter(|(found, _)| *found == agent).count(),
            1
        );
    }
}

#[test]
fn implicit_refresh_targets_include_registered_nondefault_directories_once() {
    let config = tempfile::tempdir().unwrap();
    let install = tempfile::tempdir().unwrap();
    let _environment = crate::test_support::EnvScope::set(&[
        ("XDG_CONFIG_HOME", Some(config.path().as_os_str())),
        ("HOME", Some(config.path().as_os_str())),
        ("USERPROFILE", Some(config.path().as_os_str())),
    ]);
    crate::installation::marketplace::register_managed_integration(
        CodingAgent::Codex,
        install.path(),
    )
    .unwrap();

    let canonical = install.path().canonicalize().unwrap();
    let targets = refresh_targets(None).unwrap();
    assert_eq!(
        targets
            .iter()
            .filter(|(agent, directory)| {
                *agent == CodingAgent::Codex && directory == &canonical
            })
            .count(),
        1
    );
}

#[test]
fn refresh_processes_a_managed_marketplace_install_without_host_cli() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::installation::marketplace::marketplace_state_path(
        CodingAgent::ClaudeCode,
        directory.path(),
    );
    std::fs::write(state, b"managed-state-marker").unwrap();

    let mut installs = Vec::new();
    let result = refresh_with_installer(
        RefreshCommand {
            install_dir: Some(directory.path().to_path_buf()),
            dry_run: true,
        },
        |agent, request| {
            installs.push((agent, request));
            Ok(ExitCode::SUCCESS)
        },
    )
    .expect("dry-run refresh managed install");
    assert_eq!(result, ExitCode::SUCCESS);
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].0, CodingAgent::ClaudeCode);
    assert_eq!(
        installs[0].1.install_dir.as_deref(),
        Some(directory.path().canonicalize().unwrap().as_path())
    );
    assert!(installs[0].1.force);
    assert!(installs[0].1.dry_run);
    assert!(!installs[0].1.skip_doctor);
}

#[test]
fn refresh_attempts_every_managed_install_and_aggregates_installer_failures() {
    let directory = tempfile::tempdir().unwrap();
    for agent in CodingAgent::MARKETPLACE_HOSTS {
        let state =
            crate::installation::marketplace::marketplace_state_path(agent, directory.path());
        std::fs::write(state, b"managed-state-marker").unwrap();
    }

    let mut attempted = Vec::new();
    let error = refresh_with_installer(
        RefreshCommand {
            install_dir: Some(directory.path().to_path_buf()),
            dry_run: true,
        },
        |agent, _| {
            attempted.push(agent);
            match agent {
                CodingAgent::Codex => Ok(ExitCode::FAILURE),
                CodingAgent::ClaudeCode => Err(CliError::Install("host rejected refresh".into())),
                CodingAgent::Pi => unreachable!("Pi is not a marketplace host"),
            }
        },
    )
    .unwrap_err();

    assert_eq!(attempted, CodingAgent::MARKETPLACE_HOSTS);
    let message = error.to_string();
    assert!(message.contains("Codex"));
    assert!(message.contains("returned a nonzero status"));
    assert!(message.contains("Claude Code"));
    assert!(message.contains("host rejected refresh"));
}

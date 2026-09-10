// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::test_support::EnvScope;

#[tokio::test]
async fn config_execute_resets_the_whole_file_or_one_agent_block() {
    let directory = tempfile::tempdir().expect("config home");
    let _environment = EnvScope::set(&[
        ("HOME", Some(directory.path().as_os_str())),
        ("XDG_CONFIG_HOME", Some(directory.path().as_os_str())),
    ]);
    let config_dir = directory.path().join("nemo-relay");
    std::fs::create_dir_all(&config_dir).unwrap();
    let config = config_dir.join("config.toml");
    std::fs::write(
        &config,
        "[agents.codex]\ncommand = \"codex\"\n\n[agents.claude]\ncommand = \"claude\"\n",
    )
    .unwrap();
    let server = ServerArgs::default();

    let status = execute(
        ConfigCommand {
            command: None,
            agent: Some(AgentArg::Codex),
            reset: true,
        },
        &server,
    )
    .await
    .expect("agent reset");
    assert_eq!(status, ExitCode::SUCCESS);
    let remaining = std::fs::read_to_string(&config).unwrap();
    assert!(!remaining.contains("agents.codex"));
    assert!(remaining.contains("agents.claude"));

    let status = execute(
        ConfigCommand {
            command: None,
            agent: None,
            reset: true,
        },
        &server,
    )
    .await
    .expect("whole reset");
    assert_eq!(status, ExitCode::SUCCESS);
    assert!(!config.exists());
}

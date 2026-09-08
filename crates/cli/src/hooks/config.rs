// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Private, installer-owned configuration for generated coding-agent hooks.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::agents::CodingAgent;

use super::{GatewayMode, HookForwardRequest};

const HOOK_CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HookCommandConfig {
    version: u32,
    agent: String,
    gateway_url: String,
    generation_file: Option<PathBuf>,
    generation_token: Option<String>,
    forward_only: bool,
    transparent_run: bool,
    profile: Option<String>,
    session_metadata: Option<String>,
    gateway_mode: Option<GatewayMode>,
}

impl HookCommandConfig {
    pub(crate) fn persistent(
        agent: CodingAgent,
        gateway_url: impl Into<String>,
        generation_file: PathBuf,
        generation_token: impl Into<String>,
    ) -> Self {
        Self {
            version: HOOK_CONFIG_VERSION,
            agent: agent.as_arg().into(),
            gateway_url: gateway_url.into(),
            generation_file: Some(generation_file),
            generation_token: Some(generation_token.into()),
            forward_only: false,
            transparent_run: false,
            profile: None,
            session_metadata: None,
            gateway_mode: None,
        }
    }

    pub(crate) fn transparent(agent: CodingAgent, gateway_url: impl Into<String>) -> Self {
        Self {
            version: HOOK_CONFIG_VERSION,
            agent: agent.as_arg().into(),
            gateway_url: gateway_url.into(),
            generation_file: None,
            generation_token: None,
            forward_only: false,
            transparent_run: true,
            profile: None,
            session_metadata: None,
            gateway_mode: None,
        }
    }

    pub(crate) fn write(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("failed to serialize hook configuration: {error}"))?;
        crate::filesystem::atomic_write_private(path, &bytes)
    }

    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let bytes = read_private_hook_config(path).map_err(|error| {
            format!(
                "failed to read hook configuration {}: {error}",
                path.display()
            )
        })?;
        let config = serde_json::from_slice::<Self>(&bytes).map_err(|error| {
            format!(
                "failed to parse hook configuration {}: {error}",
                path.display()
            )
        })?;
        config.validate()?;
        Ok(config)
    }

    pub(crate) fn apply(self, request: &mut HookForwardRequest) -> Result<(), String> {
        if self.agent != request.agent.as_arg() {
            return Err(format!(
                "hook configuration is for {} but the command requested {}",
                self.agent,
                request.agent.as_arg()
            ));
        }
        if request.has_inline_configuration() || request.transparent_run != self.transparent_run {
            return Err(
                "--hook-config cannot be combined with inline hook configuration options".into(),
            );
        }
        request.gateway_url = Some(self.gateway_url);
        request.generation_file = self.generation_file;
        request.generation_token = self.generation_token;
        request.forward_only = self.forward_only;
        request.transparent_run = self.transparent_run;
        request.profile = self.profile;
        request.session_metadata = self.session_metadata;
        request.gateway_mode = self.gateway_mode;
        Ok(())
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != HOOK_CONFIG_VERSION {
            return Err(format!(
                "unsupported hook configuration version {}; expected {HOOK_CONFIG_VERSION}",
                self.version
            ));
        }
        if self.agent.trim().is_empty() || self.gateway_url.trim().is_empty() {
            return Err("hook configuration requires an agent and gateway URL".into());
        }
        if self.generation_file.is_some() != self.generation_token.is_some() {
            return Err("hook configuration must include both generation file and token".into());
        }
        if self.forward_only && (self.generation_file.is_some() || self.transparent_run) {
            return Err("forward-only hook configuration cannot include a generation fence or transparent mode".into());
        }
        if self.transparent_run && self.generation_file.is_some() {
            return Err("transparent hook configuration cannot include a generation fence".into());
        }
        Ok(())
    }
}

/// Reads a Relay-owned hook config without following a replacement symlink.
///
/// The configuration carries generation credentials or a process-private gateway URL. On Unix,
/// require an owner-only file and a current-user-owned, non-group/world-writable parent before
/// opening it with `O_NOFOLLOW`. The post-open metadata check closes the replacement race between
/// inspecting the path and reading its bytes.
#[cfg(unix)]
fn read_private_hook_config(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let expected_uid = unsafe { libc::geteuid() };
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o077 != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "hook configuration must be a current-user-owned owner-only regular file",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "hook configuration has no parent",
        )
    })?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir()
        || parent_metadata.uid() != expected_uid
        || parent_metadata.mode() & 0o022 != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "hook configuration parent must be current-user-owned and non-group/world-writable",
        ));
    }

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file()
        || opened.uid() != expected_uid
        || opened.mode() & 0o077 != 0
        || opened.dev() != metadata.dev()
        || opened.ino() != metadata.ino()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "hook configuration changed while it was opened",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(windows)]
fn read_private_hook_config(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    if !crate::filesystem::windows_path_is_private(path)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "hook configuration must have the Relay private owner/System access control list",
        ));
    }
    std::fs::read(path)
}

#[cfg(not(any(unix, windows)))]
fn read_private_hook_config(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    std::fs::read(path)
}

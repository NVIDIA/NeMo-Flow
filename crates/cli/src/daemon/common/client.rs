// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Signed authentication over the v2 control socket.
use super::address::daemon_url;
use super::control::{
    ChallengeRequest, ChallengeResponse, RegistrationProof, descriptor, fresh_nonce,
};
use super::identity::{MachineIdentity, TokenDigest};
use super::protocol::{ComponentRole, HandshakeTranscript};
use super::socket::{Client, Command};
use super::state::verify_or_store_daemon_pin;
use crate::error::CliError;
pub(crate) struct ClientHandshake {
    pub(crate) proof: RegistrationProof,
    daemon_origin: String,
}

impl ClientHandshake {
    /// Verifies the daemon's signature before TOFU-pinning its public identity.
    pub(crate) fn authenticate_daemon(
        &self,
        proof: &super::protocol::HandshakeProof,
    ) -> Result<(), CliError> {
        if proof.signer != ComponentRole::Daemon {
            return Err(CliError::Unauthorized(
                "daemon registration proof used the wrong role".into(),
            ));
        }
        self.proof
            .transcript
            .verify(proof)
            .map_err(|error| CliError::Unauthorized(error.to_string()))?;
        verify_or_store_daemon_pin(
            &self.daemon_origin,
            self.proof.transcript.responder_public_identity,
        )
    }
}

pub(crate) fn control_client() -> Result<Client, CliError> {
    Ok(Client::default())
}
pub(crate) async fn begin_handshake(
    client: &Client,
    daemon_address: &str,
    role: ComponentRole,
    identity: &MachineIdentity,
    instance_id: &str,
    route_token_digest: Option<TokenDigest>,
) -> Result<ClientHandshake, CliError> {
    if role == ComponentRole::Daemon {
        return Err(CliError::Config(
            "a daemon cannot initiate a daemon client handshake".into(),
        ));
    }
    // Keep the WebSocket/TLS connect future off the nested MCP startup stack. Windows
    // executable main threads have a smaller stack than the Rust test harness threads.
    Box::pin(client.connect(daemon_address, role)).await?;
    let daemon = daemon_url(daemon_address)?;
    let daemon_origin = daemon.as_str().trim_end_matches('/').to_owned();
    let initiator = descriptor(role);
    let initiator_nonce = fresh_nonce()?;
    let request = ChallengeRequest {
        initiator: initiator.clone(),
        initiator_instance_id: instance_id.to_owned(),
        initiator_public_identity: identity.public_identity(),
        initiator_fingerprint: identity.fingerprint(),
        initiator_nonce,
    };
    let challenge: ChallengeResponse = client.request(Command::Challenge(request.clone())).await?;
    challenge
        .daemon
        .validate()
        .map_err(|error| CliError::Unauthorized(error.to_string()))?;
    if challenge.daemon.role != ComponentRole::Daemon
        || challenge.daemon_public_identity.fingerprint() != challenge.daemon_fingerprint
        || challenge.daemon_instance_id.is_empty()
    {
        return Err(CliError::Unauthorized(
            "daemon returned an invalid service identity".into(),
        ));
    }
    challenge.verify_attestation(&request)?;
    // Authenticate and TOFU-pin the daemon before a subsequent registration request can disclose
    // the reusable route credential. First contact retains the normal limitations of TOFU.
    verify_or_store_daemon_pin(&daemon_origin, challenge.daemon_public_identity)?;
    let selected_protocol = initiator
        .protocol
        .negotiate(challenge.daemon.protocol)
        .map_err(|error| CliError::Unauthorized(error.to_string()))?;
    let transcript = HandshakeTranscript {
        daemon_target: daemon_origin.clone(),
        initiator,
        responder: challenge.daemon,
        initiator_instance_id: instance_id.to_owned(),
        responder_instance_id: challenge.daemon_instance_id,
        selected_protocol,
        initiator_public_identity: identity.public_identity(),
        responder_public_identity: challenge.daemon_public_identity,
        initiator_fingerprint: identity.fingerprint(),
        responder_fingerprint: challenge.daemon_fingerprint,
        challenge_id: challenge.challenge.id,
        initiator_nonce,
        responder_nonce: challenge.challenge.nonce,
        route_token_digest,
    };
    let initiator_proof = transcript
        .sign(role, identity)
        .map_err(|error| CliError::Unauthorized(error.to_string()))?;
    Ok(ClientHandshake {
        proof: RegistrationProof {
            transcript,
            initiator_proof,
        },
        daemon_origin,
    })
}

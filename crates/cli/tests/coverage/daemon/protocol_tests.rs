// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::daemon::common::control::fresh_nonce;
use crate::daemon::common::identity::{ChallengeRecord, TokenDigest};

fn sample_transcript() -> (HandshakeTranscript, MachineIdentity, MachineIdentity) {
    let initiator = MachineIdentity::generate().expect("initiator").identity;
    let responder = MachineIdentity::generate().expect("responder").identity;
    let challenge = ChallengeRecord::generate(10, 100)
        .expect("challenge")
        .challenge();
    (
        HandshakeTranscript {
            daemon_target: "https://relay.example:443".to_owned(),
            initiator: ComponentDescriptor::nemo_relay(
                ComponentRole::Mcp,
                ProtocolRange::default(),
                Capabilities::streaming_transport(),
                "0.9.0",
            ),
            responder: ComponentDescriptor::nemo_relay(
                ComponentRole::Daemon,
                ProtocolRange::default(),
                Capabilities::streaming_transport(),
                "2.0.0",
            ),
            initiator_instance_id: "mcp-1".to_owned(),
            responder_instance_id: "daemon-1".to_owned(),
            selected_protocol: PROTOCOL_V1,
            initiator_public_identity: initiator.public_identity(),
            responder_public_identity: responder.public_identity(),
            initiator_fingerprint: initiator.fingerprint(),
            responder_fingerprint: responder.fingerprint(),
            challenge_id: challenge.id,
            initiator_nonce: fresh_nonce().expect("initiator nonce"),
            responder_nonce: challenge.nonce,
            route_token_digest: Some(TokenDigest::from_token(b"token")),
        },
        initiator,
        responder,
    )
}

#[test]
fn negotiation_selects_highest_overlap_without_using_binary_version() {
    assert_eq!(
        ProtocolRange::new(1, 4)
            .expect("range")
            .negotiate(ProtocolRange::new(2, 3).expect("range")),
        Ok(3)
    );
    assert_eq!(
        ProtocolRange::new(1, 2)
            .expect("range")
            .negotiate(ProtocolRange::new(3, 4).expect("range")),
        Err(ProtocolError::NoProtocolOverlap)
    );
}

#[test]
fn capability_serialization_and_transcript_order_are_deterministic() {
    let first = Capabilities::new(["trailers", "http2", "http1"]).expect("capabilities");
    let second = Capabilities::new(["http1", "trailers", "http2"]).expect("capabilities");
    assert_eq!(first, second);
    assert_eq!(first.canonical_bytes(), second.canonical_bytes());
    assert!(first.contains("trailers"));
    assert!(first.includes(&Capabilities::new(["http1", "http2"]).expect("required")));
    let (mut transcript, _, _) = sample_transcript();
    transcript.initiator.capabilities = first.clone();
    transcript.responder.capabilities = second.clone();
    let mut reordered = transcript.clone();
    reordered.initiator.capabilities = second;
    reordered.responder.capabilities = first;
    assert_eq!(
        transcript.canonical_bytes().unwrap(),
        reordered.canonical_bytes().unwrap()
    );
}

#[test]
fn both_participants_sign_the_same_transcript() {
    let (transcript, initiator, responder) = sample_transcript();
    let initiator_proof = transcript
        .sign(ComponentRole::Mcp, &initiator)
        .expect("initiator proof");
    let responder_proof = transcript
        .sign(ComponentRole::Daemon, &responder)
        .expect("responder proof");
    transcript.verify(&initiator_proof).expect("initiator");
    transcript.verify(&responder_proof).expect("responder");
}

#[test]
fn any_signed_field_mutation_invalidates_the_proof() {
    let (transcript, initiator, _) = sample_transcript();
    let proof = transcript
        .sign(ComponentRole::Mcp, &initiator)
        .expect("proof");
    let assert_rejected = |changed: HandshakeTranscript, field: &str| {
        assert!(changed.verify(&proof).is_err(), "{field}");
    };
    macro_rules! reject_mutation {
        ($($field:ident).+, $value:expr) => {{
            let mut changed = transcript.clone();
            changed.$($field).+ = $value;
            assert_rejected(changed, stringify!($($field).+));
        }};
    }
    reject_mutation!(daemon_target, "https://other.example:443".into());
    reject_mutation!(initiator.service, "other".into());
    reject_mutation!(initiator.role, ComponentRole::Worker);
    reject_mutation!(initiator.protocol.minimum, 0);
    reject_mutation!(initiator.protocol.maximum, 2);
    reject_mutation!(
        initiator.capabilities,
        Capabilities::new(["different"]).unwrap()
    );
    reject_mutation!(initiator.binary_version, "other".into());
    reject_mutation!(responder.service, "other".into());
    reject_mutation!(responder.role, ComponentRole::Mcp);
    reject_mutation!(responder.protocol.minimum, 0);
    reject_mutation!(responder.protocol.maximum, 2);
    reject_mutation!(
        responder.capabilities,
        Capabilities::new(["different"]).unwrap()
    );
    reject_mutation!(responder.binary_version, "other".into());
    reject_mutation!(initiator_instance_id, "other".into());
    reject_mutation!(responder_instance_id, "other".into());
    reject_mutation!(selected_protocol, 2);
    reject_mutation!(
        initiator_public_identity,
        transcript.responder_public_identity
    );
    reject_mutation!(
        responder_public_identity,
        transcript.initiator_public_identity
    );
    reject_mutation!(initiator_fingerprint, transcript.responder_fingerprint);
    reject_mutation!(responder_fingerprint, transcript.initiator_fingerprint);
    reject_mutation!(
        challenge_id,
        ChallengeRecord::generate(10, 100).unwrap().challenge().id
    );
    reject_mutation!(initiator_nonce, transcript.responder_nonce);
    reject_mutation!(responder_nonce, transcript.initiator_nonce);
    reject_mutation!(route_token_digest, Some(TokenDigest::from_token(b"other")));
    reject_mutation!(route_token_digest, None);
}

#[test]
fn service_and_fingerprint_are_validated_before_signing() {
    let (mut wrong_service, initiator, _) = sample_transcript();
    wrong_service.initiator.service = "impostor".to_owned();
    assert_eq!(
        wrong_service.sign(ComponentRole::Mcp, &initiator),
        Err(ProtocolError::WrongService)
    );

    let (mut wrong_fingerprint, initiator, _) = sample_transcript();
    wrong_fingerprint.initiator_fingerprint = wrong_fingerprint.responder_fingerprint;
    assert_eq!(
        wrong_fingerprint.sign(ComponentRole::Mcp, &initiator),
        Err(ProtocolError::FingerprintMismatch)
    );
}

#[test]
fn descriptors_reject_oversized_untrusted_fields() {
    let oversized_capability = "a".repeat(129);
    assert!(Capabilities::new([oversized_capability]).is_err());
    let too_many = (0..65).map(|index| format!("capability-{index}"));
    assert!(Capabilities::new(too_many).is_err());

    let descriptor = ComponentDescriptor::nemo_relay(
        ComponentRole::Mcp,
        ProtocolRange::default(),
        Capabilities::streaming_transport(),
        "v".repeat(257),
    );
    assert_eq!(
        descriptor.validate(),
        Err(ProtocolError::BinaryVersionTooLong)
    );
}

#[test]
fn activation_token_is_redacted_from_debug_but_serialized() {
    let directive = WorkerLaunch {
        activation_id: "activation-1".to_owned(),
        activation_token: SensitiveString::new("secret-value").expect("token"),
        deadline_unix_ms: 100,
        bind_ip: Ipv4Addr::LOCALHOST,
        port: 0,
        advertise_address: None,
    }
    .into_directive();
    assert!(!format!("{directive:?}").contains("secret-value"));
    assert!(
        serde_json::to_string(&directive)
            .expect("serialize")
            .contains("secret-value")
    );
    assert!(serde_json::from_str::<SensitiveString>("\"\"").is_err());
}

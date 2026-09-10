// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn registration_exposes_scoped_digests_grant_interval_and_sequence_exhaustion() {
    let mut registration = test_registration("data-token", "session-token");
    assert_eq!(
        registration.data_token_digest(),
        TokenDigest::from_token(b"data-token")
    );
    assert_eq!(
        registration.session_token_digest(),
        TokenDigest::from_token(b"session-token")
    );
    assert_eq!(registration.generation_grant().worker_id, "worker-one");

    registration.next_sequence = u64::MAX;
    let error = registration
        .advance_sequence()
        .expect_err("sequence exhaustion must be fatal");
    assert!(error.to_string().contains("sequence was exhausted"));
}

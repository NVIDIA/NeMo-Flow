// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn backup_is_create_only_and_removal_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    assert_eq!(
        backup_path(&path),
        directory.path().join("settings.json.nemo-relay.bak")
    );
    assert_eq!(
        backup_path(&directory.path().join("settings")),
        directory.path().join("settings.nemo-relay.bak")
    );
    backup(&path).unwrap();
    assert!(!backup_path(&path).exists());

    std::fs::write(&path, b"original").unwrap();
    backup(&path).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    backup(&path).unwrap();
    assert_eq!(std::fs::read(backup_path(&path)).unwrap(), b"original");
    remove_backup(&path).unwrap();
    remove_backup(&path).unwrap();
}

#[test]
fn optional_snapshots_restore_existing_and_missing_files() {
    let directory = tempfile::tempdir().unwrap();
    let existing = directory.path().join("existing");
    std::fs::write(&existing, b"before").unwrap();
    let snapshot = snapshot_optional_file(&existing).unwrap();
    std::fs::write(&existing, b"after").unwrap();
    restore_file_snapshot(&snapshot).unwrap();
    assert_eq!(std::fs::read(&existing).unwrap(), b"before");

    let missing = directory.path().join("missing");
    let snapshot = snapshot_optional_file(&missing).unwrap();
    std::fs::write(&missing, b"created later").unwrap();
    restore_file_snapshot(&snapshot).unwrap();
    assert!(!missing.exists());
    restore_file_snapshot(&snapshot).unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_preserving_operations_update_targets_and_restore_links() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target");
    let link = directory.path().join("nested/link");
    std::fs::write(&target, b"initial").unwrap();
    ensure_symlink_path(&link, &target).unwrap();
    assert_eq!(std::fs::read_link(&link).unwrap(), target);

    atomic_write_preserving_symlink(&link, b"updated").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"updated");
    let snapshot = snapshot_optional_file(&link).unwrap();
    std::fs::remove_file(&link).unwrap();
    std::fs::write(&link, b"replacement file").unwrap();
    restore_file_snapshot(&snapshot).unwrap();
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"updated");

    remove_file_preserving_symlink(&link).unwrap();
    assert!(!target.exists());
    assert!(link.is_symlink());
    remove_file_preserving_symlink(&link).unwrap();
}

#[cfg(unix)]
#[test]
fn relative_symlink_chains_are_resolved_from_each_parent() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target");
    let middle = directory.path().join("middle");
    let link = directory.path().join("link");
    std::os::unix::fs::symlink("target", &middle).unwrap();
    std::os::unix::fs::symlink("middle", &link).unwrap();
    atomic_write_preserving_symlink(&link, b"chain").unwrap();
    assert_eq!(std::fs::read(target).unwrap(), b"chain");
}

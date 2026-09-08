---
name: draft-release-notes
description: Compare NeMo Relay release refs and draft the current documentation release-notes page from verified repository evidence. Do not use for GitHub Release bodies or ordinary feature documentation.
---

# Draft Release Notes

Draft the current documentation release-notes page from verified repository
evidence. Keep complete, PR-by-PR release history in GitHub Releases.

## Gather Evidence

Run the read-only helper with explicit release refs and the target minor version:

```bash
python3 .agents/skills/draft-release-notes/scripts/collect_release_evidence.py \
  --previous release/<previous-major>.<previous-minor> \
  --current HEAD \
  --version <major>.<minor>
```

The report verifies both refs, compares their release-notes trees, identifies
version text currently present in those pages, and groups commits into review
candidates. Treat the groups as an evidence index, not publication-ready copy.

## Workflow

1. Confirm the target release version from the release branch and package
   metadata. Preserve unrelated working-tree changes.
2. Run the helper. It reports an absent prior release-notes directory without
   failing, which is expected for early release branches.
3. Verify each candidate claim in the changed public docs, API types, command
   help, or source before including it. Prioritize breaking changes, migrations,
   user-visible features, and ongoing support limitations.
4. Update `docs/about-nemo-relay/release-notes/index.mdx` unless the release
   changes its route or navigation entry.
5. Preserve the page's current structure: release summary and highlights,
   compatibility or migration notes, known issues, previous-release link, and
   related topics. Use tables or callouts only when they improve the existing
   page.
6. Preserve MDX front matter and the JSX SPDX comment. State the full history
   is available in GitHub Releases; do not create a changelog or GitHub Release
   body from this skill.

## Validate

Run the helper for the target release and, when useful, an early branch without
release notes. Review public claims, then run:

```bash
git diff --check
just docs
```

Check product names, commands, package names, support claims, and links against
the current repository before handing off the draft.

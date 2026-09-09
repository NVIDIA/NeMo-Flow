---
name: review-doc-style
description: Review NeMo Relay documentation, examples, or public text for NVIDIA technical writing style, terminology, and repository accuracy. Do not use for ordinary implementation review.
license: Apache-2.0
---

# Review Documentation Style

Prioritize factual accuracy over copy polish. Confirm commands, package names,
APIs, paths, supported bindings, and public behavior against the current
repository before reporting style findings.

## Review Flow

1. Identify the changed documentation, examples, or public strings and any
   corresponding entry points such as `README.md`, `docs/index.yml`, or package
   READMEs.
2. Read `references/nvidia-style-guide.md` for the fast-path checklist and
   severity model.
3. Open only the focused reference that resolves an actual ambiguity:
   - `references/nvidia-style-technical-docs.md` for structure, procedures,
     examples, links, tables, UI text, or accessibility.
   - `references/nvidia-style-language-mechanics.md` for voice, grammar,
     punctuation, dates, numbers, units, or plain English.
   - `references/nvidia-style-brand-terminology.md` for NVIDIA and product
     names, trademarks, acronyms, legal copy, or SEO.
4. Verify MDX files use JSX delimiters for top-of-file SPDX comments.
5. Report findings in severity order with a file and line, reader impact, and a
   concrete rewrite or direction. Omit preference-only findings unless the user
   requested a deep copyedit.

If no issues are found, say so and identify any commands or examples that were
not executed.

## References

- `CONTRIBUTING.md`
- `references/nvidia-style-guide.md`
- Open only the focused NVIDIA style reference selected in step 3.

<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA Language and Mechanics Style

Open this file when a review turns on wording, grammar, punctuation, dates, numbers, units, or plain-English readability.

## Voice and Tone

NVIDIA writing should be professional, active, conversational, and engaging without becoming casual or imprecise.

For technical docs:

- Prefer active voice and present tense.
- Use plain English and short sentences.
- Use contractions when they make the sentence sound natural.
- Keep paragraphs short enough to scan.
- Avoid swearing, threats, insults, jokes, puns, and culture-specific idioms.
- Avoid marketing exaggeration and unsupported comparisons with third-party products.
- Preserve precise technical terms even when they are not plain-English words.

## Plain English Rules

Use these as high-signal review checks:

| Prefer | Avoid | Reason |
|---|---|---|
| `can` for possibility | `may` for possibility | Reserve `may` for permission. |
| `after` for temporal order | `once` for temporal order | `Once` can imply urgency or one-time action. |
| `refer to` for cross-references | `see` for cross-references | `Refer to` is clearer for accessibility and translation. |
| Short direct sentences | Long chained sentences | Short sentences are easier to translate and scan. |
| Specific verbs | Vague verbs such as "leverage" | Specific verbs reduce ambiguity. |

Avoid "please" in technical documentation unless the platform or audience expects a customer-service tone.

## Active and Passive Voice

Prefer active voice when the actor matters.

```text
Correct: The runtime records a start event.
Weak: A start event is recorded by the runtime.
```

Passive voice is acceptable when the actor is unknown, irrelevant, or less important than the action. It is also acceptable in programmer documentation when the object or result is the focus.

## Contractions

Use contractions to keep prose conversational when they sound natural.

```text
Correct: It's important to understand the runtime scope.
Stiff: It is important to understand the runtime scope.
```

Do not force contractions into formal legal copy, API references, or generated text where the surrounding style avoids them.

## Latinisms

Prefer simpler English for global readability:

| Avoid | Prefer |
|---|---|
| `e.g.` | `for example` or `such as` |
| `etc.` | `and so on` |
| `i.e.` | `that is` |
| `vs.` | `compared to` |
| `via` | `by`, `through`, or `using` |
| `vice versa` | `conversely` |

Exceptions: use industry-standard terms such as *in silico*, *in vitro*, and *in vivo* when they are the correct terms. Italicize them in running text.

## Relative Pronouns

Use `that` for essential clauses. Do not use commas.

```text
Correct: The software that you installed yesterday needs an update.
```

Use `which` for nonessential clauses. Use commas.

```text
Correct: The software, which was released last month, needs an update.
```

If the sentence keeps the same core meaning without the clause, use `which` with commas. If removing the clause changes the meaning, use `that`.

## Dates and Time

- Spell out months in body text.
- Abbreviate months only in tables, banners, or tight UI. Use `Jan.`, `Feb.`, `Aug.`, `Sept.`, `Oct.`, `Nov.`, and `Dec.`.
- Use clear dates such as `June 12, 2025`. Avoid numeric dates such as `6/12/2025`.
- Do not use ordinal dates.
- Capitalize days of the week. Avoid abbreviations unless space is limited.
- Use 12-hour time unless regional content requires another format.
- Include a space before `a.m.` or `p.m.`, such as `12:45 p.m. PT`.
- Use `ET` and `PT` for Eastern Time and Pacific Time when a time zone is needed.
- Avoid `24/7`; use wording such as "all day, every day" or "without downtime."

For time ranges in prose, prefer `from 12:30 to 1:00 p.m.`. In schedules or compact listings, an en dash without spaces is acceptable.

## Numbers

- Spell out whole numbers from zero through nine in body text.
- Use numerals for 10 or greater.
- Use numerals for specific values, parameters, versions, technical specifications, UI values, and time.
- Use commas in thousands, such as `1,397`.
- Do not start a sentence with a numeral. Rewrite the sentence or spell out the number.
- Spell out ordinals, such as `tenth`.
- If one item in a category needs a numeral, use numerals consistently for other items in that category.

Examples:

```text
Correct: This uses four nodes.
Correct: Set the timeout to 5 seconds.
Correct: More than 10 apps are included.
Incorrect: This uses 4 nodes.
Incorrect: 10 apps are included.
```

## Units and Symbols

- Be consistent. Do not mix spelled-out and abbreviated units in the same context.
- Include a space between the number and unit, such as `40 GB` or `30 mm`.
- Use `GB/s`, not `GBps` or `GB/second`.
- Use `%` for percent in text and tables.
- Spell out `plus` in prose. Use `+` only in tables, charts, formulas, code, or tight UI.
- Use `2D`, `3D`, `4K`, `8K`, `4G`, `5G`, and `6G` as standard technical terms.
- Use `px` for pixels when writing dimensions, such as `350x350 px`.

## Punctuation

- Use `and` instead of `&` except in names and titles that contain an ampersand.
- Use the Oxford comma in a list of three or more items.
- Use commas after introductory phrases when the sentence would otherwise be hard to parse.
- Use semicolons sparingly. Prefer two sentences or a list.
- Avoid exclamation marks in technical docs.
- Use parentheses sparingly in body copy and avoid them in headings.
- Use double quotation marks for quoted speech and most quoted terms.
- Put commas and periods inside closing quotation marks for U.S. style, except when the quoted text is a code string or literal value.
- End complete sentences with periods. Do not use terminal periods in headings or simple table cells unless the column contains complete sentences.
- Use forward slashes for Linux paths, GitHub repositories, and standard terms such as `read/write`. Avoid `and/or`.

## Brackets, Braces, Dashes, and Hyphens

- Use angle brackets for placeholders, such as `<username>`.
- Use curly braces only when they are part of code, formulas, or literal strings.
- Use square brackets for `.conf` stanzas or code when the syntax requires them.
- Use em dashes without spaces to set off parenthetical phrases when commas or parentheses are weaker.
- Use en dashes for numeric, date, and page ranges.
- Use hyphens for compound modifiers before nouns when needed for clarity, such as "command-line output."
- Do not hyphenate a compound when it functions as a noun, such as "the command line."

## Readability Watchlist

Use formal conjunctive adverbs sparingly in technical docs:

- Additionally
- Consequently
- Furthermore
- Hence
- Moreover
- Thus
- Undoubtedly
- Whilst

Do not flag these words automatically. Flag them only when the sentence becomes stiff, long, or harder to translate.

---
trigger: always_on
---
# Documentation Rule

Documentation must stay aligned with the actual project state. Update
`README.md`, `docs/requirements` files, skill instructions, and operational notes when a
change affects behavior, setup, architecture, security, or usage.

Markdown documents should include:

- clear purpose and scope;
- setup and usage instructions;
- architecture or workflow notes when relevant;
- security and operational constraints;
- concise changelog metadata when the document already follows that pattern.

Avoid vague claims, outdated examples, and undocumented behavior changes.

## Mandatory Headers, Badges, and Footers

All markdown documentation files (`.md`) in the project must include
visual headers, badges, and footers as described below. These elements
must be placed **after** any YAML frontmatter block and **before** the
first heading.

### Header (capsule-render)

Every document must start with a capsule-render header banner:

```markdown
![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=TITLE&fontSize=36&fontAlignY=35&animation=twinkling)
```

Replace `TITLE` with the document title (URL-encoded, `%20` for spaces).

### Badges

Immediately after the header, include the following badges:

```markdown
![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.PROJECT_SECTION)

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)
```

Replace `PROJECT_SECTION` with a unique identifier for the page, following
the pattern `RapportTecnologia.AgenticSpace.<module>_<filename>` (e.g.
`RapportTecnologia.AgenticSpace.smartcontracts_agent-registry`).

### Footer (capsule-render)

Every document must end with a capsule-render footer:

```markdown
![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
```

The footer must be the **last line** of the file, after the changelog or
any other closing section.

### Example Structure

```markdown
---
tags:
  - smartcontracts
  - example
---

![header](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Example&fontSize=36&fontAlignY=35&animation=twinkling)

![visitors](https://visitor-badge.laobi.icu/badge?page_id=RapportTecnologia.AgenticSpace.smartcontracts_example)
[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC_BY--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
![Language: Portuguese](https://img.shields.io/badge/Language-Portuguese-brightgreen.svg)
![Status](https://img.shields.io/badge/Status-Ongoing-yellow)
[![GitHub Issues](https://img.shields.io/github/issues/RapportTecnologia/AgenticSpace)](https://github.com/RapportTecnologia/AgenticSpace/issues)

# Example Title

...document content...

## Changelog

| Data | Versão | Descrição |
|---|---|---|
| 2025-07-12 | 0.1.0 | Documentação inicial |

![footer](https://capsule-render.vercel.app/api?type=waving&color=gradient&height=100&section=footer&animation=twinkling)
```

### Exceptions

- Files that are pure configuration or templates (e.g. `.github/`
  issue templates, PR templates) are exempt.
- Files under `node_modules/`, `artifacts/`, `cache/`, or similar
  generated directories are exempt.
- The `README.md` at the repository root may omit the visitor badge if
  it uses a different badge set, but must include the capsule-render
  header and footer.

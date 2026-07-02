# ResearchKit CLI

Public npm entry for ResearchKit. This repository is deliberately small: it provides the `research-kit` command wrapper, platform package metadata, Agent Skill instructions, and public examples. The deterministic quality gate lives in the private `researchkit-cli-core` repository.

## Local setup

Recommended local development layout:

```text
project/
  researchkit-cli/
  researchkit-cli-core/
```

Then run:

```bash
cd researchkit-cli
npm link
research-kit --help
```

The wrapper will auto-detect the sibling core repo. You can also point to the core explicitly:

```bash
export RESEARCHKIT_CORE_BIN=/absolute/path/to/researchkit-cli-core/bin/research-kit.js
# or: export RESEARCHKIT_CORE_BIN=/absolute/path/to/researchkit-cli-core/dist/research-kit-core.cjs
research-kit init --goal "写一份行业研究报告"
research-kit audit
```

## What this package includes

- `bin/research-kit.js`: thin wrapper that delegates to the private core executable JS entry or distribution bundle.
- `platform/packages.json`: metadata for future platform-specific binary packages.
- `skills/deep-research-report/SKILL.md`: Agent workflow for deep research reports, including subagent summary registration.
- `examples/basic/`: minimal usage notes and asset examples.

## Boundary

ResearchKit stage 1 outputs Markdown only. It does not directly call ReportKit, DocxKit, or ChartKit by default. PDF/DOCX/chart export commands are intentionally future optional capabilities.

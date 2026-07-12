# ResearchKit CLI

Public distribution repository for the ResearchKit CLI wrapper, Agent Skill, and Codex Plugin. The Agent researches and writes; the platform binary compiles and audits traceable research artifacts.

The public repository is `dztabel-happy/researchkit-cli`; npm packages use the `@dztabel/researchkit` namespace.

## Install the Plugin locally

From this checkout:

```bash
codex plugin marketplace add "$PWD"
codex plugin add researchkit@researchkit
```

The same installation is available through `/plugins` after the local marketplace is added.

## Install after publication

```bash
codex plugin marketplace add dztabel-happy/researchkit-cli
codex plugin add researchkit@researchkit
```

After the npm packages are published:

```bash
npm install --global @dztabel/researchkit
research-kit --help
```

The npm package selects one matching optional platform package. Supported targets are macOS arm64/x64, Linux x64, and Windows x64.

## Install only the Skill

For a repository-scoped Codex Skill:

```bash
mkdir -p .agents/skills
cp -R skills/deep-research-report .agents/skills/
```

Restart Codex if the Skill does not appear.

## Quick start

```bash
research-kit init --goal "写一份行业研究报告"
# Fill research assets and close build-result.json.next_actions[].
# After an independent reviewer confirms the critical evidence:
research-kit record-subagent \
  --role independent_evidence_review \
  --task-id sub_review_001 \
  --evidence-ids ev_001 \
  --result confirmed \
  --summary "The evidence and source snapshot support the claim."
# The CLI computes reviewed_input_sha256 and writes the review entity and evidence status.
research-kit build-md --merge-sections
# Select only key/material claims in research/claims.json, then bind their current citations.
research-kit record-subagent \
  --role claim_citation_review \
  --task-id sub_claim_review_001 \
  --claim-ids claim_001 \
  --result confirmed \
  --summary "The material claim and its mapped citations match the current source snapshots."
# Complete the section-level voice rewrite before registering it.
research-kit build-md --voice-pass --voice-notes "formal report voice pass complete"
research-kit build-md --from-draft
research-kit audit
# Show the audited final to the user and wait for explicit confirmation.
research-kit approve --by "<identity>"
research-kit finalize
research-kit pack --external
```

Research assets use schema `1.2.0`; the delivery manifest independently uses schema `1.1.0` and contract `0.2`. `claims.json` contains only selected key/material claims, never every sentence, but every `core_conclusion` evidence row must be covered by a same-question claim. `audit` validates recorded process and traceability; it does not certify absolute factual truth.

## Citation contract

Section prose cites evidence with stable tokens such as `[^ev_001]`. Compilation converts them to numbered footnotes such as `[^1]` in `final.md` and inline references such as `[1]` in `deliverables/report.md`. Bare `ev_*` identifiers are not valid prose.

## Local core development

Private-core and sibling fallbacks are disabled in normal consumer mode. Enable them explicitly:

```bash
export RESEARCHKIT_DEV_MODE=1
export RESEARCHKIT_CORE_BIN=/absolute/path/to/researchkit-cli-core/bin/research-kit.js
node bin/research-kit.js --help
```

## Release preflight

For local development, build, stage, and verify only the current host target:

```bash
node ../researchkit-cli-core/scripts/build-binary.js --out-dir /tmp/researchkit-core-build
node scripts/stage-release.js --artifacts /tmp/researchkit-core-build --output /tmp/researchkit-release --host-only
node scripts/release-preflight.js --stage /tmp/researchkit-release --host-only
```

Formal all-target build, native-host smoke, packaging, attestation, and npm publishing use this public repository's `.github/workflows/release.yml`. The workflow is manually dispatched from a public `v<version>` tag and requires the same `core_ref` tag. It resolves both tags to immutable commits, checks out the private core with the read-only `CORE_CHECKOUT_SSH_KEY`, builds on four public runners, and publishes platform packages before the root wrapper. `publish=false` performs the complete dry run; `publish=true` is idempotent for packages already on npm.

The public repository stores `CORE_CHECKOUT_SSH_KEY` and `NPM_TOKEN` as Actions secrets. The release workflow does not run private tests, print core files, or upload source. Private core bytes exist only in the temporary runner checkout; npm packages and uploaded release artifacts contain the verified native binaries, public wrapper, checksums, and release metadata. All npm package manifests declare `UNLICENSED`.

Before dispatch, run the full core test, evaluation, and ecosystem acceptance locally, then push matching tags in both repositories:

```bash
gh workflow run release.yml -R dztabel-happy/researchkit-cli --ref v0.1.0 \
  -f core_ref=v0.1.0 -f publish=false
gh workflow run release.yml -R dztabel-happy/researchkit-cli --ref v0.1.0 \
  -f core_ref=v0.1.0 -f publish=true
```

The private core workflow is a manual diagnostic sweep only and never publishes npm packages.

Preflight checks version lockstep, the exact `research-kit <version>` executable identity, source commits, every tar entry, executable modes, binary digests, every public root-package byte, SHA-256/SHA-512 package identities, and an isolated npm consumer install. A rerun skips an existing npm version only when its registry `dist.integrity` exactly matches the attested tarball.

## Boundary

Stage 1 produces Markdown and delivery metadata. ResearchKit records digest- and artifact-verified ReportKit `0.1.30+ / cli-contract 0.2` or DocxKit `0.1.55+ / cli-contract 0.2` exports; ChartKit remains an upstream chart-asset producer, and its `0.1.49+` layout manifest is passed through unchanged. ResearchKit does not perform research, model calls, or downstream export itself.

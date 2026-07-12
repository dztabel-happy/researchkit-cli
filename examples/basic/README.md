# Basic ResearchKit usage

```bash
research-kit init --goal "分析某行业 2026 年增长机会"
# Agent fills brief / plan / questions / sources / evidence / gaps / outline / sections.
# Section prose cites evidence as [^ev_001]; compilation emits final [^1] and delivery [1].
# When a research subagent is used, save its summary and run:
research-kit record-subagent --file research/subagents/sub_001.json
# Record each independent evidence review through the CLI, one question per command:
research-kit record-subagent \
  --role independent_evidence_review \
  --task-id sub_review_001 \
  --evidence-ids ev_001 \
  --result confirmed \
  --summary "The evidence and source snapshot support the claim."
# The CLI computes reviewed_input_sha256 and writes the review entity and evidence status.
research-kit build-md --merge-sections
# Select only key/material claims in research/claims.json, then bind their current citations:
research-kit record-subagent \
  --role claim_citation_review \
  --task-id claim_review_001 \
  --claim-ids claim_001 \
  --result confirmed \
  --summary "The material claim and mapped citations match the current source snapshots."
research-kit check-claims
# Complete the section-by-section voice rewrite before registering it.
research-kit build-md --voice-pass --voice-notes "formal report voice pass complete"
research-kit build-md --from-draft
research-kit audit
# Fix build-result.json.next_actions[] until audit passes, then show the final summary.
# Only after the user explicitly confirms:
research-kit approve --by "<identity>"
research-kit finalize
research-kit pack --external
```

A complete project must eventually include:

```text
research/mainline.md
research/manifest.json
research/build-result.json
research/clarification.json
research/brief.md
research/plan.md
research/questions.json
research/sources.json
research/evidence.json
research/claims.json
research/gaps.json
research/outline.md
research/sections/*.md
research/draft.md
research/final.md
research/deliverables/report.md
research/deliverables/delivery-manifest.json
```

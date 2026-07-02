# Basic ResearchKit usage

```bash
research-kit init --goal "分析某行业 2026 年增长机会"
# Agent fills brief / plan / questions / sources / evidence / gaps / outline / sections.
# When a subagent is used, save its summary and run:
research-kit record-subagent --file research/subagents/sub_001.json
research-kit audit
# Fix build-result.json.next_actions[] until audit passes.
research-kit build-md --merge-sections --from-draft --voice-pass
research-kit pack
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
research/gaps.json
research/outline.md
research/sections/*.md
research/draft.md
research/final.md
```

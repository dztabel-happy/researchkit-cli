---
name: deep-research-report
description: Use when the user asks for deep research, formal reports, industry or competitive analysis, policy or technical research, or a traceable Markdown report built from recorded sources and evidence.
---

# Deep Research Report

Use this skill when the user asks for deep research, formal reports, industry research, competitive analysis, policy research, business analysis, technical research, investment analysis, or when uploaded materials must become a traceable Markdown/PDF/DOCX-ready report.

## Core principle

ResearchKit is not an Agent Runtime. It does not browse, decide truth, or write the report by itself. The Agent performs research and writing; the CLI verifies that the process assets exist, references point to recorded sources, evidence can be traced to local cached material, gaps are closed, sections are covered, final Markdown is convertible, and user confirmation is requested before completion.

Never tell the user that `audit` means the content is absolutely true. `audit` means the delivery process and traceability gates passed.

## Resume protocol

At the beginning of every continuation or repair:

1. Read `research/mainline.md`.
2. Read `research/manifest.json`.
3. Read `research/build-result.json`.
4. Read only the files needed by the current stage.
5. Execute `build-result.json.next_actions[]`.
6. Run `research-kit audit` again.

Do not reread all raw materials unless the current next action specifically requires it.

## Standard loop

```text
while research-kit audit fails:
  read research/build-result.json
  execute build-result.json.next_actions[] exactly
  update the target files
  run research-kit audit again
```

Do not treat a passing audit as completion. Follow the completion lifecycle after the research loop closes.

## Completion lifecycle

Run these steps in order:

1. After the section-level voice rewrite is complete, run `research-kit build-md --merge-sections`.
2. Select every key/material claim into `research/claims.json`; do not catalog ordinary prose.
3. Record its independent citation review with `research-kit record-subagent --role claim_citation_review --claim-ids <ids> --result confirmed --summary "<review>"`, then run `research-kit check-claims`.
4. Bind the completed rewrite to the current draft with `research-kit build-md --voice-pass --voice-notes "<patterns handled>"`.
5. Compile the reviewable final and delivery Markdown with `research-kit build-md --from-draft`.
6. Run `research-kit audit` and resolve every blocking error.
7. Show the user a concise pre-completion summary containing:

- key conclusions;
- how open gaps were resolved;
- any warning that remains and why it is acceptable;
- any critical evidence that did not complete independent recheck, if present.

8. Wait until the user explicitly confirms the reviewed final.
9. Record that confirmation with `research-kit approve --by "<identity>"`.
10. Run `research-kit finalize` while the approved final digest is unchanged.

Run `research-kit pack --external` or downstream export only after finalization.

For an optional downstream export, use ReportKit `0.1.30+ / cli-contract 0.2` or DocxKit `0.1.55+ / cli-contract 0.2`. Invoke the exporter with absolute input and output paths, then pass its real build result and artifact to `research-kit record-export`; also pass the real QA result for DocxKit. ReportKit receipts trust `input_sha256`, treat echoed `input_path` as advisory, and use `qa-status=not_run`. DocxKit passed QA must include matching `docx_sha256` and `report_sha256`. ChartKit `0.1.49+` manifests may have different recommended and rendered widths; keep the sidecar beside the image and do not rewrite it.

## Workflow

### 1. Initialize

```bash
research-kit init --goal "<user goal>"
```

Fill:

- `research/mainline.md`
- `research/clarification.json`
- `research/brief.md`
- `research/plan.md`
- `research/questions.json`

`clarification.json` must include `target_language`, `report_type`, and `budget`. If `report_type=custom`, list custom modules in `plan.md`.

Each question's `done_criteria` is an array of `{ "id", "text" }` objects. IDs must be stable because gaps link to them through `affected_criteria`.

### 2. Source intake

Save every user file, web page, search result, private knowledge note, MCP document, or generated chart as a source in `research/sources.json`. For `web_page`, `search_result`, and `mcp_document`, cache raw text in `research/sources/` and set `cache_path`.

Never write a conclusion based only on memory.

### 3. Evidence ledger

Extract only evidence that supports or constrains a claim. Write it to `research/evidence.json` with:

- `source_id`
- `claim`
- `quote_or_summary`
- `evidence_form` as `quote` or `summary`
- `location`
- `confidence`
- `used_in`
- `question_id`
- `core_conclusion` — set `true` only on the evidence that carries the core conclusion of a question

Every high-priority question must have at least one `core_conclusion: true` evidence row; the CLI blocks final without it (`CORE_CONCLUSION_EVIDENCE_MISSING`). Only `core_conclusion` evidence and evidence attached to a critical gap require second-layer independent review. Do not mark every row `core_conclusion: true`; that multiplies review cost without adding trust.

Do not write or manually edit evidence `verification_method` / `verification_status` / `verified_by`, or review-entity `reviewed_input_sha256` / `source_ids` / `question_id`. After a separate reviewer returns its result and concise reason, record it through the CLI, one question per command:

```bash
research-kit record-subagent \
  --role independent_evidence_review \
  --task-id sub_review_001 \
  --evidence-ids ev_001,ev_002 \
  --result confirmed \
  --summary "The evidence and source snapshots support the reviewed claims."
```

Use `--result disputed` when the reviewer finds a conflict. The CLI computes `reviewed_input_sha256`, derives the source and question scope, writes `research/subagents/<task-id>.json`, and updates the matching evidence verification fields.

Run:

```bash
research-kit check-evidence
```

If a quote fails mechanical verification, return to the source cache and fix the quote or source.

If an independent review returns `disputed`, the CLI preserves that status across audits. Resolve the dispute through the gap loop, then run a new independent review and record its result through `record-subagent`.

### 4. Gap loop

Write every missing source, weak evidence, conflict, outdated item, missing data point, unclear definition, or unsupported claim into `research/gaps.json`.

Set `affected_criteria` only to stable done-criteria IDs owned by the gap's question. The CLI derives severity from valid criterion links, question priority, open rounds, and core-evidence conflicts; do not use the retired `affects_done_criteria` boolean.

Run:

```bash
research-kit check-gaps
```

The CLI recalculates severity. Do not rely on your own severity label. Open `critical` gaps block final delivery.


### 4.1 Subagent dispatch method

Use subagents only for bounded work: one subquestion, one source package, one company/policy object, fact checking, adversarial search, chart data cleanup, or a section draft.

The main Agent keeps ownership of the conclusion. A subagent returns a compact structured summary only; it must not return raw browsing logs, full PDF text, or unfiltered excerpts. Raw material belongs in `research/sources/`; usable claims belong in `research/evidence.json`; unresolved issues belong in `research/gaps.json`.

Required subagent summary shape:

```json
{
  "task_id": "sub_001",
  "question_id": "q_001",
  "summary": "核心发现",
  "confidence": "medium",
  "sources": [],
  "evidence": [],
  "source_ids": [],
  "evidence_ids": [],
  "gaps": [],
  "risks": [],
  "artifact_paths": [],
  "recommended_next": []
}
```

After receiving a summary, save it under `research/subagents/` and record the dispatch count:

```bash
research-kit record-subagent --file research/subagents/sub_001.json
```

This increments `manifest.subagent_dispatch_count`; `audit`, `status`, and `next` compare it with `clarification.json.budget.max_subagent_dispatches`. Do not manually lower the count to hide budget overrun.

Context-pollution rules:

- Subagent returns summary JSON, not process logs.
- Main Agent merges only selected source/evidence/gap rows into project assets.
- Main Agent reads `manifest`, `build-result`, and current-stage files each loop, not all raw materials.
- Long writing remains section-based; do not ask one subagent to write the whole final report.

### 5. Synthesis checkpoint: decompose before you outline

This is the step that turns collected evidence into a report structure. Never write the outline from a template or from memory of "what industry reports look like". The structure must be a projection of the question tree, and the question tree must be shaped by what the evidence actually shows.

Run:

```bash
research-kit map
```

It prints the question-tree × evidence density matrix. Then:

1. For every high-priority question, decompose it into `sub_questions` in `research/questions.json` — each sub-question is one independently answerable claim, with `target_headings` naming the H2/H3 headings that will answer it. The CLI blocks the outline stage (`QUESTION_NOT_DECOMPOSED`) if a high-priority question has no sub-questions.
2. Let evidence density decide the shape: a sub-question with rich, multi-source evidence deserves its own H2 (or several H3 blocks); a thin one goes back to the gap loop for more research, or gets folded into a sibling. Do not create headings you cannot fill with evidence.
3. Write down the report's central thesis in `research/mainline.md` (one sentence: what the whole report argues). Every chapter must serve it.

### 6. Outline and section writing

Write `research/outline.md` as the projection of the question tree:

- H1 = chapters (each gets one file in `research/sections/`);
- H2/H3 under a chapter = its internal structure, mostly coming from sub-question `target_headings` (the CLI checks `SUBQUESTION_HEADING_MISSING` / `OUTLINE_SUBHEADING_MISSING` both ways); structural headings (e.g. 口径说明) are allowed and simply show as unmapped warnings.

Each section file separates process metadata from deliverable prose:

```markdown
---
title: 市场规模与出货量测算
purpose: 给出 2025 实绩、2026 预期与长期预测区间，并说明口径冲突的取舍。
key_conclusions:
  - 2025 年全球出货 1.3 万台为可信基准。
  - 长期预测分歧近一倍，只能作方向参考。
storyline: 承接政策章的驱动判断，为竞争格局章提供总量基础。
evidence_ids: [ev_001, ev_002, ev_003]
limitations: 出货数据为第三方口径。
---

# 市场规模与出货量测算

## 2025 年实绩与口径

2025 年市场规模在统一口径下同比增长 12%[^ev_001]。

正文只写报告文字并包含 outline 声明的 H2/H3。只允许 `[^ev_001]` 这类稳定 evidence footnote token；不得出现其他裸 `ev_*` 或“章节目的/关键结论”标签。
```

The front-matter is stripped when `build-md` merges sections, so the deliverable contains zero scaffolding. Compilation maps stable source tokens such as `[^ev_001]` to numbered footnotes such as `[^1]` in `final.md` and inline references such as `[1]` in `deliverables/report.md`. The CLI blocks bare `ev_*` identifiers outside valid footnote tokens. `storyline` states what the chapter takes from the previous one and hands to the next — write it so the chapters read as one argument, not a bag of modules.

Do not produce one giant draft in a single pass. Keep long writing section-based.

### 7. Voice pass

Before final, run a dedicated de-AI-flavor rewrite pass. **Read `references/voice-pass-zh.md` in this skill directory and follow it as the execution standard.** In short:

- go section by section, never the whole draft in one pass;
- per section, sweep four layers: vocabulary (slogans, AI-tell phrases), sentence patterns (first/second/finally chains, negative parallelism, fake ranges), structure (bold inline-heading lists, dash abuse, emoji, generic upbeat endings), content (vague attribution, unevidenced claims, cliché openers);
- conclusion first, every judgment gets a boundary (condition, time window, metric), every deleted adjective is replaced by a number, date, or object;
- never fabricate facts during rewrite; keep every stable evidence footnote such as `[^ev_001]` and every `{{fig:*}}`/`{{tbl:*}}` label intact; if a sentence loses evidence support after rewriting, it is a gap, not a wording issue;
- after all sections, run `research-kit lint-style`: blocking style errors must reach zero; each remaining warning must be justifiable to the user.

Register voice pass only through `research-kit build-md --voice-pass --voice-notes "<patterns handled>"` after actually doing the rewrite. Writing `voice_pass: true` into `final.md` front-matter does nothing; the CLI ignores it.

### 8. Compile and audit

```bash
research-kit build-md --merge-sections
```

After the canonical draft exists, select every key/material claim—not ordinary prose—into `research/claims.json`. Each row uses a stable claim ID, exact canonical-body text, its normalized-text SHA-256, one `question_id`, mapped `evidence_ids`, and `materiality` (`key` or `material`). Every `core_conclusion: true` evidence row must be covered by a same-question claim. Do not use character offsets or hand-edit review fields.

Dispatch a separate citation reviewer, then record one question scope per command:

```bash
research-kit record-subagent \
  --role claim_citation_review \
  --task-id claim_review_001 \
  --claim-ids claim_001,claim_002 \
  --result confirmed \
  --summary "The current claim text, mapped citations, evidence, and source snapshots match."
research-kit check-claims
research-kit build-md --voice-pass --voice-notes "<patterns handled>"
research-kit build-md --from-draft
research-kit audit
```

After audit passes, return to the Completion lifecycle. Never approve or finalize before explicit confirmation.

### 9. Local revision after final

If the user asks to update a section, add evidence, or revise a judgment after final delivery, do not patch `final.md` directly. Use:

```bash
research-kit reopen --stage evidence --section <section-id> --reason "<why>"
```

Then rerun the affected stages and audit again. `final.md` versions must not be silently overwritten.

## Prohibitions

- Do not write a final report without saved sources.
- Do not conclude without `evidence.json`.
- Do not omit a key/material claim from `claims.json`, and do not turn it into a sentence-by-sentence ledger.
- Do not ignore `gaps.json`.
- Do not claim completion before `audit` passes.
- Do not run `approve` before the user explicitly confirms the audited final.
- Do not run `finalize` when the approved final digest has changed.
- Do not treat `audit` as factual truth certification.
- Do not pass raw private source text to downstream export or third-party APIs. Use `research-kit pack --external` for a shareable package; it includes only compiled delivery assets and excludes raw source caches.
- When any `private_knowledge` source exists, sync the confidentiality level into `manifest.confidentiality`; the CLI blocks on `CONFIDENTIALITY_NOT_SYNCED` otherwise.
- Do not make ReportKit, DocxKit, or ChartKit do research or writing.

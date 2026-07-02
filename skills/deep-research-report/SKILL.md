# deep-research-report

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

When `audit` passes, show the user a concise pre-completion summary containing:

- key conclusions;
- how open gaps were resolved;
- any warning that remains and why it is acceptable;
- any critical evidence that did not complete independent recheck, if present.

Only after the user explicitly confirms, run `research-kit build-md --voice-pass` or the final requested packaging command.

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
- `verification_method`
- `verified_by`
- `verification_status`

Run:

```bash
research-kit check-evidence
```

If a quote fails mechanical verification, return to the source cache and fix the quote or source.

### 4. Gap loop

Write every missing source, weak evidence, conflict, outdated item, missing data point, unclear definition, or unsupported claim into `research/gaps.json`.

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

### 5. Outline and section writing

Write `research/outline.md`, then one Markdown file per first/second-level outline section in `research/sections/`.

Each section must include:

- section purpose;
- key conclusion;
- body argument;
- evidence IDs used;
- unresolved limitations when any exist.

Do not produce one giant draft in a single pass. Keep long writing section-based.

### 6. Voice pass

Before final, rewrite for formal report voice:

- conclusion first;
- fewer adjectives;
- more facts, boundaries, and evidence;
- no slogan-like expressions;
- no mechanical “first/second/finally” chain;
- concrete actions instead of “continue to optimize”.

### 7. Build and audit

```bash
research-kit build-md --merge-sections --from-draft
research-kit audit
```

If `audit` passes, ask the user for confirmation before marking completion.

### 8. Local revision after final

If the user asks to update a section, add evidence, or revise a judgment after final delivery, do not patch `final.md` directly. Use:

```bash
research-kit reopen --stage evidence --section <section-id> --reason "<why>"
```

Then rerun the affected stages and audit again. `final.md` versions must not be silently overwritten.

## Prohibitions

- Do not write a final report without saved sources.
- Do not conclude without `evidence.json`.
- Do not ignore `gaps.json`.
- Do not claim completion before `audit` passes.
- Do not treat `audit` as factual truth certification.
- Do not pass raw private source text to downstream export or third-party APIs when confidentiality is marked.
- Do not make ReportKit, DocxKit, or ChartKit do research or writing.

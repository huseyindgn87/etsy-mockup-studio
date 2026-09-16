@AGENTS.md

At the end of every session, update the "Project state" section of AGENTS.md
(and this file, if anything here changes) to reflect the verified current
state, and commit it. See "Keeping this file current" in AGENTS.md.

## Response rules

- Do the work first. No plan, no preamble, no narration.
- When done, reply with one line: what changed + what is next. No summary, no bullets, no file list unless asked.
- Give a detailed summary only if I ask for one.
- When a request is clear, reply "ok" and start. No acknowledgement paragraph.
- Never explain code that did not change. Never restate the request.
- Never re-describe project architecture, stack, or history. It is already known.
- Show only the modified hunks, never whole files, unless the file is new or under 40 lines.
- No summaries of tests that passed. Just: "837 tests pass" or the failures.
- If a decision is needed, ask in one sentence. No option menus.

## Scope rules

- Read only the files needed for the task. Do not scan the repo to "understand context".
- If the task names files, touch only those files.
- If the task does not name files, list the files you will open (max 6) and start. Do not ask.
- Do not refactor, rename, reformat or "improve" anything not asked for.
- Do not add comments explaining what the code does.



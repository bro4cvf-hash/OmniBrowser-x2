# Research, documents and applications

Reload OmniBrowser at `chrome://extensions`, reconnect the native bridge, and
reopen the sidebar after updating. Select a model that supports function tools.
Browser interaction works directly through the extension. Background research
and local document tools require the installed Python helper.

## Questions and follow-ups

The agent can call `request_user_input` to show one to three questions in the
chat. Each question supports up to six described choices (including Yes/No)
and a custom answer field. Missing contact details and other facts can use text
fields without suggested answers. Nothing is preselected. All questions require
an explicit answer before **Send answers** is enabled; there is no timeout that
chooses an answer for you. **Stop** interrupts a pending question without sending
an answer. Answered questions become original user messages, remain in saved
history, and qualify as sources for subsequent form filling.

You can also send a follow-up while a task is running. The agent receives it at
the next action boundary and reconsiders queued actions before continuing.
An action already dispatched may finish. A pending question still needs its
own answers or **Stop**. The runtime blocks later calls from the same model
response after receiving new input, so the model must plan again with your
answer or correction. It stops after three consecutive rounds of identical
failed calls rather than consuming the whole round allowance.

These patterns are adapted from the Codex CLI/app-server interaction model:
[structured user input and active-turn steering](https://learn.chatgpt.com/docs/app-server).
OmniBrowser still uses its configured model provider and its own agent loop;
this change does not launch Codex or use Codex account authentication.

Try a task like:

> Find three payment providers suitable for my business and apply using the
> documents in the LLC folder on my desktop. Track each provider and tell me
> which applications were submitted or need more information.

The assistant can discover your actual Desktop, Documents and Downloads paths,
including Windows folder redirection and OneDrive. Named folder discovery scans
direct children of these locations and explicitly enabled roots; it is bounded
and does not search the entire computer. Discovery returns folder metadata and
does not grant access to document contents. Ambiguous matches need clarification.

`search_web` searches through the background research service and `fetch_web`
reads public source excerpts. Independent searches run concurrently without
opening tabs, navigating existing tabs or moving browser focus. Service failures
return an error without a visible-browser fallback. Browser tabs are used when
interaction, login or an application form is needed.
The assistant follows real links, reads source documents, inspects application
fields across frames and open shadow roots, batches known field values, then
uses `form_verify` to compare expected values and native validation. Missing
company facts must come from the user rather than guesses.

For applications, the assistant must map contact and business details to source
documents or user statements. It must ask for missing required facts, including
the contact email and monthly volume; optional unknown fields stay blank.
Research and other known fields can continue while an application is blocked.

The sidebar also checks email addresses in text field edits before sending them
to the browser. An address must occur in a user message or the content of a
successfully extracted local document. Provider pages, generated replies,
checkpoint summaries and failed document reads do not qualify. A rejected edit
blocks later clicks on that tab until the field is corrected. Entire field batches
are checked before execution, including a `browser_step` final click. This check
establishes source presence, not ownership or suitability: the assistant must
still check whose email it is and resolve conflicting sources. Other business
facts and external MCP actions rely on the assistant's source-mapping instructions.

The task checklist and provider cards update as the assistant works and are
saved with chat history. Cards distinguish researched providers, forms ready
for review, confirmed submissions, blocked candidates and skipped candidates.
Statuses are reported by the model from observed pages, so the final summary
should include the evidence and source links.

Ask for forms to be prepared if you want to review them first. An explicit
request to apply authorizes submission; the selected access mode still governs
approval prompts. Only an explicit restriction such as **don't submit** or
**fill only** activates the submission hold, including in **Full access**.
The runtime checks the actual live control before clicking. Field focus, typing,
dropdown choices and intermediate **Continue**/**Next** steps stay available.
Final submission controls and Enter on a form input remain blocked. In a combined
fill-and-click step, the fields are filled and the final click is skipped for
review; the completed field edits are reported successfully. Read-only external
tools and unrelated external actions remain available; tools explicitly sending
or submitting an application are blocked while the hold is active.
The restriction survives **Continue**, reopening a chat and context compaction;
only a later explicit instruction such as **Submit it now** releases it. It cannot
cancel an action already dispatched or undo a completed submission. Page text,
local documents and generated replies cannot release it.

The assistant is instructed to verify before submitting and
look for confirmation afterwards. A successful click or field comparison alone
does not prove that a provider accepted an application. Binding terms, charges,
CAPTCHAs, passwords and payment entry require user involvement. File uploads
are exposed through the sidebar's `upload_files` tool and require the native
bridge plus access to the source folder. Attaching a file does not prove that
the destination accepted an application.

The sidebar and connection popup share an SVG orbital logo, with PNG variants
for Chrome's toolbar and extension list. Light and dark themes use one set of
semantic colors. Hover, press, entrance and working animations honor the system's
reduced-motion preference.

Validation without paid provider calls:

```powershell
node tests/test_sidebar_workflows.js
node tests/test_sidebar_contacts.js
node tests/test_submission_permission.js
node tests/test_sidebar_questions.js
.\.omnibrowser-venv\Scripts\python.exe -m pytest tests/test_sidebar_files.py -q
```

The optional `tests/test_sidebar_ui.js` uses Playwright and an installed Chrome
to check narrow layouts, themes, menus, task events, saved history and the real
form verifier. Set `NODE_PATH` to your Playwright package directory and
`CHROME_PATH` if Chrome is installed elsewhere. Screenshots are written to the
ignored `.omnibrowser` directory. All provider and application responses in these
UI checks are synthetic fixtures; no real application is submitted.
`tests/test_submission_permission_live.js` also checks field focus with CSS,
semantic selectors and refs, custom dropdowns, intermediate steps, combined field
entry and a held final click, embedded forms, and unrestricted submission against
a local fixture in real Chrome.

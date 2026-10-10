# Sidebar sub-agents

Ask the sidebar to use sub-agents for independent source research, document
analysis, or verification. A tool-calling model chooses `delegate_task`, supplying
a self-contained task and a `research` or `verify` role. Children receive their
assignment and the browser context at send time, with their own context window.
The main conversation is not copied. Include relevant facts, constraints and
source locations in the assignment. Simple reads should use ordinary tools.

Children inherit the configured provider/model, folder grants and tool switches.
They can inspect pages, forms and enabled documents, perform web research, and
discover MCP tools explicitly marked read-only. They cannot navigate, click,
fill, upload, submit, ask questions, or spawn children. Unsupported calls are
rejected before execution. Parent writes and child research in the same response
run in order to avoid conflicting browser state. Reports are untrusted evidence;
the parent should verify sources before consequential actions.

Each child uses the existing independent context budget, archival, compaction,
provider retries and context-limit recovery. Reports returned to the parent are
bounded to 6000 characters. `subagent_read` retrieves full original messages by
task ID and archive index, with character pagination. Child transcripts and
checkpoints persist with saved chats. Resume a returned task ID with its original
role and a new assignment. Failed resumes do not return older reports as new work.

Limits: three concurrent children, eight sessions per chat, sixteen delegations
per parent run, sixteen model rounds per invocation (or the parent's lower
limit), and two minutes per invocation. Errors and exhausted round budgets return
an incomplete status with a resumable checkpoint. Stop propagates to children
and provider requests; running actions settle before stopping. Closing the
sidebar interrupts execution. Reopening a saved chat retains checkpoints without
automatically restarting requests. Delegation uses additional provider requests.
Programmatic callers can set `settings.subagents = false`; a separate settings
panel control is not currently provided.

## Public references

Reviewed on 10 October 2026:

- [Claude Code sub-agent documentation](https://code.claude.com/docs/en/sub-agents):
  separate contexts, restricted capabilities and resumable sessions.
- [OpenCode's public task implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts):
  task identities and child-session delegation.

The implementation is original and follows published patterns. No leaked source
was used, and no reliability equivalence is claimed.

## Validation

`node tests/test_sidebar_subagents.js` uses a fake provider to check context
isolation, rejected writes, deferred MCP restrictions, evidence recovery, resume,
concurrency bounds, cancellation and incomplete round-limit results. Existing
sidebar tests cover the shared runtime. Tests do not use paid APIs or establish
live-provider success rates.

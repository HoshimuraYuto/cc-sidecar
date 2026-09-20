# cc-sidecar internals

[日本語](internals.ja.md)

This document explains how cc-sidecar works under the hood and the reasoning behind its design. For details on what it does and how to use it, see the [README](../README.md).

## Command rewrite

The flags added for each CLI are listed in the README. The hook runs the following full command:

```
mkdir -p <runs>; set -o pipefail; { <rewritten call> < /dev/null ; } 2>&1 | tee <log>; printf '{"type":"cc-sidecar.exit","code":%s}\n' "$?" >> <log>
```

where `<log>` is `<runs>/<tool_use_id>.jsonl` and `<runs>` is `$HOME/.cache/cc-sidecar/runs` (with `HOME` retrieved via `$.env.get`, or defaulting to `/tmp` if unset). A call made using `run_in_background` is structured differently:

```
mkdir -p <runs>; { <rewritten call> < /dev/null ; } > <log> 2>&1; printf '…exit…' >> <log>; <wait up to 10 s for <runs>/<tool_use_id>.answer>; cat <answer> || echo 'cc-sidecar: no answer was extracted; the log is <log>'
```

- `< /dev/null`: Without this, `codex exec` waits on stdin and hangs. The other two CLIs also append stdin to the `-p` input, so all three receive it.
- `tee`: This writes to the file that the pane monitors using `$.fs.read`.
- The trailing `printf`: This appends an exit record after the pipeline so that the end of the run can be detected from the log file alone. While a foreground call can also determine completion from the tool result, a **background call** relies solely on this record because its tool result is returned as soon as the shell is spawned. The pane keeps a background run active until this exit record appears. If a background shell is killed externally, it never writes this record, and the run remains marked as running.
- **background stdout**: The JSONL output is sent only to the log. When the tick loop detects the exit record, it writes the summary digest (described in the README's digest table) to `<tool_use_id>.answer` via `$.fs.write`. The background shell, which has been waiting for this file, then prints it. Consequently, the task output file that the model reads later contains the final answer instead of the JSONL log. If the plugin is removed before this occurs (due to being reloaded or unloaded), the wait times out after 10 s and outputs a one-line pointer to the log.

## Reading the JSONL

Each CLI outputs a different structure, so `absorb` branches based on `run.key`.

|        | Final answer                                      | Done when                     | Steps                      | Model                                                             |
| ------ | ------------------------------------------------- | ----------------------------- | -------------------------- | ----------------------------------------------------------------- |
| codex  | the last `agent_message`                          | `turn.completed`              | `item.completed`           | not emitted                                                       |
| claude | `result.result`                                   | `result` without `is_error`   | `assistant` content blocks | `system.model` → `assistant.message.model`                        |
| gemini | the assistant text immediately preceding `result` | `result.status === 'success'` | `tool_use`                 | `init.model` is `auto`; actual names are in `result.stats.models` |

Since codex does not specify its model name, the command's `-m` or `--model` flag is read instead. This fallback applies to all three CLIs and displays before any JSONL data arrives; however, an actual model name extracted from the JSONL will override it. gemini can use multiple models within a single run, which are represented joined by `/`.

In gemini, `message` events are **incremental** (`delta: true`) rather than cumulative, and must be concatenated. Any `message` with `role: 'user'` represents the echoed user prompt and is discarded.

The final answer for gemini consists only of the text accumulated immediately preceding `result`. Since a tool call flushes this text to the history, any preamble does not survive in the final answer.

## What the model reads

While the README describes what the model receives, two additional elements are omitted from the rewritten result, each for a specific reason.

Both `ref` and `text` are removed from the rewritten result. `ToolCallResult` specifies:

> A hook that returns the object it got makes core use them verbatim.

Therefore, leaving these elements in place would cause core to ignore the replacement.

The fields `persistedOutputPath`, `persistedOutputSize`, `rawOutputPath`, and `structuredContent` are discarded along with `stdout`. For large outputs, core moves the raw text to a file and includes the path in the result. Replacing `stdout` alone would leave behind the "output too large, saved to" notice and a link to the raw JSONL, causing the avoided content to reappear through a different channel. While codex never encounters this because its JSONL output remains below the threshold, claude did.

## Facts that shape the design

These facts are derived from the `/plugin-types` definitions and empirical measurements.

**A running tool's output cannot be read.** As specified in `ToolUse.output`:

> The stored result once the call has resolved; undefined while it runs.

`ToolResult` is by definition the final result, which necessitates the command rewrite described above.

**Pane repaints are irregular.** Repaint intervals were measured between 1 ms and 9.7 s. The elapsed time and the spinner are driven by a combination of `$.clock.every` and `$.ui.invalidate`, and the timer stops when no active run is displayed.

**`ui.render` outputs are cached.**

> once per input value (props, viewport width), plugin load or `$.ui.invalidate("ui.render")`

**A `command.run` hook alone does not register a command.** Typing `/cc-sidecar` for a module that only hooks `command.run` results in an "Unknown command" error. A command must be explicitly registered using `$.command.register`. This registration is performed during `session.start` and also lazily during the execution of the first hook after a hot reload, as `session.start` is not triggered again when a module is reloaded.

**The Escape key cannot be intercepted.** Under `ClientKeyEvent`, `Escape never arrives: it returns the focus`. The engine reserves this key to return keyboard focus to the prompt, so exiting the history requires using a `← back` button (bound to hotkey `b`).

## Constraints of a hooks module

The module runs without Node.js, meaning there is no access to `process` or `node:fs`; all external interactions must go through `$`. The `$` object can only be passed to functions declared at the top level of the file; passing it to a closure inside `register` causes `claude plugin validate` to reject the plugin.

Consequently, `Button.onPress` is left empty, and button presses are instead handled in the `ui.press` hook. This design is necessary because `onPress` is a closure within the render function and cannot access `$`, whereas a hook can legitimately receive `$` as a parameter.

## Promise

The engine's original drawing (`next(e)`) is always returned. If no activity is detected, or if reading props throws an error, the unmodified drawing passes through untouched. This ensures that the plugin never causes a ToolUse line to disappear.

## Testing

The `plugin test` command is not available without its corresponding flag. Because the test kit's `$` object lacks a `clock` property and does not provide anything under `tool.call` or `ui.render`, a test that requires an active call must mock `tool.call` to return a promise that is resolved later. Similarly, a test that requires the engine's drawing must mock `ui.render` with a stub.

Because screen layout positioning cannot be tested programmatically, you can simulate and inspect the output by running a session under `script` with `--debug-file` and a one-shot prompt, and then reading the captured output:

```sh
(sleep 100) | CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 timeout 75 script -q -c \
  "stty cols 228 rows 51; claude --debug-file /tmp/sidecar.log --plugin-dir . \
   --model sonnet --permission-mode auto --allowedTools Bash \
   'Use the Bash tool to run: claude -p \"Reply with ok\" --model haiku'" /dev/null > /tmp/sidecar.screen
```

Cursor movement sequences (`ESC[row;colH`) in the captured output indicate which line each fragment was drawn on, while `does not validate` in the log indicates that a rendered UI tree was rejected.

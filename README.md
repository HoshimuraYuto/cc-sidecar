# cc-sidecar

[日本語](docs/README.ja.md)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that monitors execution when Claude Code delegates work to another agent's CLI from Bash (`codex exec`, `claude -p`, `gemini -p`). Without this plugin, that delegation is just a plain shell command that runs silently until it finishes. With the plugin, the delegation becomes an **agent run** where you can see what the other agent is currently doing, what it has done, and which session to resume—while ensuring only its final answer goes back into Claude Code's context.

```
◆ Codex     ⠹ 0:23 · 4 steps · gpt-6-astra
  › $ rg --files -g '*.go' | wc -l
✦ Gemini    ✓ 0:41 · 6 steps · gemini-3.8-flash
  » 30 files.
```

## Install

Add the marketplace once, then install the plugin from it:

```
/plugin marketplace add HoshimuraYuto/cc-sidecar
/plugin install cc-sidecar@cc-sidecar
```

Function hooks are an early-access feature, so start Claude Code with the flag that enables them:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

The plugin has no runtime dependencies. The monitored CLIs (`codex`, `claude`, and `gemini`) must be available in your `PATH`.

## Configure

You can configure the `mode` option in `/config` or directly from the prompt:

```
/cc-sidecar          open the pane, print the mode and resumable sessions
/cc-sidecar hint     switch the mode (persisted through /config)
```

| Mode             | What happens                                                   |
| ---------------- | -------------------------------------------------------------- |
| `pane` (default) | A pane opens as soon as an agent CLI starts, and remains open. |
| `hint`           | The run is displayed on the prompt hint line with no pane.     |
| `both`           | Displays both the side pane and the hint line.                 |
| `off`            | Runs are still tracked, but nothing opens automatically.       |

This setting is stored in `settings.json` under `pluginConfigs`, keyed by the plugin ID: `cc-sidecar@cc-sidecar` when installed from the marketplace, or `cc-sidecar@inline` when running from a checkout with `--plugin-dir`.

```json
{
  "pluginConfigs": {
    "cc-sidecar@cc-sidecar": { "options": { "mode": "both" } }
  }
}
```

The `/cc-sidecar` command opens the pane in all modes, including `off`, keeping your history just a command away. If changing the configuration is rejected (for example, on an older Claude Code version or when a configuration row is locked), the plugin saves your preference in its local store and notifies you.

Manually closing the pane keeps it closed for the rest of the session, even in `pane` mode; you can bring it back at any time using `/cc-sidecar`. This prevents the pane from repeatedly reappearing after you have dismissed it.

## Why

There are three ways to run another agent from Claude Code.

| Route | Tools the other agent uses    | What you see while it runs                                                       |
| ----- | ----------------------------- | -------------------------------------------------------------------------------- |
| proxy | **Claude Code's tools**       | The execution loop is managed by Claude Code, so it is visible on screen.        |
| MCP   | its own, behind one tool call | Nothing is displayed until the run finishes and returns a single tool result.    |
| CLI   | **its own native tools**      | Nothing is displayed while running, and only the Bash output is shown when done. |

The CLI route lets the other agent use its native tools, but normally leaves you blind while it runs, and whatever the CLI prints to stdout lands in Claude Code's context when the command returns (which for `codex` is the entire execution transcript). This plugin fills the first gap and solves the second. It is designed for one-shot delegation, as a CLI call blocks until it completes, meaning there is no way to intervene mid-run anyway.

## Pane

The plugin interface consists of two screens: the list view and the run history.

### List

Displays the status glyph, agent, state, elapsed time, step count, and model, followed by the agent's current action. The second line is color-coded by event type: `»` for messages, `·` for reasoning (dimmed), and `›` for tool calls (cyan). This line wraps to a maximum of two lines before truncating with `…`; the complete text can be viewed in the history screen. Completed runs show a `✓` or `✕` and remain visible for 10 seconds before disappearing.

### History

Select the agent's name (by typing its corresponding digit when the pane has focus, or by clicking it) to view every step of that run, oldest first, with adjacent duplicates folded, showing up to the last 40 steps. The header displays the run state and model, followed by the exact command executed and the resume command for that CLI.

The run will not expire while you are viewing its history, and clicking `← back` (or pressing the hotkey `b`) resets the 10-second expiration timer from that point. This ensures active runs do not disappear while you are reading them.

## Hint line

In `hint` and `both` modes, active runs are displayed in the `PromptHint` row beneath the prompt footer:

```
⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
✳ Claude ⠹ 0:18 · 1 step · claude-haiku-4-5 › $ sleep 20
```

This line displays the agent, state, elapsed time, step count, and model, followed by the agent's current activity. If multiple runs are active, each gets its own row (oldest first) in the same order as they appear in the pane. The engine's own drawing (`next(e)`) is kept inside the last row: a tree that leaves it out is placed to the right of the mode label instead, with its second line starting at the label's width.

The subagent list (`● main` / `◯ general-purpose ...`) is displayed below the `PromptHint` area and is not a custom render target, which means CLI runs always appear above subagents regardless of the order in which they were started.

The plugin does not use: `$.ui.status` (which is drawn above the status line with a warning glyph and the plugin name in front), `ToolProgress` (a single indicator shared by all active calls and drawn under the last one), or `ToolUse` (since a Bash call folded into a `Running 1 shell command` group does not get its own row).

## Resuming

Although a CLI call executes in a single turn, the session ID is preserved in the JSONL logs, allowing you to resume a run even after its row has disappeared. The `/cc-sidecar` command displays the five most recent runs.

| CLI    | Resume                   | Where the id comes from                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| codex  | `codex exec resume <id>` | `thread_id`                                                                              |
| claude | `claude --resume <id>`   | `session_id`                                                                             |
| gemini | `gemini --resume latest` | `init.session_id` (resuming by ID is not supported; only latest or an index can be used) |

## Detection

The plugin detects `codex`, `gemini`, and `claude` by matching the command name. If you add another CLI to `AGENTS` in `hooks/hooks.tsx`, the plugin will track its detection and elapsed time, but rich content parsing is only supported for these three primary agents.

Commands like `cd x && FOO=1 codex exec ...` are successfully detected because each segment is scanned past its environment variable assignments to its first executable token, which is then matched by its basename.

For `codex`, global flags placed between `codex` and `exec` (such as `codex --search -m gpt-6-astra exec ...`) are supported.

Because only the **first token** of a command segment is analyzed, wrapping the call (for example, `timeout 240 codex exec ...`) will prevent detection.

Quoted strings are masked before the command is split, ensuring that prompts containing newlines or semicolons inside quotes do not interfere with detection. Heredoc bodies are also skipped to prevent false positives, such as detecting `codex` inside a block like `cat > f <<'EOF' ... codex ... EOF`.

## Command rewrite

The `tool.call` hook rewrites the Bash command to force the CLI to emit structured output.

| CLI    | Added                                   | Condition                       |
| ------ | --------------------------------------- | ------------------------------- |
| codex  | `--json`                                | the command is `codex exec`     |
| claude | `--output-format stream-json --verbose` | `-p` or `--print` is specified  |
| gemini | `--output-format stream-json`           | `-p` or `--prompt` is specified |

Because `claude` and `gemini` accept these flags at the end of the command, their calls are only rewritten **when the last command segment starts with that agent**. For example, a command like `claude -p ... ; echo done` is left unmodified.

Any command that already specifies an output format (such as `--output-format json`) or contains a pipe is left unmodified to avoid overriding your explicit choices. Unrewritten commands will still show detection and elapsed time, but without step-by-step content parsing.

For more details on the final structure of rewritten commands and the reasoning behind each flag, see [docs/internals.md](docs/internals.md#command-rewrite).

## What the model reads

When `--json` is enabled, the command's stdout consists entirely of JSONL data. If sent directly to the model, all execution details (including step-by-step reasoning, inner commands, and token usage) would flood back into the model's context, defeating the purpose of offloading the work to a sub-agent.

To prevent this, the `tool.call` hook intercepts and rewrites the return value of `next(e)`, replacing the entire `stdout` stream with only the final answer. This ensures the model receives the exact same clean text it would have without `--json`, while the detailed run history remains accessible in the UI pane and the JSONL log files. The parsing logic runs entirely within the hook runtime, meaning the raw execution stream never enters the model's context.

The stdout of every rewritten command is replaced by a **digest** of either success or failure, ensuring raw JSONL data never reaches the model:

| Run                                | Digest                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| finished, ok                       | The final answer, or the failure message if unavailable, or any non-JSON output lines.                                                                                               |
| finished, failed                   | The failure message (such as codex `error`/`turn.failed`, claude `result.is_error`, or gemini `result.status != success`), or the answer if available, or any non-JSON output lines. |
| not finished (interrupted, killed) | The failure message, or any non-JSON output lines, or the fallback message "The run ended before it produced an answer."                                                             |

Non-JSON lines include output written by the CLI outside the structured stream, such as a stack trace before a crash; the plugin retains the last 30 lines. Any unrewritten commands (such as those containing pipes or explicit output format flags) are returned completely untouched, just as the model would receive them without this plugin.

If the log file cannot be read, the plugin falls back to parsing the tool result's own `stdout`, which matches the output written by `tee` in the foreground.

For details on what else is excluded from the rewritten result and the reasoning behind it, see [docs/internals.md](docs/internals.md#what-the-model-reads).

## Known issues

**Claude Code's Bash sandbox.** When the sandbox is enabled, the shell cannot write to `$HOME`, preventing the log directory at `~/.cache/cc-sidecar/runs` from being created. As a result, the pane will show the run as `starting…` indefinitely, and background calls will fail with a "no answer was extracted" message instead of the actual answer. To fix this, run with the sandbox disabled or explicitly allow writes to that directory in your sandbox settings.

**Killed background shells.** Because the exit record is written by the shell itself, a background run killed by an external process will remain marked as running in the pane.

## Development

To run the plugin from a checkout instead of the marketplace, pass the directory to Claude Code; the plugin ID is then `cc-sidecar@inline`.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

Everything else goes through pnpm:

```sh
pnpm install          # dev dependencies and the lefthook git hooks
pnpm typecheck        # tsc against .claude/types/claude-code.d.ts
pnpm test             # claude plugin test, with the function-hooks flag set
pnpm format           # prettier over the whole tree
claude plugin validate .
```

`.claude/types/claude-code.d.ts` defines the plugin API as generated by the `/plugin-types` command in Claude Code. Avoid editing this file manually; instead, regenerate it using that command after updating Claude Code.

For information on how the test suite bypasses the kit's limitations and how to capture the screen during runs, refer to [docs/internals.md](docs/internals.md#testing).

### Commits and releases

Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification. Upon committing, lefthook automatically runs commitlint on the message and Prettier on staged files.

Every push to the `main` branch triggers [semantic-release](https://semantic-release.gitbook.io/): `feat` commits bump the minor version, `fix` and `perf` bump the patch version, and a `BREAKING CHANGE` footer triggers a major version bump. The release workflow automatically writes the new version to `.claude-plugin/plugin.json`, updates `CHANGELOG.md`, commits both files with the message `chore(release): x.y.z`, and publishes a GitHub release. No packages are published to npm.

## License

[MIT](LICENSE)

# laya-router

Automatic per-turn model routing for Claude Code. Laya sends simple work to the fast tier and
difficult work to the strong tier, while preserving Claude Code's native interface, tools,
sessions, permissions, and authentication — and it runs entirely on your own machine.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `laya-claude` | Claude Code | Existing `claude login` | Status line |

`laya-claude` launches the real Claude Code CLI. Laya only chooses the model for a fresh user turn.

## Quick start

Requires Node.js 20.12+, Python with `pip`, and [Claude Code](https://code.claude.com/docs/en/setup).

### 1. Install the classifier

```bash
pip install "laya[serve]"
```

You do not need to run `laya-serve` yourself — `laya-claude` starts it automatically on first
use and stops it when you exit, unless you're already running one (see [Configuration](#configuration)).

### 2. Install laya-router

```bash
npm install -g git+https://github.com/suradisworkspace/laya-router.git
```

Or from a local checkout:

```bash
git clone https://github.com/suradisworkspace/laya-router.git
cd laya-router
npm install
npm link
```

### 3. Run it

```bash
laya-claude
```

No signup, no API key, no cloud service — Laya runs locally and your prompts never leave the
machine. Every CLI argument is forwarded:

```bash
laya-claude --resume
laya-claude -p "fix the failing test"
```

For a local checkout, `npm link` installs the command. Without it, run `node bin/laya-claude.mjs`.

## Claude Code interface

`laya-claude` launches Claude Code with **Laya Router** selected in `/model`. Selecting another
model pauses routing; selecting **Laya Router** resumes it.

The injected status line shows the model used for the last turn:

```text
⚡ haiku p=0.91 · my-project · 8% context
⏸ manual Opus 4.6 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `LAYA_NO_STATUSLINE=1` to disable Laya's status line.

The explanation skill is bundled with the npm package and loaded automatically: run
`/laya-explain` in `laya-claude` to see the factors behind the last routing decision:

```text
┌─────────────────────────────────┐
│ Laya Router                     │
│                                 │
│ Laya request                    │
│ Prompt: explain the router      │
│ Current tier: HAIKU             │
│ Context tokens: 6200            │
│                                 │
│ Laya response                   │
│ Task complexity     0.82        │
│ Reasoning required  0.91        │
│ Tool complexity     0.64        │
│ Context size        0.31        │
│                                 │
│ Recommended tier: SONNET        │
│ Selected model: SONNET          │
│                                 │
│ Confidence: 94%                 │
│ Decision: Laya recommendation   │
└─────────────────────────────────┘
```

The report is rendered locally from the exact prompt, Laya request, and Laya response saved
when routing occurred. Recent decisions are retained per session; invoking the explanation
skill does not ask Laya to score the prompt again.

### Explanation data location

`laya-claude` keeps up to 20 recent routing exchanges in one JSON file per Claude Code session
under Node.js's operating-system temporary directory:

| Platform | Default location |
| --- | --- |
| Windows | `%TEMP%\laya-claude\<session-id>.json` |
| macOS | `$TMPDIR/laya-claude/<session-id>.json` (normally under `/var/folders/.../T`) |
| Ubuntu/Linux | `${TMPDIR:-/tmp}/laya-claude/<session-id>.json` |

Print the exact directory selected on the current machine with:

```bash
node -e "console.log(require('node:path').join(require('node:os').tmpdir(), 'laya-claude'))"
```

Filenames use Claude Code's session UUID. These temporary files contain prompt text and Laya's
exact request and response, so they are readable only by you (the directory is created with
mode 700 and each file with 600). Files not updated for 7 days are deleted automatically, and
the operating system may also remove them during normal temporary-file cleanup.

> Choosing a model with `Enter` can save it as Claude Code's default. `laya-claude` restores
> the previous default on exit so `laya-router` cannot break plain `claude`.

## How it works

`laya-claude` starts a loopback proxy, ensures a local `laya-serve` instance is reachable
(starting one itself if needed), launches the real CLI, and forwards Claude Code's existing
authorization headers without reading, storing, or modifying them.

```text
you -> Claude Code -> laya-claude proxy -> Anthropic
                         |
                         +-> laya-serve (localhost): choose a tier
```

Claude Code uses `ANTHROPIC_BASE_URL`, and `laya-router` is the routing sentinel. Any concrete
model selected by the user passes through unchanged.

## Routing policy

One Laya call per fresh user turn selects a tier:

| Tier | Claude Code default |
| --- | --- |
| Fast | Haiku |
| Balanced | Sonnet |
| Strong | Opus |
| Long | Fable |

`src/policy.mjs` then applies these rules:

- explicit requests such as `use opus`, `use fast`, or `use strong` win;
- failure, timeout, or an unrecognised Laya answer keeps the current model;
- low confidence never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `LAYA_ALLOW_FABLE=1`.

Tool-loop continuations keep the tier chosen at the start of the turn. Main conversations and
sub-agents are pinned separately. Routing is fail-open: a `laya-serve` failure never blocks the CLI.

## Configuration

| Variable | Effect |
| --- | --- |
| `LAYA_HOST` / `LAYA_PORT` | Where `laya-serve` listens; defaults to `127.0.0.1:8000`. |
| `LAYA_NO_AUTOSTART` | Set to `1` to stop `laya-claude` from managing `laya-serve`'s process; you start and stop it yourself (e.g. on a shared GPU box). |
| `LAYA_SERVE_CMD` | Override the command used to launch `laya-serve`, e.g. a custom venv path. |
| `LAYA_DEVICE` / `LAYA_PRELOAD` | Forwarded to `laya-serve` when `laya-claude` starts it; see the [laya](https://github.com/NandhaKishorM/laya) docs. |
| `LAYA_API_KEY` | Sent as a bearer token to `laya-serve`, if you've configured one to require it. |
| `LAYA_ALLOW_FABLE` | Enables the opt-in long tier. |
| `LAYA_DEBUG` | Logs decisions and rewrites to `~/.laya-claude.log` in interactive sessions. |
| `LAYA_DUMP` | Dumps request bodies for debugging wire-format changes. |
| `LAYA_NO_STATUSLINE` | Disables the injected Claude status line. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, then `~/.laya-router.env`.

Tier definitions, Laya's question, confidence thresholds, and timeouts live in `src/config.mjs`.
`laya-claude` sends Laya the exact models in the signed-in account's native catalog, so model
versions such as `claude-opus-4-8` and `claude-opus-5` remain separate choices. Static model
ids are used only until the CLI fetches its catalog.

## Compatibility notes

- Claude Code needs schema normalisation for older MCP JSON Schema fields when a custom base
  URL is active.
- Claude request fields unsupported by a routed tier, such as adaptive thinking on Haiku,
  are removed before forwarding.

## Development

```bash
npm install
pip install "laya[serve]"

npm test
node test/live-routing.mjs
node bin/laya-claude.mjs -p "what is 2+2?"
```

The test suite covers policy, the proxy's request handling, model rewriting, capability
handling, settings restoration, decision display, and the `laya-serve` lifecycle manager.

## Limitations

- Laya's base checkpoints are close to chance zero-shot; expect routing quality to depend on
  fine-tuning against your own labeled decisions (see the [laya](https://github.com/NandhaKishorM/laya) repo's training notebook).
- Nothing is sent to a third party: the prompt text stays on your machine, exchanged only with
  the `laya-serve` instance `laya-claude` is pointed at.
- Laya adds latency only to the first request of a turn; tool-loop continuations add none.
- Claude Code's request format is not a public contract. Use `LAYA_DUMP` to diagnose upstream
  changes.

## Contributing

Issues and pull requests are welcome. Use Issues to report bugs, request improvements, or ask
questions. Include the relevant Claude Code version, reproduction steps, expected behavior,
and useful logs with secrets removed.

For a pull request:

1. Open an issue first - all PRs by contributors should be linked with an approved issue. Explain the problem and validation in the issue description.
2. Fork the repository and create a focused branch from `main`.
3. Make the smallest change that solves the problem.
4. Run `npm test` and include tests for non-trivial behavior changes.

Please do not commit API keys or other secrets. All contributions require review, and only the
repository owner can merge pull requests.

## License

MIT

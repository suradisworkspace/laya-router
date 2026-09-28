# `laya-claude` architecture

```mermaid
flowchart TB
  user([User]) --> command["`laya-claude`\nCLI wrapper"]

  subgraph launcher["Launcher — bin/laya-claude.mjs"]
    direction TB
    command --> env["Load environment\nprecedence: process env → .env → ~/.laya-router.env"]
    env --> find["Find `claude` executable on PATH"]
    env --> saved["Read existing ~/.claude/settings.json model\nfor later restoration"]
    find --> health{"laya-serve reachable\nat LAYA_HOST:LAYA_PORT?"}

    health -- Yes --> proxyStart["Start ephemeral loopback proxy\n127.0.0.1:random-port"]
    health -- "No, LAYA_NO_AUTOSTART=1" --> warn["Warn: routing will fail open\nuntil laya-serve is reachable"] --> proxyStart
    health -- "No, autostart (default)" --> spawnLaya["Spawn laya-serve detached\nWait for GET /health"]
    spawnLaya -- "became healthy" --> proxyStart
    spawnLaya -- "timed out" --> warn

    proxyStart --> launchEnv["Set ANTHROPIC_BASE_URL to proxy\nExpose `laya-router` as Laya Router in /model\nDefault to `laya-router` unless user set ANTHROPIC_MODEL"]
    launchEnv --> statusCfg{"Status line allowed?"}
    statusCfg -- "No: LAYA_NO_STATUSLINE or user statusLine" --> spawn
    statusCfg -- Yes --> statusCfgFile["Write temporary Claude status-line settings"] --> spawn
    spawn["Spawn real Claude Code\nwith original CLI arguments"]
  end

  spawn --> claude["Claude Code\n(native UI, login, tools, sessions, permissions)"]
  claude --> picker{"/model selection"}
  picker -- "Laya Router" --> auto["model: `laya-router`\n(routing sentinel)"]
  picker -- "Concrete model" --> manual["model: user-selected model"]
  auto --> loopback
  manual --> loopback

  subgraph proxy["Loopback proxy — src/proxy.mjs"]
    direction TB
    loopback["Receive HEAD or /v1/messages request"]
    loopback --> head{"HEAD probe?"}
    head -- Yes --> headOK["Return 200"]
    head -- No --> parse["Parse request body\nOptionally dump body with LAYA_DUMP\nNormalize legacy MCP JSON schemas"]
    parse --> mode{"model is `laya-router`?"}

    mode -- No --> pass["Leave model unchanged\nFor agent requests, publish manual status"]
    mode -- Yes --> conversation["Build conversation key\nsession ID + first-message text\nKeep up to 50 independent states"]
    conversation --> fresh{"Fresh user turn?\n(tool-bearing, last user text,\nnot a tool-result continuation)"}
    fresh -- No --> pinned["Reuse tier pinned for this conversation\n(default: sonnet)"]
    fresh -- Yes --> prompt["Remove system-reminder blocks\nEstimate context tokens"]
    prompt --> laya
    laya --> policy
    policy --> saveTier["Pin chosen tier in conversation state"]
    saveTier --> pinned
    pinned --> rewrite["Rewrite `laya-router` to Claude tier model ID\nStrip unsupported thinking / effort fields"]
    rewrite --> publish["Write latest tier, confidence, and reason\nto per-session temp status file"]
    pass --> forward
    publish --> forward["Forward request to api.anthropic.com\nPreserve Claude Code authorization headers\nstream upstream response unchanged"]
  end

  subgraph routing["Routing — src/router.mjs + src/policy.mjs"]
    direction TB
    laya["POST /v1/systemone to local laya-serve\nSends only fresh user prompt plus:\ncurrent tier, approximate context, available tiers"]
    policy["Policy resolves final tier\n• prompt override wins\n• failure / malformed answer: keep current\n• low confidence: no downgrade; upgrades capped at sonnet\n• large context: no downgrade that rebuilds cache\n• unavailable tier: choose nearest stronger available\n• fable requires LAYA_ALLOW_FABLE=1"]
  end

  forward --> anthropic["Anthropic API"]
  anthropic --> claude

  subgraph visibility["Routing visibility — status.mjs + laya-statusline.mjs"]
    direction TB
    statusFile["Temp file: $TMPDIR/laya-claude/<session>.json"]
    statusLine["Claude Code status-line command\nReads session file and renders:\n⚡ tier + confidence, or ⏸ manual"]
    statusFile --> statusLine
  end
  publish --> statusFile
  pass --> statusFile
  statusLine --> claude

  spawn --> exit["On process exit: close proxy,\nstop laya-serve if we started it,\nand restore saved model only if it is still `laya-router`"]
```

The routing call happens only for the first request of a user turn. Tool-loop continuations reuse
the pinned tier, avoiding repeated routing latency and model changes mid-task. A concrete model
chosen in Claude Code bypasses routing until the user selects **Laya Router** again.

Unlike a cloud classifier, there is no signup or API key: `laya-claude` checks whether a
`laya-serve` instance is already reachable and, if not, starts one itself (`src/laya-serve-manager.mjs`)
and stops it on exit — but only the instance it started. A `laya-serve` you started yourself is
never touched.

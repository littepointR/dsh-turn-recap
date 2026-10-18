# Turn Recap for DSH

A persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that writes a short,
model-generated recap under every completed turn in the Web UI — and regenerates one on demand with `/recap`.

<img src="icon.svg" width="72" height="72" alt="Turn Recap icon">

English | [中文](README.zh.md)

## What it does

- **After a turn the session goes quiet** a card appears at the end of that turn: one to three sentences saying what the
  turn accomplished and, only when it matters, what is still unfinished. The card waits out a quiet window (two minutes
  by default) and never appears for a turn you kept working past — it is a "where did I leave off" card, not a second
  summary of a reply you are still reading. The text follows the conversation's language.
- **`/recap`** produces the same card for the latest turn on demand, immediately — useful when a turn never got its quiet
  window, when you scrolled past it, or when you want a fresh read of where things stand.
- Turns that carry nothing to summarize (interrupted or failed turns, empty turns) produce no card, and subagent
  sessions are skipped by default.

The card uses the host's theme tokens, so it follows light/dark and the active locale (English and Simplified Chinese
dictionaries ship with the bundle).

## Install

The bundle is a local DSH plugin package: it declares `dsh.bundle.patch` and a `dsh.client` half, and it is installed
into a profile rather than published to npm.

```bash
git clone https://github.com/littepointR/dsh-turn-recap.git
```

Then install the directory as a bundle in your DSH profile — in a DSH session, ask the agent to install the bundle from
that absolute path (it uses the profile's plugin manager), or run the equivalent install from your own tooling. The
bundle patch adds one Loader row:

```yaml
- insert:
    - id: turn-recap
      name: '@local/dsh-turn-recap'
```

Reinstalling or toggling the plugin needs no Harness restart: disable and re-enable the row and the Host module is
imported again.

## Configuration

Every key is optional. Add a `config` block to the Loader row in your profile's `cordis.patch.yml` — that layer survives
package upgrades.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` unregisters the projection, the turn listener, and `/recap` |
| `maxTokens` | `200` | Output budget of the recap request |
| `temperature` | `0.2` | Sampling temperature |
| `timeoutMs` | `12000` | Hard bound on one recap request, in milliseconds |
| `digestChars` | `6000` | Size bound of the turn digest sent to the model |
| `idleMs` | `120000` | Quiet window a finished turn must hold before its card may appear; `0` shows it immediately |
| `skipSubagents` | `true` | Subagent sessions get no automatic recap |
| `provider`, `model` | unset | Explicit route; by default the turn's own request route is reused |

```yaml
- insert:
    - id: turn-recap
      name: '@local/dsh-turn-recap'
      config:
        maxTokens: 300
        skipSubagents: false
```

## How it works

```
agent/turn-stopping ──▶ digest the turn ──▶ model call ──▶ pending map
                                                               │
turn/end (committed) ──▶ projection apply ──▶ recap projection ──▶ useProjection("recap")
                                                                        │
                                                        conversation.chat.turnTail
```

1. **`agent/turn-stopping`** is the serial event the agent loop dispatches just before it commits `turn/end`. The plugin
   digests the turn from the session log — the user request, the newest tool calls (with failures marked), and the
   turn's *final* assistant reply — and asks the model that served the turn for a short recap.
2. The following **`turn/end`** commit folds the text into the client-visible **`recap` session projection**, so the
   card and the finished turn arrive in the same frame.
3. The Client half registers into the **`conversation.chat.turnTail`** slot and reads the projection with
   `useProjection("recap")`. Each entry carries a `revealAt` deadline: the card is held back until that instant passes
   **and** no newer turn has started, so the quiet window costs nothing and the card never interrupts active work.

**Why a projection instead of a session event?** A plugin may not append new event types: a log carrying a type the
build does not know cannot be reopened, and `appendPluginRecord()` is reserved for first-party experimental packages.
The session projection is the supported carrier for session-derived client state.

**Why is the recap produced before `turn/end`?** Projection state is folded synchronously from committed events and its
Value is only re-read when a committed event changes that state. Producing the text while the turn boundary is still
open is what lets the commitment bake it into state — the delayed *appearance* is a client-side rule over the stored
`revealAt`, not a delayed request.

**`/recap`** is a plain DSH command: it runs outside any turn, and its result travels in `command/done`. The Client half
claims the command row through the `conversation.chat.commandview` slot under the `recap` key and renders the running,
success, and failure states itself.

## Trade-offs and limits

- **One extra model request per turn.** It is short, but it is billed by your provider; it does not appear in the
  session's token statistics because no assistant message is appended for it.
- **The turn closes after the recap is ready.** Generation happens before `turn/end`, so a slow provider delays the
  boundary by up to `timeoutMs`. Failures and timeouts degrade to "no card", never to a failed turn. The quiet window
  delays only what you see, not what you pay.
- **A card you never earned stays hidden.** If you send the next prompt before `idleMs` elapses, that turn gets no card;
  `/recap` is the escape hatch when you want one anyway.
- **Recap text cannot be re-derived from the log.** It lives in the projection checkpoint, so it survives a restart;
  a projection cell rebuilt from the log alone (for example after the plugin is re-registered) starts empty.
- **`stateVersion` gates cached wording.** Bumping it discards recaps cached under the previous digest rules instead of
  serving stale text.

## Development

Both halves are dependency-free JavaScript: the Host half is plain ESM, the Client half is a module-loader factory that
only asks the page for `react`.

```bash
npm test        # Host half under a fake Cordis context — needs nothing but Node
npm run check   # syntax-check every JavaScript entry point
```

The Host tests cover the projection fold, the turn digest, the `/recap` handler, and the failure paths, so most changes
can be verified without a running Harness.

## License

MIT — see [LICENSE](LICENSE).

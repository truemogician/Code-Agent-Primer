# Code Agent Primer

Keeps your code agent's rate-limit windows fresh by sending tiny "primer" requests on a schedule, so you don't always have to wait a full 5h window after every idle period. Also gives you a handy CLI to check your tokens and quotas across providers and accounts.

Currently supports **Codex (OpenAI)** and **Claude Code (Anthropic)**, with first-class **multiple-account** support per provider.

## Features

- 🔐 OAuth login per provider — tokens stored under `~/.code-agent-primer/`, auto-refreshed
- 👥 Multiple accounts per provider (e.g. `codex:work`, `codex:personal`)
- 📈 Quota snapshot on every primer call: rolling-window utilization, request/token buckets, retry hints
- ⏰ Cron-driven scheduler with optional **shift-aware follow-up** that chains primers across window boundaries while you're active and stops when you go idle
- 🎨 Friendly colored CLI output and machine-readable raw JSON via `--raw`

## Quick start

```bash
# 1. Install deps and build
pnpm install
pnpm run build

# 2. Log in to one or more accounts (account id auto-assigned if omitted)
pnpm start login codex
pnpm start login claude:work

# 3. Send a primer to all logged-in Codex accounts, or one specific account
pnpm start send codex
pnpm start send claude:work

# 4. Run the scheduler
pnpm start run --now
```

> [!NOTE]
> The package ships a `code-agent-primer` bin after `pnpm run build`. The examples above use `pnpm start` (which runs the TypeScript source via Bun). Substitute `code-agent-primer` once installed.

## Agent ref format

Every command that targets an agent uses `<agentId>[:<accountId>]`:

| Ref          | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `codex`      | All logged-in Codex accounts (or auto-assigned on login) |
| `codex:work` | Just the Codex account named `work`                      |
| `claude:1`   | The auto-numbered Claude account `1`                     |

Account ids may be any string without `:`, whitespace, or path separators. Login auto-assigns `"1"`, `"2"`, … when the account half is omitted.

## Commands

| Command                               | Description                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `login <agent>`                       | OAuth login. Auto-assigns an account id if not provided.                                |
| `remove <agent>`                      | Remove stored auth tokens; fan-out across all accounts under the agent if omitted.      |
| `status`                              | Show every stored token across all agents and accounts.                                 |
| `send <agent> [--no-consume] [--raw]` | Send a primer; fan-out across all accounts under the agent if account is omitted.       |
| `run [--now]`                         | Start the scheduler (long-running). `--now` fires once per (agent, account) at startup. |
| `config [agent] [flags]`              | Show or update schedules. See below.                                                    |
| `agents`                              | List registered agents and their connected accounts.                                    |

### `config` flags

`config` operates on the scope implied by `[agent]`:

- omitted → every (agent, account) pair
- `<id>` → every account under that agent
- `<id>:<accountId>` → just that one

With no flags it prints the resolved schedule(s). Any of these flags applied to the scope persist updates:

| Flag                         | Description                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--cron <expr>`              | Cron expression (default `0 */1 * * *` — top of every hour)                                                              |
| `--model <name>`             | Override the agent's default model. Pass `""` to clear.                                                                  |
| `--primer <text>`            | Override the primer message body. Pass `""` to clear.                                                                    |
| `--enable` / `--disable`     | Enable or disable scheduled primers for the scope                                                                        |
| `--follow-up`                | Chain primers across window boundaries (skipped when idle and chaining would shift the schedule past the next cron tick) |
| `--follow-up-probe-lead <m>` | Minutes before the window resets to send the cheap probe (default 5)                                                     |

### `send` flags

| Flag           | Description                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `--no-consume` | Cheap quota probe — read headers without consuming a request token. Useful before running scheduler chains. |
| `--raw`        | Print the parsed `QuotaSnapshot.raw` headers as JSON instead of the friendly summary.                       |

## Storage layout

Everything lives under `~/.code-agent-primer/` (override with `CODE_AGENT_PRIMER_HOME`):

```
~/.code-agent-primer/
├── tokens.json              # { codex: { "<accountId>": {...} }, claude: { ... } }
├── config.json              # { codex: { "<accountId>": <schedule> }, ... }
└── snapshots/
    ├── codex/<accountId>.json
    └── claude/<accountId>.json
```

Tokens are written with `0600` permissions on POSIX systems.

## How follow-up works

When `--follow-up` is enabled for an (agent, account), the scheduler:

1. Anchors a primer via the cron expression.
2. Sets a timer for **(window reset − probe lead)** to send a `--no-consume` probe.
3. Compares the probe's `usedPercent` to the anchor baseline:
   - **Active** (Δ ≥ 0.5%) → fire a fresh anchor right after window reset; chain continues.
   - **Idle** → fire the next anchor only if doing so wouldn't shift the resulting window's reset past the upcoming cron tick (which would let the cron fire inside the anchored window and drift the schedule). Otherwise stop and let cron resume coverage.

This keeps active sessions covered without permanently anchoring a window for an idle user.

## Development

```bash
pnpm install
pnpm run build      # tsc → dist/
pnpm test           # bun test tests
pnpm start <cmd>    # bun src/cli.ts <cmd>
```

### Project layout

```
src/
├── cli.ts                    # yargs entrypoint
├── config.ts                 # paths, provider OAuth constants
├── scheduler.ts              # Cron jobs + FollowUpController
├── agents/
│   ├── agent.ts              # abstract CodeAgent
│   ├── codex.ts
│   ├── claude.ts
│   └── registry.ts
├── oauth/                    # PKCE + loopback callback helpers
├── primer/sender.ts          # sendPrimer(agentId, accountId, opts)
├── storage/
│   ├── tokens.ts             # provider → account → tokens
│   ├── snapshot.ts           # snapshots/<agentId>/<accountId>.json
│   ├── scheduleConfig.ts     # nested schedule config
│   └── account.ts            # parseAgentRef / assertValidAccountId
└── utils.ts                  # JSON I/O, headers, formatting
```

### Adding an agent

1. Subclass `CodeAgent` (`src/agents/agent.ts`) — implement `id`, `displayName`, `defaultModel`, `defaultPrimer`, optional `followUpWindowId`, plus:
   - `exchangeAndPersist({ clientId, code, verifier, state, accountId })` → call `saveTokens(accountId, tokens)`
   - `isAuthenticated(accountId)`
   - `sendRequest(accountId, opts)` → return `{ status, headers }`
   - `selectQuotaHeaders`, `parseQuota`, `summarize`, `isInterestingHeader`
2. Register the singleton in `src/agents/registry.ts`.
3. Add the provider id to `PROVIDER_IDS` and a token schema in `src/storage/tokens.ts`.

The `CodeAgent` template provides the full PKCE + loopback OAuth dance via `login(accountId, opts)`; subclasses only implement the token-exchange step.

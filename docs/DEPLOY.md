# Deploying The AIDOG Bot

## Prerequisites

- Node.js 20 or newer
- A dedicated Base wallet with limited funds
- A stable Base RPC endpoint
- Valid `OKX_API_KEY`, `OKX_SECRET_KEY`, and `OKX_PASSPHRASE`
- Local Python with `paramiko` if you want to use the one-click deploy helper

## One-Click Deploy

If `.env` already contains `SERVER_IP`, `SERVER_PASSWORD`, and `SERVER_USER`, you can deploy directly from this machine:

```bash
npm run deploy:vps
```

What it does:

- Uploads the current project to `/opt/aidog-bot`
- Filters out `SERVER_*` keys so deployment credentials are not copied into the server-side `.env`
- Installs a dedicated Node.js 20 runtime under `/opt/aidog-bot/.runtime/node`
- Creates an isolated Linux user `aidogbot`
- Installs and starts `aidog-bot.service`

It does not stop or modify unrelated services on the server.

## First Run

1. Copy `.env.example` to `.env` and fill in the values.
2. Keep `DRY_RUN=true` for the first verification.
3. Install dependencies:

```bash
npm install
```

4. Run the bot once:

```bash
npm run buy:aidog
```

5. Check the generated files:

- `data/logs/aidog-bot.log`
- `data/logs/aidog-trades.jsonl`
- `data/state/aidog-bot-state.json`
- `data/state/aidog-bot.lock`

6. After validation, switch `.env` to `DRY_RUN=false`.

## Suggested Production Settings

```dotenv
TRADING_TIMEZONE=Asia/Shanghai
BUY_ONCE=false
DRY_RUN=false
DAILY_DCA_ENABLED=true
DAILY_DCA_THRESHOLD_USD=0.005
DAILY_DCA_AMOUNT_USDC=2
DAILY_DCA_HOUR=24
DAILY_DCA_MINUTE=0
DAILY_DCA_WINDOW_MINUTES=30
DEEP_BUY_ENABLED=true
DEEP_BUY_THRESHOLD_USD=0.004
DEEP_BUY_AMOUNT_USDC=10
DEEP_BUY_COOLDOWN_DAYS=5
POLL_INTERVAL_MS=5000
MAX_BUYS_PER_DAY=2
DAILY_BUY_BUDGET_USDC=12
MIN_BASE_ETH_BALANCE=0.0001
LOCK_FILE=data/state/aidog-bot.lock
```

`DAILY_DCA_HOUR=24` with `TRADING_TIMEZONE=Asia/Shanghai` means the daily check runs in the short window immediately after Beijing midnight.

For first-time deployments, keep `.env.example` and your first real `.env` on `DRY_RUN=true` until you complete a full dry-run on the target machine.

## Strategy Model

- Daily DCA: if AIDOG is at or below `0.005 USD`, buy `2 USDC` once per Beijing day during the configured post-midnight window.
- Deep discount buy: if AIDOG is at or below `0.004 USD`, buy `10 USDC` any time, but only once every `5` days.
- If both conditions are true near midnight, both strategies can execute on the same day. `MAX_BUYS_PER_DAY` and `DAILY_BUY_BUDGET_USDC` still cap activity.

## Feishu Notifications

Add these values to `.env` if you want push notifications:

```dotenv
BOT_NAME=AIDOG Bot
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook-id
FEISHU_SECRET=
FEISHU_NOTIFY_COOLDOWN_MS=300000
FEISHU_NOTIFY_STARTUP=true
FEISHU_NOTIFY_TRADE_SUCCESS=true
FEISHU_NOTIFY_TRADE_FAILURE=true
FEISHU_NOTIFY_RUNTIME_ISSUES=true
FEISHU_NOTIFY_GUARD_EVENTS=true
FEISHU_NOTIFY_DRY_RUN=false
FEISHU_NOTIFY_WEEKLY_SUMMARY=true
FEISHU_NOTIFY_DAILY_DCA_SUCCESS=false
FEISHU_NOTIFY_DEEP_BUY_SUCCESS=true
FEISHU_NOTIFY_DEEP_BUY_COOLDOWN_SKIP=false
```

`FEISHU_SECRET` is optional. Only fill it if your Feishu bot has "签名校验" enabled.

Recommended push events:

- Bot start or restart
- Successful deep-discount buy, including strategy, trigger price, spent USDC, received AIDOG, and tx hash
- Final failed trade after retries
- Guard blocks: low gas, insufficient USDC, daily budget reached, daily count reached
- Runtime issues such as repeated price request failures
- Weekly summary card for the previous week

Default notification profile in this repo:

- Daily DCA success notifications are suppressed.
- Deep-buy success notifications remain enabled.
- "Deep-buy skipped because cooldown is active" notifications are suppressed.

## Weekly Summary

Add these values to `.env` if you want the bot to push a weekly summary card:

```dotenv
WEEKLY_SUMMARY_ENABLED=true
WEEKLY_SUMMARY_WEEKDAY=1
WEEKLY_SUMMARY_HOUR=7
WEEKLY_SUMMARY_MINUTE=0
```

- `WEEKLY_SUMMARY_WEEKDAY=1` means Monday, based on `TRADING_TIMEZONE`.
- The bot summarizes the previous week and sends it after the configured time.
- If the bot misses the exact time because the server was offline, it will catch up and send the summary after it comes back online.
- Confirmed pending swaps are now recovered from on-chain transfer logs first, which prevents `0 USDC / 0 AIDOG` entries after a restart.
- No heartbeat card is enabled in this project.

## systemd

1. Copy `deploy/systemd/aidog-bot.service` to `/etc/systemd/system/aidog-bot.service`.
2. Replace the working directory and user placeholders.
3. If you change `/opt/aidog-bot`, update `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, `Environment=HOME`, and `ReadWritePaths` together.
4. Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aidog-bot.service
```

5. Inspect logs:

```bash
sudo journalctl -u aidog-bot -f
```

## Operational Notes

- The bot writes state locally. Keep `data/state/aidog-bot-state.json` across restarts.
- The bot now keeps a local lock file and refuses to start a second instance from the same workspace.
- If the process restarts after broadcasting a transaction, it will recover the pending approval or swap from local state before attempting a new trade.
- If you delete the state file, daily counters and trigger state reset.
- Keep the wallet small and dedicated. Do not run this from a primary wallet.

# Northline Market

A Cloudflare Worker marketplace used as a research instrument. A person, Claude, or GPT uses the shop over HTTP. The Worker records that traffic, classifies it from the trace alone, and scores the result against a sealed trial record.

The live shop is [agent-market-sandbox.michaelmichaellamimanlamiman.workers.dev](https://agent-market-sandbox.michaelmichaellamimanlamiman.workers.dev).

The catalog is housewares, electronics, and outdoor gear. Buyers sign in with a seeded account and pay from a wallet on the shop. There is no external identity provider.

## What a trial measures

One trial is one model (`human`, `claude`, or `gpt`) and one task, on a fresh catalog. Opening a trial resets wallets, carts, orders, stock, and sessions. It keeps earlier events and trials. Run one trial at a time.

The shop looks the same during a trial. The prompt, model, task id, answer key, and score stay on the control route. The classifier in `analysis/classify.ts` reads observed events only. `analysis/score.ts` opens the sealed record afterward.

The three v1 tasks are in `data/tasks/v1.json`:

| Task | What a pass looks like |
| --- | --- |
| `inspect_harbor_kettle` | The Harbor Whistle Kettle listing is opened at the catalog title and price. |
| `retrieve_kitchen_under_25` | At least one kitchen listing under $25 is opened. |
| `checkout_cedar_lantern` | Mina Cole checks out the Cedar Camp Lantern and the wallet drops by the catalog total. |

The full procedure, oracle reasons, sealed-field list, and scoring weights are in [STUDY.md](STUDY.md). Task ids, oracles, and the sealed-field list stay fixed after the first external-agent trial. A change needs a new task version.

## Control API

`/_control/*` is omitted from the nav, robots, and sitemap. Every call needs `Authorization: Bearer $CONTROL_TOKEN`.

```bash
curl -s -X POST "$SHOP/_control/trials" \
  -H "authorization: Bearer $CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"claude","task_id":"inspect_harbor_kettle","prompt_text":"THE PROMPT YOU WILL SEND"}'
```

The response is `{ "trial_id", "url" }`. The URL is `/t/<trial_id>`. It sets an HttpOnly `sid` cookie and redirects to the home page. Give that URL to the agent, or open it yourself for the human arm. The first page they load should be that home page.

```bash
curl -s -X POST "$SHOP/_control/trials/$TRIAL_ID/close" \
  -H "authorization: Bearer $CONTROL_TOKEN"

curl -s "$SHOP/_control/trials/$TRIAL_ID" \
  -H "authorization: Bearer $CONTROL_TOKEN"
```

Closing a trial runs the oracle and freezes the window. Reading a closed trial classifies the stored events and returns the score. Scores are computed on that read, so a classifier deploy changes later reads of the same trial without rewriting D1.

## Local development

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts Wrangler on port 8787. Copy the local token into a gitignored `.dev.vars`:

```
CONTROL_TOKEN=local-sandbox-token
```

Tests and `wrangler dev` read that file. The deployed Worker keeps `CONTROL_TOKEN` as a secret:

```bash
npx wrangler secret put CONTROL_TOKEN
```

Do not put the token in `wrangler.jsonc` `vars`. Cloudflare rejects a secret whose name is already a plain binding.

`npm run deploy` publishes the Worker named `agent-market-sandbox`. Bindings are D1 (`DB`, database `agent-market-sandbox`) and Analytics Engine (`analytics_engine`, dataset `analytics_events`). Logs and traces are sampled at 1.

## Layout

| Path | Role |
| --- | --- |
| `src/shop.ts`, `src/render.ts` | HTML shop: home, categories, search, listings, sellers, cart, checkout |
| `src/api.ts` | JSON API with the same catalog and checkout actions |
| `src/control.ts` | Trial create, close, and read |
| `src/telemetry.ts` | One event per shop request, plus an Analytics Engine point |
| `src/oracle.ts` | Server-side pass or fail for a closed trial |
| `analysis/classify.ts` | Actor, access pattern, and intent from the trace |
| `analysis/score.ts` | Agreement with the sealed model, intent, oracle, and budgets |
| `data/` | Catalog seed and task definitions |
| `STUDY.md` | Frozen study protocol |

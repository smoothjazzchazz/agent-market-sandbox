# Northline Market study protocol

This file is the protocol for the pilot. It was written with the instrument. Do not change task ids, oracles, or the sealed-field list after the first external-agent trial is collected. A change needs a new task version.

The shop is a normal marketplace. A person prompts Claude or GPT, or uses the shop themselves, and the site records the HTTP trace. The classifier reads only that trace. Scoring opens the sealed trial record afterward.

## Question

When a person prompts an external agent to read data from this shop or to check out, can the observed trace support an actor label, an access pattern, and an intent bucket that agree with the sealed trial record, and can the oracle separate successful attempts from unsuccessful ones?

## Unit and factors

One trial is one model, one task, and one fresh catalog.

- Model, sealed: `claude`, `gpt`, or `human`. The human arm does the same tasks in a normal browser.
- Task type, sealed: `data_access` or `action`.

Run one trial at a time. Opening a trial resets wallets, carts, orders, stock, and sessions. It does not delete events or earlier trials.

## Procedure

1. Deploy with logs and traces sampled at 1, or use `wrangler dev` while building. The measured pilot should run on the deployed Worker URL.
2. Create a trial. Replace `local-sandbox-token` with `wrangler secret put CONTROL_TOKEN` before a public deploy.

```bash
curl -s -X POST "$SHOP/_control/trials" \
  -H "authorization: Bearer $CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"claude","task_id":"inspect_harbor_kettle","prompt_text":"PASTE THE PROMPT YOU WILL SEND"}'
```

3. The response is an opaque `trial_id` and a URL of the form `/t/<trial_id>`. The id does not encode the model, the task, or a listing id.
4. Paste that URL into the prompt you send to Claude or GPT. For a human trial, open the URL yourself.
5. The URL sets a cookie named `sid` and redirects to the home page. The page is the ordinary shop. It does not name the task.
6. Let the attempt finish. Close the trial:

```bash
curl -s -X POST "$SHOP/_control/trials/$TRIAL_ID/close" \
  -H "authorization: Bearer $CONTROL_TOKEN"
```

7. Read the bundle:

```bash
curl -s "$SHOP/_control/trials/$TRIAL_ID" \
  -H "authorization: Bearer $CONTROL_TOKEN"
```

Requests during the open window that do not send `sid` stay in the log with no trial id. The bundle counts them as `unassigned_during_window`. A large count means the attempt may have left the cookie behind.

Optional: if the chat product shows a token total, pass `self_reported_tokens` when creating the trial. That number is a note from the chat UI. It is not on the wire, and the classifier does not read it.

## Tasks (v1)

Seed version `v1`. Task version `v1`. Definitions live in [data/tasks/v1.json](data/tasks/v1.json).

| Task | Type | Labeled intent | Passes when |
| --- | --- | --- | --- |
| `retrieve_kitchen_under_25` | data access | retrieve | The trace opens at least one of `kit_01` through `kit_05` (kitchen listings under $25). |
| `inspect_harbor_kettle` | data access | inspect | The trace opens `kit_01`, the Harbor Whistle Kettle, and the served title and price match the catalog row ($24.00). |
| `checkout_cedar_lantern` | action | transact | Mina Cole (`buyer_mina`) has an order for `cam_01`, the Cedar Camp Lantern, at the catalog price, and her wallet was reduced by that total. |

Suggested prompts in the task file are starting points. The sealed prompt is the text you actually send, which you store on the trial.

Failure reasons the oracle may seal:

- `retrieval_empty` — searches or filters ran and every one was empty
- `retrieval_miss` — the expected listing was not opened, and checkout never started
- `filter_invalid` — every search or filter excluded the expected listings
- `checkout_abandon` — a cart or checkout step happened and the required order does not exist
- `citation_unsupported` — a listing was opened or ordered at a title or price other than the catalog row

`pass` is the reason on success.

## Sealed fields

These are stored on the trial row and returned only by the control route. They are withheld from shop HTML, shop JSON, sitemap, robots, Analytics Engine points, event rows, and the classifier.

- Researcher prompt
- Model label
- Task id, task type, labeled intent, expected listing ids, buyer id, budgets
- Oracle pass or fail, oracle reason, oracle detail
- Optional self-reported token note
- Classifier output and score

Listing ids, titles, and prices still appear on the shop because they are the catalog. What stays sealed is which of those ids are the answer key, and which prompt and model produced the visit.

Public pages are tested so a live trial's prompt, task ids, model labels, and classifier vocabulary do not appear in HTML, JSON, robots, or the sitemap.

## Observed fields

Each shop request appends one event. Analytics Engine dataset `analytics_events` gets the same short fields, indexed by trial id when the cookie is present and by session id otherwise. Workers Logs and traces, with sampling set to 1, carry the ray id, colo, handler wall time, CPU time, and D1 span time. CPU time is not visible inside the request, so event cost leaves `cpu_ms` null and scoring does not emit `excess_cpu`. Use the ray id on the event to open the trace while the log still exists.

Event fields: path, surface (`page`, `api`, `asset`), action, query, filters, ranked listing ids, status, user agent, colo, ray id, handler time, gap since the previous event in the session, robots or sitemap hit, method, result count, empty flag, listing id, category id, seller id, order id, and the title and price that were served.

## Classifier

Implemented in [analysis/classify.ts](analysis/classify.ts). It accepts observed events only. [analysis/score.ts](analysis/score.ts) accepts the prediction plus the sealed record. The two modules do not share a type that contains sealed fields.

### 1. Actor

Signals, then a score. The confidence floor is 0.45. Below the floor, or when the trace has no page or API request, the actor is `unknown`.

- API share at or above 0.5 adds 0.35 to the agent score; at or above 0.25 adds 0.15
- No asset fetch, when a document was requested, adds 0.30 to the agent score
- A robots or sitemap fetch adds 0.15 to the agent score
- A median inter-request gap under 400 ms adds 0.20 to the agent score
- An asset fetch adds 0.35 to the human score
- API share under 0.15 adds 0.25 to the human score; under 0.35 adds 0.10
- A median gap of at least 800 ms adds 0.25 to the human score
- A login form post adds 0.15 to the human score
- A user agent on the crawler list adds 0.95 to the crawler score
- Robots or sitemap plus eight or more distinct pages, without a login post, adds 0.50 to the crawler score

The highest score at or above the floor wins. Computer-use agents that load CSS, pause, and sign in through the form are expected to look human. Agreement is scored afterward: sealed `claude` and `gpt` expect `agent`, and sealed `human` expects `human`.

The crawler list is a substring match on the user agent and includes Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, CCBot, Applebot, and the other tokens in `classify.ts`. Interactive Claude and GPT sessions often use a normal browser user agent, so this list will not catch them. That is why the trial cookie, not the user agent, attributes the trial.

### 2. Access pattern

Built for every closed trial, including the human arm, from observed events only.

- Pages in order, with category, depth, and status
- Listing ids, seller ids, categories, cart lines, and order ids that were actually touched
- API calls with method, path, query, status, result count, and empty flag
- Retrievals: search and filter events, with the ids the shop returned
- Citations: title and price served on a listing view. `delivered` means both were present. Comparison to the catalog answer key happens in the oracle, not here
- Cost the site can see: non-asset step count, first-to-last timestamp, summed handler time, and `cpu_ms: null`

### 3. Intent

Each non-asset event maps to at most one intent. The path keeps a change of intent. The primary intent is the last one.

- `enumerate` — robots.txt or sitemap.xml
- `retrieve` — search or filter
- `inspect` — listing or seller profile
- `transact` — cart, checkout, or an order receipt
- `discover` — other document views, including home and department pages
- Login posts and the `/t/<id>` redirect do not take an intent
- Fifteen or more distinct pages, with no retrieve, inspect, or transact, appends `enumerate`
- No mapped event yields `unknown_intent`

Scoring then compares the primary intent to the task's labeled intent and attaches the sealed oracle result. Cost flags use the task budgets and are not classifier inputs:

- `excess_steps` when non-asset steps exceed the budget
- `excess_latency` when the first-to-last duration exceeds the budget
- `excess_cpu` only if a CPU total is present and over budget. This build does not have that total on the event.

## What this phase does not do

It does not change the shop in response to a failed trial, and it does not train a model. The readiness question for a later phase is the contrast inside one task: what passed trials touched, and where failed trials stopped.

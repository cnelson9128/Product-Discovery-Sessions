# Firefish Product Discovery Sessions — internal hosting

An internal tool on Vercel supporting Firefish's v2 product-discovery research program: roughly 10
clients, ~100 sessions over 8-10 weeks, each session tagged to one of 11 fixed session types (10
specific v2 product modules plus a general Introduction Session), each asking the same 11 standard
validation questions (today's process, value created, who benefits,
adoption blockers, v1 vs v2, trust concerns, migration blockers/conditions, top priority
improvement, success metric, one-sentence pitch). Every session's transcript is analyzed into
structured answers to those 11 questions, and once a module has multiple analyzed sessions its
answers can be synthesized on demand into a **module trend** — standout "wow" quotes, feature
prioritization, adoption blockers, and draft messaging specific to that one module. A level above
that, a **Go-to-Market view** synthesizes across every analyzed session in every module at once —
one overall positioning statement, value pillars, proof points, objection handling, and a
per-module highlight reel, built only from what recurs across more than one customer or module
rather than any single session's one-off comment.

This is also the team's **roadmap prioritization board**: every feature a trend surfaces becomes a
persistent, independently-editable card — given an owner, tracked through Launch / Phase 2 /
Future Considerations, marked requirements-done and/or complete, and movable to a different module
entirely — that survives every future trend rebuild rather than being regenerated from scratch. A
**Quote Wall** pulls every module's "wow" quotes into one place, and a **Reports** dashboard gives
the monthly board pack a real breakdown of features by status per module.

Distinct from the sibling `competitor-analysis` repo's sales-facing demo-prep tool — this is PM/
research interviews about product needs, not sales calls. A static shell in `public/`, plus
serverless functions in `api/` that hold session data. No build step, and one runtime dependency —
`mammoth`, used only to read uploaded `.docx` transcripts. Styling is Tailwind CSS via the
[Play CDN](https://tailwindcss.com/docs/installation/play-cdn) (one `<script>` tag, no PostCSS/build
step, no devDependency) layered on top of a small set of hand-written CSS custom properties that
still own all theming — light/dark colors and the validated 3-color bucket palette used on the
roadmap board and the Reports charts. Tailwind utility classes handle layout, motion, and depth
(transitions, hover states, shadows); color and dark-mode swapping stay on the CSS variables, so
Tailwind's `dark:` variant system is deliberately unused.

---

## Read this before you deploy

**This content is internal only.** Discovery-call transcripts name real customers or prospects and
describe their pain points in their own words — treat this the same as any other customer data.

**The login is a real boundary, not a screen over the data.** No session data is in the HTML. It
lives only in Redis, reachable exclusively through `/api/*` to a request carrying a valid signed
session cookie. An anonymous visitor who views source finds the layout and nothing else.

**One shared password, not per-user login.** This is a small trusted team (product managers/
researchers) where everyone needs full access — anyone with the password can log a session, read
every session, and build/refresh trends. There's no per-user identity, so there's also no audit
trail of *who* created or edited a given session beyond a free-text "Interviewer" field and
timestamps.

**Layering Vercel Deployment Protection on top is still worth doing.** This login protects the
data; Deployment Protection would also stop an anonymous visitor reaching the sign-in page at all.
They solve different halves and do not conflict — see **Settings → Deployment Protection**, covering
**Production** (the default only covers Preview deployments).

---

## Set this up — the site will not work until you do

The functions read three required environment variables. Without them every sign-in returns a 500
and nobody gets in, including you.

### 1. Environment variables

Vercel → the project → **Settings → Environment Variables**. Add these to **Production** (and
Preview, if you use preview deployments):

| Name | Value |
|---|---|
| `SESSION_SECRET` | A random string of **32+ characters**. Anything shorter is rejected at runtime. |
| `APP_PASSWORD` | The one shared password everyone on the team signs in with. |
| `SESSION_TTL_HOURS` | *Optional.* How long a sign-in lasts. Defaults to 12, capped at 168. |
| `ANTHROPIC_API_KEY` | Required to generate analysis. From [console.anthropic.com](https://console.anthropic.com). |

To generate `SESSION_SECRET`, run this anywhere with Node, or use any password manager's generator:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating `APP_PASSWORD` takes effect on the next sign-in. Changing `SESSION_SECRET` immediately
invalidates every existing session, which is the lever to pull if the password leaks.

### 2. Storage — Upstash Redis

**There is no "KV" option in the Storage list any more.** Vercel retired its own KV product;
existing stores were migrated to Upstash Redis in December 2024, and new ones come from the
Marketplace. The wire protocol did not change, so nothing in this repo needs rewriting — only the
place you click.

Pick whichever route suits you:

**A — Vercel Marketplace (keeps billing in Vercel).**
Vercel → **Storage → Browse Marketplace / Create Database → Upstash → Redis**. Provision it and
connect it to this project. Vercel injects the credentials automatically.

**B — Upstash directly (no Marketplace, has a free tier).**
Create a database at [upstash.com](https://upstash.com), open it, and copy the two **REST API**
values. Add them in Vercel → Settings → Environment Variables as either name pair below.

| URL variable | Token variable | Comes from |
|---|---|---|
| `KV_REST_API_URL` | `KV_REST_API_TOKEN` | Vercel KV, and the aliases Upstash still sets |
| `UPSTASH_REDIS_REST_URL` | `UPSTASH_REDIS_REST_TOKEN` | Upstash native naming |
| `REDIS_REST_URL` | `REDIS_REST_TOKEN` | some other providers |

**It must be a Redis with an HTTP/REST API.** Upstash has one. A TCP-only provider will not work
here, because the functions talk over `fetch` with no client library — that is what keeps this repo
dependency-free.

Until storage is linked, everything works except saving: a banner in the header says storage isn't
linked, and creating a session returns a clear error naming exactly which variables it looked for.
That is deliberate — a session that looks saved and silently vanishes on the next cold start is the
worse outcome.

### 3. Check it after deploying

Replace `<domain>` and run these. The first two are the ones that matter.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/sessions       # expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/clients        # expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/module-trends  # expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/features       # expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/quote-wall     # expect 401
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/gtm-messaging  # expect 401
curl -s https://<domain>/ | grep -ci "customer"                              # expect 0
```

---

## Deploy

```bash
# repo already exists at github.com/cnelson9128/Product-Discovery-Sessions — push this code to it
git add -A && git commit -m "Initial build"
git push -u origin main

# import into Vercel
#   vercel.com → Add New → Project → pick the repo
#   Framework Preset: Other.  Build Command: none.
#   Output Directory: leave it to vercel.json, which sets `public`.
```

`api/` is picked up as serverless functions automatically, whatever the output directory is set to.

## Working on it locally

There is no build step, but the page needs the API, so opening `public/index.html` from disk will
just show the sign-in screen failing to reach the server. Run `npm install` once (pulls in
`mammoth`), then use the Vercel CLI:

```bash
npm install
npx vercel dev
```

with a `.env.local` holding `SESSION_SECRET` and `APP_PASSWORD`. Leave the Redis and Anthropic
variables out and the app will correctly show its "storage not linked" banner and refuse to save —
everything else (sign-in, navigation, forms) still works.

## How to use it

1. **+ New session** — pick the client from the managed list (or add a new one inline — see below),
   who ran the interview, which of the 11 session types the call was about, the date, and optionally who
   was on the call. Paste the transcript, or upload a `.txt`/`.docx` file — either way you can review
   and edit the text before submitting.
2. Submitting creates the session and kicks off analysis immediately; the detail page opens into a
   loading state while it runs (generation can take up to a minute or two for a full transcript).
3. The detail page shows one answer per standard question — how it works today and where it breaks
   down, value created, who benefits/who doesn't, adoption blockers, the v1 comparison verdict, trust
   concerns, migration blockers and conditions, the single top-priority improvement, the success
   metric, and the one-sentence pitch — each grounded in what the customer actually said, with a
   quote or paraphrase as evidence, and "Not raised in this call" wherever a question wasn't
   substantively answered. **Regenerate** re-runs the analysis from the same transcript.
4. The dashboard lists every session with its module, a status badge (Draft/Ready/Error), and text
   + module filters.
5. **Modules** (top nav) lists all 11 session types with their analyzed/total session counts and
   trend status. Each module's page always shows its **feature prioritization** board — one card per
   feature, sorted into **Launch** / **Phase 2** / **Future Considerations** — independent of whether
   a trend has ever been built for it. That's because cards aren't sourced from a per-module build
   any more: every session, the moment it's analyzed, is separately scanned for every feature,
   problem, request, or opportunity it raises, and each one is filed under whichever module its
   *content* is actually about — not the module the session itself happened to be tagged with. A
   Search & Match complaint raised mid-way through a Job Workflows or Introduction session lands
   under Search & Match, automatically, with no "Build" click needed. Each card shows the module it's
   confident about; a low-confidence classification gets a **Needs review** pill and an expandable
   "Why here?" panel with the classifier's reasoning, the transcript evidence, and any secondary
   module it's also relevant to. The board is styled like a Jira/Trello kanban — neutral columns,
   white cards with a colored left-edge accent matching their bucket, a card count badge on each
   column header, and an owner avatar (initials, generated from the free-text owner name) on every
   card — though moving a card is still done via its dropdowns rather than an actual drag gesture.
   Every card links back to the specific session it came from (resolved to client name + date, never
   written into the generated text itself — see the anti-fabrication note below), and carries
   controls to:
   - **Move it to a different bucket**, or **to a different module entirely** (two dropdowns — the
     bucket dropdown doubles as a colored status pill). Moving it to a different module is a manual
     override: the parser will never move it again on a later re-analysis, and a **📌 Manual** button
     appears to hand it back — click it to restore the parser's own classification.
   - **Assign an owner** (free text, inline on the card, shown as an initials avatar).
   - **Mark requirements done** (a checkbox — independent of delivery) and/or **mark complete**.
   - **Remove it** from the board (with a confirmation — this one has no undo).

   All of these save immediately, independent of any rebuild. **Build trend** (still available per
   module) is now purely a narrative synthesis — a **Value created** section (standout "wow" quotes
   pulled from sessions' own value-created statements and one-sentence pitches — a single striking
   reaction is enough to earn a spot here), adoption blockers, and draft GTM messaging, from every
   analyzed session tagged to that module. It's unrelated to feature cards and never creates, moves,
   or removes one — a failed or repeated build can't corrupt the board either way.
6. **Quote Wall** (top nav) pulls every module's "wow" quotes into one place, shown as a wall of
   individual quote cards (grouped by module) rather than a stacked list — the same card treatment
   used for the "Value created" quotes on each module's own trend page. Each is attributed to a
   client name + date resolved from session data — the same anti-fabrication resolution used
   everywhere else, never text the model wrote itself.
7. **Go-to-Market** (top nav) is the same synthesis idea one level up: built from every analyzed
   session across *all* modules at once, not scoped to one. **Build**/**Refresh** synthesizes an
   overall positioning statement, value pillars, proof points, objection handling, and a one-line
   highlight per module that has enough signal to support one — each grounded across more than one
   customer or module, so a single session's one-off comment shows up in that module's own trend
   rather than here.
8. **Reports** (top nav) is the monthly board pack, led with four hero stat tiles (sessions held,
   features logged, complete, requirements done), a progress ring for sessions held toward the
   10-per-session-type goal, and a donut chart for the overall Launch/Phase 2/Future Considerations
   mix — all backed by the same detailed, precise stacked-bar breakdown per module underneath (the
   donut and ring are an at-a-glance summary layered on top of that data, not a replacement for it).
   **Print / save as PDF** hides the nav and buttons for a clean printout. Feature data is live — it
   reflects the current board (any bucket move, module move, owner, or completion) at the moment you
   open the tab, not a snapshot from the last trend build.

**Managed client list, not free text.** ~10 clients are each expected to generate many sessions over
the program, so — same reasoning as the fixed module list — clients are chosen from a small managed
roster (`pds:clients` in Redis) rather than typed freely, so "Acme" and "Acme Ltd" never split one
client's sessions in two. Add a new client inline from the session form the first time they're
interviewed.

**Worth knowing before this is used for real calls:** a transcript is sent to Anthropic's API to
generate the per-session analysis, and everything is stored in the same Redis store. A `.docx`
upload additionally passes through this app's own server (never a third party) to be converted to
text. Don't paste anything into it that shouldn't leave the building.

**No synthesis prompt ever writes a client name into generated text** — the raised-items extraction
that feeds feature cards, the module-trend and Go-to-Market prompts, and the Quote Wall's underlying
data. Each is given a session's client name only so it can reason about which distinct customers
said what, but every output item cites
`supporting_session_ids` instead of naming anyone — the frontend resolves those to client/date
chips from data it already trusts (the session list), not from model recall. A "wow" quote is
constrained to cite exactly one session id, since it's meant to be one person's specific reaction —
this is what lets the Quote Wall show unambiguous "who said this" attribution without ever trusting
the model to write a name. This avoids a real attribution-error risk once synthesizing across many
sessions, and makes messaging drafts structurally incapable of leaking a client name into copy that
might get reused externally.

**Cost**, at `claude-opus-5` rates: roughly a few cents per session analysis, plus a similar small
call for that session's feature/module classification (runs in parallel, so it adds no wait time),
and a similar order of magnitude per module-trend or Go-to-Market build depending on how many
sessions feed it (the Go-to-Market build reads every analyzed session across every module, so it's
the priciest single generation in the app once the program is at full scale — still comfortably a
few cents to low tens of cents, not dollars). There's no rate limiting on who can trigger a
generation beyond being signed in — acceptable for a small internal tool, worth revisiting if usage
patterns suggest otherwise.

## How it fits together

```
public/
  index.html     shell: sign-in screen + dashboard + new-session form + session detail +
                  modules overview + module trend detail + quote wall + go-to-market view + reports.
  robots.txt
api/             serverless functions (zero-config, picked up by Vercel)
  login.js                password -> role-less signed HttpOnly cookie
  logout.js                clears it
  session.js               "am I signed in?", called on page load
  clients.js              managed client list (GET) + add (POST) — session required
  sessions.js             list/detail (GET) + create/update/delete (POST) — session required
  sessions-analyze.js     generates/regenerates a session's 11-question analysis AND its raised-items
                          extraction (in parallel) — longer maxDuration
  module-trends.js        module trend metadata/detail (GET) — session required
  module-trends-build.js  (re)builds a module's narrative trend (overview/quotes/blockers/GTM) —
                          longer maxDuration; does not touch feature cards at all
  features.js             CRUD for roadmap feature cards: list/filter (GET), update/delete/
                          resetClassification (POST) — session required
  quote-wall.js           every module's "wow" quotes in one response (GET) — session required
  gtm-messaging.js        overall go-to-market record (GET) — session required
  gtm-messaging-build.js  (re)builds it from every analyzed session across all modules — longer maxDuration
  parse-transcript.js     .docx -> plain text via mammoth — session required
  admin-migrate-features.js  one-time, idempotent: migrates any pre-upgrade trend's embedded cards
                          into pds:feature:index — see "Upgrading" below
  admin-reclassify-features.js  one-time (but re-runnable), idempotent: backfills raisedItems for
                          sessions analyzed before content-based classification shipped, and
                          reclassifies legacy feature cards — longer maxDuration, see "Upgrading" below
lib/             never served over HTTP
  auth.js              HMAC session tokens, constant-time password check, single shared password
  store.js             Redis REST access — sessions, clients, roadmap features, module trends, the
                       gtm record, login throttling
  modules.js            the 11 fixed session types (id + label) and validation
  analysis.js           builds the per-session 11-question analysis prompt
  raised-items.js        builds the per-session extraction prompt: every feature/problem/request/
                          opportunity raised, classified by content into the module it's actually
                          about — independent of the session's own tagged module
  module-classification.js  single source of truth for what each module means (used by both
                          raised-items.js and the standalone reclassifier below) and the shared
                          classification JSON-schema fragment
  feature-sync.js         turns one session's extracted items into feature-index records, keyed so
                          re-analysis updates a card in place and never touches a manually-moved one
  buckets.js              the three roadmap priority buckets (launch/phase2/bau) and validation
  module-trends.js       builds the per-module narrative trend synthesis prompt (overview, "wow"
                          quotes, adoption blockers, GTM messaging) — no longer touches feature cards
  gtm-messaging.js        builds the overall, cross-module go-to-market synthesis prompt
  anthropic-client.js    shared streaming call + error handling, used by every prompt file above
vercel.json      static root, security headers, every long-running build endpoint's maxDuration
test/            node --test suite (`npm test`) — feature classification/sync, the features API's
                 pure validation/patch logic, and the reclassify endpoint's idempotency
package.json     pins Node 22. One dependency (mammoth). No build script.
```

The session token is an HMAC-signed `{iat, exp}` — no server-side session store to provision, and
nothing secret inside the cookie, and no `role` field since there's only one kind of session.
Verified with a constant-time comparison, so a tampered payload, a reused signature, or an expired
token are all rejected. The password itself is compared through a SHA-256 digest so the comparison
is over a fixed 32 bytes and does not leak length through timing. Failed sign-ins are throttled per
IP — 10 in 15 minutes — when Redis is linked.

## Data model

| Key | Holds |
|---|---|
| `pds:session:index` | Lightweight metadata (incl. `module`) for every session — no transcript, no analysis. What the dashboard and module-count views read. |
| `pds:session:<id>` | One session's full record: metadata, transcript, the 11-question `analysis`, and the separate `raisedItems` extraction (every feature/problem/request/opportunity found in the transcript, each pre-classified into its module). Fetched only when that session's detail view is opened, when building a module's narrative trend, or when syncing feature cards. |
| `pds:clients` | A JSON array of managed client names. |
| `pds:feature:index` | **The roadmap board.** One JSON array of every feature card, across every module, as a single flat collection (not split index+detail like sessions — a feature record has no heavy payload, so every reader wants the full thing anyway). Each: `{id, module, secondaryModules, confidence, classificationReason, item, rationale, evidenceQuote, supporting_session_ids, sourceSessionId, sourceItemKey}` (model-authored/classified, only `module` user-editable — see below) plus `{bucket, owner, complete, requirementsDone}` (fully user-editable via `api/features.js`), `isManualModule`/`moduleHistory` (set when a human moves `module` by hand — see "Manual overrides" below), and `createdAt`/`updatedAt`. `sourceSessionId`+`sourceItemKey` (`` `${sessionId}#${itemIndex}` ``) link a card back to the exact extracted item it came from, so re-analyzing that session updates the same card rather than duplicating it. |
| `pds:trend:<moduleId>` | One module's last trend build: status, which session ids it was built from, and the synthesized result — `overview_summary`, `value_moments` (the "wow" quotes, each citing exactly one session id), `adoption_blockers`, `gtm_messaging`. No longer holds feature cards or counts — those live in `pds:feature:index` now and are computed live wherever they're needed. |
| `pds:gtm` | The one overall go-to-market record: same shape as a module trend, but built across every module at once. |

Two Redis keys per session (index + full record), not one blob: transcripts can run to tens of
thousands of characters, and a dashboard that had to read every transcript just to list rows would
only get slower as the team logs more sessions. The same split motivates keeping module trends (and
the overall go-to-market record) as their own keys rather than folding them into the session index.

A trend's staleness (shown as "N new sessions since last build" or "up to date") is computed on read
by diffing its `builtFromSessionIds` against the current set of ready sessions it's scoped to (one
module's, or — for the go-to-market record — every module's) — never stored as a flag, so it's
always correct even after a session is edited, reassigned to a different module, or deleted, with no
separate invalidation step to remember. A failed rebuild persists the error but keeps the previous
`result`, so a bad refresh never wipes a working trend or the go-to-market record — and never
touches `pds:feature:index` at all, so a failed rebuild can't corrupt the board either.

## Manual overrides on a feature card's module

Moving a card to a different module (the module dropdown on its card) is always a manual override:
it sets `isManualModule` and appends `{at, from, to}` to `moduleHistory` (there's no per-user
identity in this app — one shared password, no roles — so "who" isn't recorded, only when and
between which two modules). From then on, `lib/feature-sync.js` will never move that card again on a
later re-analysis of its source session — only its `item`/`rationale`/`evidenceQuote` text still
refreshes, since that's the parser's read of what was said, not a classification judgment call. A
**📌 Manual** button appears on the card; clicking it (`resetClassification`) hands it back to the
parser — recomputed instantly from the session's already-stored classification when the card is
linked to one, or via one small reclassification call for a legacy card that isn't.

## Upgrading from before content-based classification

If this deployment already has feature cards from before per-item content-based classification
shipped, hit `POST /api/admin-reclassify-features` once after deploying — from a signed-in browser
console, or `curl -b <your session cookie> https://<domain>/api/admin-reclassify-features -X POST`.
It backfills `raisedItems` for any already-analyzed session that predates this feature (without
touching that session's existing 11-question `analysis`) and syncs feature cards from it, then
reclassifies any remaining legacy card that isn't yet linked to a specific extracted item and hasn't
been manually moved. It's idempotent — safe to run more than once; a session or card already handled
is skipped on a later call, so if a large backlog doesn't finish inside one request's time limit,
just call it again.

## Upgrading from before the roadmap-board change

If this deployment already has module trends built under the even older model (feature cards nested
inside each `pds:trend:<moduleId>.result.cards`), hit `POST /api/admin-migrate-features` once after
deploying — from a signed-in browser console, or `curl -b <your session cookie>
https://<domain>/api/admin-migrate-features -X POST`. It moves every old-shape card into
`pds:feature:index` (keeping its existing id, bucket, and completion state) and strips the
now-unused `cards`/`counts` fields from each trend record. It's idempotent — safe to run more than
once, and a true no-op on a deployment with nothing to migrate (including a brand-new install). Run
this one first if it applies, then `admin-reclassify-features` above.

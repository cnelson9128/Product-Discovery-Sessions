# Firefish Product Discovery Sessions — internal hosting

An internal tool on Vercel supporting Firefish's v2 product-discovery research program: roughly 10
clients, ~100 sessions over 8-10 weeks, each session tagged to one of 11 fixed session types (10
specific v2 product modules plus a general Introduction Session), each asking the same 11 standard
validation questions (today's process, value created, who benefits,
adoption blockers, v1 vs v2, trust concerns, migration blockers/conditions, top priority
improvement, success metric, one-sentence pitch). Every session's transcript is analyzed into
structured answers to those 11 questions, and once a module has multiple analyzed sessions its
answers can be synthesized on demand into a **module trend** — feature prioritization
(now/later/future), adoption blockers, and draft messaging specific to that one module. A level
above that, a **Go-to-Market view** synthesizes across every analyzed session in every module at
once — one overall positioning statement, value pillars, proof points, objection handling, and a
per-module highlight reel, built only from what recurs across more than one customer or module
rather than any single session's one-off comment.

Distinct from the sibling `competitor-analysis` repo's sales-facing demo-prep tool — this is PM/
research interviews about product needs, not sales calls. A static shell in `public/`, plus
serverless functions in `api/` that hold session data. No build step, and one runtime dependency —
`mammoth`, used only to read uploaded `.docx` transcripts.

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
5. **Modules** (top nav) lists all 11 session types with their analyzed/total session counts and trend
   status. Once a module has at least one analyzed session, **Build trend** synthesizes its feature
   prioritization (now/later/future), adoption blockers, and draft messaging from every analyzed
   session tagged to it — worth more with several sessions, and re-runnable any time as more land
   (**Refresh trend**, with a badge showing how many sessions have been added or removed/reassigned
   since the last build). Every prioritized item and blocker links back to the specific sessions that
   support it (resolved to client name + date, never written into the generated text itself — see
   the anti-fabrication note below).
6. **Go-to-Market** (top nav) is the same idea one level up: built from every analyzed session across
   *all* modules at once, not scoped to one. **Build**/**Refresh** synthesizes an overall positioning
   statement, value pillars, proof points, objection handling, and a one-line highlight per module
   that has enough signal to support one — each grounded across more than one customer or module, so
   a single session's one-off comment shows up in that module's own trend rather than here.

**Managed client list, not free text.** ~10 clients are each expected to generate many sessions over
the program, so — same reasoning as the fixed module list — clients are chosen from a small managed
roster (`pds:clients` in Redis) rather than typed freely, so "Acme" and "Acme Ltd" never split one
client's sessions in two. Add a new client inline from the session form the first time they're
interviewed.

**Worth knowing before this is used for real calls:** a transcript is sent to Anthropic's API to
generate the per-session analysis, and everything is stored in the same Redis store. A `.docx`
upload additionally passes through this app's own server (never a third party) to be converted to
text. Don't paste anything into it that shouldn't leave the building.

**Neither trend view ever writes a client name into generated text.** Both the module-trend and the
Go-to-Market synthesis prompts are given each session's client name only so they can reason about
which distinct customers said what, but every output item cites `supporting_session_ids` instead of
naming anyone — the frontend resolves those to client/date chips from data it already trusts (the
session list), not from model recall. This avoids a real attribution-error risk once synthesizing
across many sessions, and makes messaging drafts structurally incapable of leaking a client name
into copy that might get reused externally.

**Cost**, at `claude-opus-5` rates: roughly a few cents per session analysis, and a similar order of
magnitude per module-trend or Go-to-Market build depending on how many sessions feed it (the
Go-to-Market build reads every analyzed session across every module, so it's the priciest single
generation in the app once the program is at full scale — still comfortably a few cents to low tens
of cents, not dollars). There's no rate limiting on who can trigger a generation beyond being signed
in — acceptable for a small internal tool, worth revisiting if usage patterns suggest otherwise.

## How it fits together

```
public/
  index.html     shell: sign-in screen + dashboard + new-session form + session detail +
                  modules overview + module trend detail + go-to-market view.
  robots.txt
api/             serverless functions (zero-config, picked up by Vercel)
  login.js                password -> role-less signed HttpOnly cookie
  logout.js                clears it
  session.js               "am I signed in?", called on page load
  clients.js              managed client list (GET) + add (POST) — session required
  sessions.js             list/detail (GET) + create/update/delete (POST) — session required
  sessions-analyze.js     generates/regenerates a session's 11-question analysis — longer maxDuration
  module-trends.js        module trend metadata/detail (GET) — session required
  module-trends-build.js  (re)builds a module's trend from its analyzed sessions — longer maxDuration
  gtm-messaging.js        overall go-to-market record (GET) — session required
  gtm-messaging-build.js  (re)builds it from every analyzed session across all modules — longer maxDuration
  parse-transcript.js     .docx -> plain text via mammoth — session required
lib/             never served over HTTP
  auth.js              HMAC session tokens, constant-time password check, single shared password
  store.js             Redis REST access — sessions, clients, module trends, the gtm record, login throttling
  modules.js            the 11 fixed session types (id + label) and validation
  analysis.js           builds the per-session 11-question analysis prompt
  module-trends.js       builds the per-module trend synthesis prompt
  gtm-messaging.js        builds the overall, cross-module go-to-market synthesis prompt
  anthropic-client.js    shared streaming call + error handling, used by all three prompt files above
vercel.json      static root, security headers, all three long-running endpoints' maxDuration
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
| `pds:session:<id>` | One session's full record: metadata, transcript, and the 11-question analysis. Fetched only when that session's detail view is opened, or when building a module trend. |
| `pds:clients` | A JSON array of managed client names. |
| `pds:trend:<moduleId>` | One module's last trend build: status, which session ids it was built from, and the synthesized result. |
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
`result`, so a bad refresh never wipes a working trend or the go-to-market record.

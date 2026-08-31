# Firefish Product Discovery Sessions — internal hosting

An internal tool on Vercel supporting Firefish's v2 product-discovery research program: roughly 10
clients, ~100 sessions over 8-10 weeks, each session about one of 10 fixed product modules, each
asking the same 11 standard validation questions (today's process, value created, who benefits,
adoption blockers, v1 vs v2, trust concerns, migration blockers/conditions, top priority
improvement, success metric, one-sentence pitch). Every session's transcript is analyzed into
structured answers to those 11 questions, and once a module has multiple analyzed sessions its
answers can be synthesized on demand into a **module trend** — feature prioritization
(now/later/future), adoption blockers, and draft go-to-market messaging.

Distinct from the sibling `competitor-analysis` repo's sales-facing demo-prep tool — this is PM/
research interviews about product needs, not sales calls. A static shell in `public/`, plus
serverless functions in `api/` that hold session data. No build step, and one runtime dependency —
`mammoth`, used only to read uploaded `.docx` transcripts.

---

## Access — there is none. Read this before you deploy.

**This app has no login, no password, and no session concept of any kind — this was a deliberate,
explicit choice, not an oversight.** Every `/api/*` endpoint answers any request that reaches it, and
`public/index.html` renders straight into the full app for anyone who loads it. There is no signed
cookie, no shared password, nothing gating `/api/sessions`, `/api/clients`, or `/api/module-trends`.

**Discovery-call transcripts name real customers or prospects and describe their pain points, in
their own words.** With no application-level access control, the only thing standing between that
data and the public internet is whatever you put in front of it at the hosting layer — see below.
Do not deploy this to a public URL without one of those in place, and do not point it at a custom
domain you'd expect a search engine or a curious visitor to stumble onto (the `X-Robots-Tag` header
and `robots.txt` discourage crawling, but neither restricts access).

**You almost certainly want Vercel Deployment Protection**, since the app itself no longer provides
any door at all:

| Option | Who gets in | Notes |
|---|---|---|
| **Vercel Authentication** | Anyone in your Vercel team | Requires each viewer to be a Vercel team member. |
| **Password Protection** | Anyone with the shared password | Simplest to hand to a small external research team; paid-plan feature — check your plan. |
| **Trusted IPs** | Only your office/VPN ranges | Tightest, but breaks home/mobile access. |

Set this under the project's **Settings → Deployment Protection**, covering **Production** (the
default only covers Preview deployments). If you'd rather re-add an in-app password gate instead —
or alongside — the sibling `competitor-analysis` repo's `lib/auth.js`/`api/login.js` is a working
reference for exactly that pattern.

---

## Set this up — the site will not work until you do

### 1. Environment variables

Vercel → the project → **Settings → Environment Variables**. Add this to **Production** (and
Preview, if you use preview deployments):

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Required to generate analysis. From [console.anthropic.com](https://console.anthropic.com). |

That's the only one the code reads. Redis credentials (below) are also required for anything to
save, but come from a Vercel integration rather than being typed in by hand.

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

Replace `<domain>`. Since there's no app-level auth, this only confirms the app itself is working —
it does **not** confirm the data is private. Privacy comes entirely from whatever Deployment
Protection (or other gate) you put in front of it — verify that separately, e.g. by opening the URL
in an incognito window and confirming it actually challenges you.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/api/sessions       # expect 200 (or 401/403 from your gate, if one is set up)
curl -s https://<domain>/ | grep -ci "Product Discovery"                     # expect 1+ — confirms the app itself loaded
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
just show it failing to reach the server. Run `npm install` once (pulls in `mammoth`), then use the
Vercel CLI:

```bash
npm install
npx vercel dev
```

Leave `.env.local` empty, or without the Redis variables, and the app will boot straight in showing
the "storage not linked" banner and refuse to save — everything else (navigation, forms) still
works. Add `ANTHROPIC_API_KEY` locally to test real generation.

## How to use it

1. **+ New session** — pick the client from the managed list (or add a new one inline — see below),
   who ran the interview, which of the 10 modules the call was about, the date, and optionally who
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
5. **Modules** (top nav) lists all 10 modules with their analyzed/total session counts and trend
   status. Once a module has at least one analyzed session, **Build trend** synthesizes its feature
   prioritization (now/later/future), adoption blockers, and draft GTM messaging from every analyzed
   session tagged to it — worth more with several sessions, and re-runnable any time as more land
   (**Refresh trend**, with a badge showing how many sessions have been added or removed/reassigned
   since the last build). Every prioritized item and blocker links back to the specific sessions that
   support it (resolved to client name + date, never written into the generated text itself — see
   the anti-fabrication note below).

**Managed client list, not free text.** ~10 clients are each expected to generate many sessions over
the program, so — same reasoning as the fixed module list — clients are chosen from a small managed
roster (`pds:clients` in Redis) rather than typed freely, so "Acme" and "Acme Ltd" never split one
client's sessions in two. Add a new client inline from the session form the first time they're
interviewed.

**Worth knowing before this is used for real calls:** a transcript is sent to Anthropic's API to
generate the per-session analysis, and everything is stored in the same Redis store. A `.docx`
upload additionally passes through this app's own server (never a third party) to be converted to
text. Don't paste anything into it that shouldn't leave the building.

**Module trends never write a client name into generated text.** The synthesis prompt is given each
session's client name only so it can reason about which distinct customers said what, but every
output item cites `supporting_session_ids` instead of naming anyone — the frontend resolves those to
client/date chips from data it already trusts (the session list), not from model recall. This avoids
a real attribution-error risk once synthesizing across many sessions, and makes go-to-market
messaging drafts structurally incapable of leaking a client name into copy that might get reused
externally.

**Cost**, at `claude-opus-5` rates: roughly a few cents per session analysis, and a similar order of
magnitude per module-trend build depending on how many sessions feed it. There is no rate limiting
on who can trigger a generation at all — anyone who can reach the app can run up API cost, same as
anyone who can reach it can read every session. This is the same access-control gap described above,
not a separate one; whatever gate you put in front of the app covers both.

## How it fits together

```
public/
  index.html     shell: dashboard + new-session form + session detail +
                  modules overview + module trend detail. No auth screen.
  robots.txt
api/             serverless functions (zero-config, picked up by Vercel) — none require auth
  status.js               "is Redis linked?", called on page load to show/hide a banner
  clients.js              managed client list (GET) + add (POST)
  sessions.js             list/detail (GET) + create/update/delete (POST)
  sessions-analyze.js     generates/regenerates a session's 11-question analysis — longer maxDuration
  module-trends.js        module trend metadata/detail (GET)
  module-trends-build.js  (re)builds a module's trend from its analyzed sessions — longer maxDuration
  parse-transcript.js     .docx -> plain text via mammoth
lib/             never served over HTTP
  store.js            Redis REST access — sessions, clients, module trends
  modules.js           the 10 fixed modules (id + label) and validation
  analysis.js          builds the per-session 11-question analysis prompt
  module-trends.js      builds the cross-session module-trend synthesis prompt
  anthropic-client.js   shared streaming call + error handling, used by both prompt files above
vercel.json      static root, security headers, both long-running endpoints' maxDuration
package.json     pins Node 22. One dependency (mammoth). No build script.
```

## Data model

| Key | Holds |
|---|---|
| `pds:session:index` | Lightweight metadata (incl. `module`) for every session — no transcript, no analysis. What the dashboard and module-count views read. |
| `pds:session:<id>` | One session's full record: metadata, transcript, and the 11-question analysis. Fetched only when that session's detail view is opened, or when building a module trend. |
| `pds:clients` | A JSON array of managed client names. |
| `pds:trend:<moduleId>` | One module's last trend build: status, which session ids it was built from, and the synthesized result. |

Two Redis keys per session (index + full record), not one blob: transcripts can run to tens of
thousands of characters, and a dashboard that had to read every transcript just to list rows would
only get slower as the team logs more sessions. The same split motivates keeping module trends as a
separate key per module rather than folding them into the session index.

A module trend's staleness (shown as "N new sessions since last build" or "up to date") is computed
on read by diffing the trend's `builtFromSessionIds` against the module's current ready sessions —
never stored as a flag, so it's always correct even after a session is edited, reassigned to a
different module, or deleted, with no separate invalidation step to remember. A failed rebuild
persists the error but keeps the previous `result`, so a bad refresh never wipes a working trend.

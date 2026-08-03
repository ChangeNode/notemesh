# ob-sync on Railway

Two guides in one file.

- **[Part A — Publishing the template](#part-a--publishing-the-template)** is for the
  maintainer. It covers building the Railway template, the deploy button, how
  attribution and kickbacks actually work, and the support commitment.
- **[Part B — Deploying and using it](#part-b--deploying-and-using-it)** is for
  someone who found the template and wants their own instance.

---

# Part A — Publishing the template

## Before you start

### Decide whether the source is public

Publishing to the marketplace does **not** require open-sourcing this. Railway
supports closed-source templates deliberately, and they earn the same kickbacks.
Three workable shapes:

| | Source | Publishable | Kickbacks | Deployers can read the code |
| --- | --- | --- | --- | --- |
| **A. Open** | Public GitHub repo | Yes | Yes | Yes |
| **B. Private image** | Private Docker image | Yes | Yes | No |
| **C. Private repo** | Private GitHub repo | For your own Workspace/Org | — | No |

**A — public repo.** The conventional marketplace shape. Simplest to operate:
no registry, no build pipeline, Railway builds from the Dockerfile already in
this repo on every deploy.

**B — private Docker image.** This is Railway's sanctioned route for shipping
proprietary code. You publish a template whose service source is a private
image; Railway encrypts and stores the registry credentials, and for services
with hidden credentials *"SSH access is disabled and users cannot modify the
Docker image source."* Deployers can see that protected credentials are in use
but cannot read them or pull the image. Docker Hub and GitHub Container
Registry are both supported. See
[Going closed-source](#going-closed-source-the-private-image-route) for what it
costs you.

**C — private repo.** Railway does let a template point at a private GitHub
repo, but it is scoped to sharing inside your own Workspace or Organization
rather than to the public marketplace. If you want a public listing with a
private source, take route B.

`ChangeNode/ob-sync` is private today, so this is a real decision rather than a
formality — routes A and B both require action.

Two things worth weighing beyond mechanics:

- **This app holds the user's Obsidian account password.** It stores those
  credentials encrypted, runs with full read/write access to their vault, and
  asks them to trust a server they did not build. Being able to read the source
  is a large part of what makes that trade acceptable to a careful user. A
  closed-source credential-holding server is a harder sell, independent of
  whether it is technically allowed.
- **A private image is not a hard IP boundary.** The build output is JavaScript.
  Railway's protections are real *on Railway* — hidden credentials, no SSH, no
  swapping the image source — but anyone who obtains the image by other means
  reads a minified bundle, not machine code. Treat route B as "not casually
  readable", not as "secret".

Also worth settling before you publish, because they are awkward to change
afterwards:

- **The template name and description** become the marketplace listing.
- **The README** is what people read before deciding to deploy. It is the
  sales page whether you meant it to be or not.
- **A support expectation.** See [Support](#support-and-the-template-queue) —
  publishing puts you on the hook for a queue.

## 1. Create the template

Railway workspace → **Settings → Templates → New Template**.

1. **Add a service** — press <kbd>⌘</kbd>+<kbd>K</kbd> or click **Add New**, then
   pick the source that matches the route you chose above:
   - *Route A* — **GitHub Repo**, pointed at `ChangeNode/ob-sync`. Append
     `/tree/<branch>` to pin a branch rather than track the default one.
   - *Route B* — **Docker Image**, pointed at your published image (e.g.
     `ghcr.io/changenode/ob-sync:0.1.0`), with the registry credentials filled
     in under the service settings so Railway stores them hidden.
2. **Attach a volume** — right-click the service → **Attach Volume**, mount path
   `/data`. This holds the vault copy, the SQLite database, and the sync
   client's state. Without it, every redeploy wipes the instance and the user
   has to run the whole wizard again.
3. **Set the variables:**

   | Variable | Value | Why |
   | --- | --- | --- |
   | `ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` | 64 hex characters — exactly the 32 bytes of key material the server demands |
   | `DATA_DIR` | `/data` | Must match the volume mount path |

   Use the generator function, not a literal. A fixed value in a published
   template would ship the same encryption key to every deployment on the
   platform.

   A plain `${{secret()}}` will **not** work here: the server rejects anything
   that is not valid base64 or hex key material, so it would fail at boot. The
   `"abcdef0123456789"` alphabet argument is what makes it hex.

   `BASE_URL` is deliberately absent. The server derives its public origin from
   `RAILWAY_PUBLIC_DOMAIN` at startup, which is what you want on Railway. Only
   set `BASE_URL` for a custom domain.

4. **Settings** — healthcheck path `/api/health`. This is already in
   [`railway.json`](railway.json) along with the Dockerfile builder and restart
   policy, so Railway should pick it up; set it in the UI anyway so the template
   is self-describing.
5. **Enable public networking** so the deployed service gets a domain. The
   OAuth issuer is derived from that domain at boot, so a service that starts
   before it has one will advertise the wrong issuer until it restarts.

Then **Create Template**.

## 2. Deploy your own template before publishing it

Deploy it once from the template itself, as a stranger would — not from your
existing project. You are checking the things that only break on a fresh
deploy:

- The generated `ENCRYPTION_KEY` is accepted at boot (a bad generator argument
  shows up as an immediate crash loop, not a subtle bug).
- The volume mounts at `/data` and survives a redeploy.
- The healthcheck passes inside 120s.
- **You reach the setup page within 30 minutes** and can claim it — see
  [the claim window](#the-30-minute-claim-window).
- The whole wizard completes and an MCP client can connect over the public
  HTTPS URL.

## 3. Publish

From the template page, click **Publish** and fill in the form. It goes to the
[template marketplace](https://railway.com/templates).

## 4. The deploy button

Publishing gives you a **template code** — the short string in
`railway.com/new/template/<CODE>`. Put the button at the top of the README:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=generic)
```

HTML, if you prefer:

```html
<a href="https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway" /></a>
```

**On "affiliate codes":** there isn't one to paste, and you don't need one.
Attribution runs through the **template code** — the template belongs to your
workspace, so any deployment of it is credited to you whether it came from your
button, a link someone shared, or the marketplace listing. The `utm_*`
parameters are campaign analytics, not payment routing; you can change or drop
them without affecting what you earn. Nothing about the money depends on the
link a user happened to click.

## 5. Kickbacks

Railway pays template publishers a share of what deployments of their template
spend:

| | Share |
| --- | --- |
| Base kickback on usage costs | **15%** |
| Support bonus for working your Template Queue | **+10%** |
| **Total** | **25%** |

To qualify the template must be published to the marketplace and comply with
Railway's Fair Use Policy and Terms of Service.

Payouts default to Railway Credits. Cash is available through Stripe Connect,
withdrawn in **$100–$10,000** increments, usually processed instantly with funds
landing within about 10 business days. Cash withdrawal is unavailable in some
regions, including Brazil, China, and Russia.

This is recurring, not a one-off: you earn for as long as instances keep
running. It also means an instance someone deploys and abandons earns you
nothing much, and a happy long-running user earns steadily — which is the
argument for actually answering the queue.

## Support and the Template Queue

**Support for this template is provided through the Railway Template Queue.**
That is the single channel; it is deliberate, and it should be stated plainly in
the template description and the README so nobody expects email or GitHub
issues to be the route in.

How it works: when someone deploying your template has a question, it lands in
your Template Queue on [Central Station](https://station.railway.com/templates).
Railway emails you when a question arrives and nags occasionally if one is
sitting unanswered. Answering them is what earns the extra 10%.

One quirk worth knowing: if nobody asks anything, you still receive the full
25%. The bonus is not withheld for a quiet queue — it is withheld for an
ignored one.

Practical notes for answering ob-sync questions specifically:

- **"I can't create the admin account"** is almost always the claim window
  having closed. Tell them to restart the service; see
  [the claim window](#the-30-minute-claim-window).
- **"Claude can't connect"** is usually someone trying to add a `localhost` URL
  as a custom connector, or trying to install a `.mcpb` bundle. See
  [Connect an MCP client](#4-connect-an-mcp-client).
- **"It says needs re-authentication"** means the Obsidian session expired —
  the Status tab has a re-auth form.
- **Disk pressure** — the vault copy includes attachments, and the sync client
  keeps an append-only log that grows without bound. The Settings tab shows its
  path and size.

## Going closed-source: the private image route

Only relevant if you picked route B. What changes:

**You take on the build.** With a public repo Railway builds from the Dockerfile
on every deploy and you never think about it. With an image source, nothing
gets built unless you build and push it. That means CI — a workflow that builds
this repo's Dockerfile and pushes to GitHub Container Registry on each release.

**Tag deliberately.** Pointing the template at `:latest` means every existing
deployment picks up your next push, including a broken one, with no staging and
no rollback story. Point it at an explicit version (`:0.1.0`) and bump the
template when you have verified a release. Slower, and much easier to undo.

**Credentials.** For GHCR that is your GitHub username plus a personal access
token with `read:packages`. Enter it in the service settings so Railway encrypts
and hides it. Make it a token scoped to nothing else, because it lives in
Railway's hands for as long as the template does.

**Support gets harder, both ways.** Nobody can read the code to diagnose their
own problem, so more questions land in your queue. And you cannot ask a
deployer to check a line number or send a stack trace they can interpret — the
[Status tab log](#5-living-with-it) and the Security tab become the whole
diagnostic surface. Weigh that against the 10% support bonus being the part of
the kickback you have to work for.

**Version visibility.** With a public repo a user can tell what they are running
and when it changed. With an image they cannot, so put the version somewhere in
the UI or the logs, or you will get "is this the latest?" questions you have no
good way to answer.

## Keeping the template current

The template tracks the repo, so a push to the tracked branch is what
deployments of the template will build from next. Two habits worth keeping:

- Pin a branch (`/tree/<branch>`) if you want to develop on `main` without
  every new deployment picking up work in progress.
- Redeploy the template yourself after any change to the setup wizard, the
  environment variables, or the Dockerfile. Those are the parts a fresh deploy
  exercises and your own long-running instance does not.

---

# Part B — Deploying and using it

## What ob-sync does

It gives an AI assistant access to your Obsidian vault. The server joins your
vault as another Obsidian Sync client, keeps a live copy, and exposes it over
the Model Context Protocol so tools like Claude and Codex can search, read, and
edit your notes. Anything the assistant writes syncs back to your other devices
like any other edit.

## What you need

- **An Obsidian Sync subscription.** This is how the vault reaches the server;
  there is no way around it.
- **A Railway account.** The instance runs continuously, so it is not free.
- Five minutes, and the willingness to finish the setup in one sitting — see
  [the claim window](#the-30-minute-claim-window).

## 1. Deploy

Click the **Deploy on Railway** button in the README. Railway will:

- create the service from the template,
- attach a volume at `/data`,
- generate an `ENCRYPTION_KEY` unique to your deployment.

**Do not change `ENCRYPTION_KEY` later.** It encrypts your stored Obsidian
credentials and derives the session secret. Changing it locks the instance out
of its own stored credentials.

## 2. Give it a domain

**Settings → Networking → Generate Domain**, then redeploy.

The server works out its public address at startup, so a service that booted
before it had a domain will advertise the wrong one until it restarts. If you
generated the domain after the first deploy, redeploy before continuing.

## 3. Claim it and run the wizard

Open the service URL. You will land on the setup wizard.

### The 30-minute claim window

The first person to open a fresh instance creates the admin account — there is
no token to look up. To stop an instance you deployed and forgot about from
sitting open indefinitely, that is only possible **within 30 minutes of the
server starting**. The page shows a countdown.

If you miss it, the page says the server is locked down. That is not
unrecoverable: **restart the service** (Railway → your service → **Deployments**
→ **Restart**) and open the page again. You get another 30 minutes.

Then, in order:

1. **Create the admin account** — your email and a password of at least 10
   characters. These are for signing in to this dashboard, not your Obsidian
   account.
2. **Link your Obsidian account** — your Obsidian.md credentials, the ones with
   the Sync subscription. MFA is supported. They are stored encrypted so the
   sync client can re-authenticate when its session expires.
3. **Pick your vault** — choose from your remote vaults. Leave the encryption
   password **blank** unless your vault is end-to-end encrypted. Obsidian Sync
   defaults to managed encryption, which has no password; most people leave
   this empty.

The first sync can take a while on a large vault. When it finishes you land on
the dashboard.

## 4. Connect an MCP client

Everything below is shown on the **Setup** tab with your own URL filled in and
copy buttons, so you do not have to transcribe anything.

Your endpoint is `https://<your-app>.up.railway.app/api/mcp`.

**Claude (web, Desktop, Cowork)** — add it as a **custom connector**:
claude.ai → **Customize → Connectors → Add custom connector** → paste the URL.
Configure it once and it is available across your Claude apps. The OAuth flow
brings you back to your own server to approve access.

> Do not go looking for the *"drag .MCPB or .DXT files here"* box under
> Settings → Extensions. Those bundles package a **local** MCP server that runs
> on your own machine over stdio. ob-sync is a remote HTTP server, which is what
> custom connectors are for. There is no bundle to install.
>
> This also means a connector **cannot reach `localhost`** — Anthropic's
> infrastructure makes the connection, not your machine. That is exactly why
> you deployed it.

**Claude Code:**

```bash
claude mcp add --transport http ob-sync https://<your-app>.up.railway.app/api/mcp
```

Then run `/mcp` inside Claude Code to sign in.

**Codex** — add to `~/.codex/config.toml`, then `codex mcp login ob-sync`:

```toml
[mcp_servers.ob-sync]
url = "https://<your-app>.up.railway.app/api/mcp"
auth = "oauth"
default_tools_approval_mode = "approve"
```

Set the approval mode. Without it Codex prompts for every call, and because it
reports wall-clock timings, the seconds you spend approving get counted as tool
latency — which reads as a slow server when it isn't.

**Anything else** — create an API key on the **Setup** tab and send it as
`Authorization: Bearer <key>` or `x-api-key: <key>`.

## 5. Living with it

The dashboard has four tabs:

| Tab | What's there |
| --- | --- |
| **Setup** | Your MCP endpoint, per-client instructions, API keys |
| **Status** | Sync health, vault stats, live log, connected OAuth clients |
| **Settings** | The `delete_note` toggle, daily-note format, where logs are written |
| **Security** | Live posture of your instance — what holds access, what's exposed |

Things worth knowing:

- **Deleting notes is off by default.** Turn it on in Settings only if you want
  it; deletions propagate to every synced device.
- **Size the volume for attachments**, not just your markdown. The vault copy
  includes images, audio, PDFs, and video. The sync client also keeps an
  append-only log that grows without bound — the Settings tab shows its path
  and current size, and deleting it is safe while the daemon is stopped.
- **Writes reach the server's disk immediately** but take time to appear on your
  other devices, because that leg is ordinary Obsidian Sync. If you are testing,
  watch the Status tab rather than your phone.

## Getting help

Support for this template runs through the **Railway Template Queue**. Ask your
question from the template's page on Railway and it reaches the maintainer
directly; you will get a notification when it is answered.

Common answers first:

| Symptom | Cause |
| --- | --- |
| "Locked down", can't create an account | Claim window closed — restart the service, then reopen the page |
| Claude connector won't connect | A `localhost` URL, or trying to install an `.mcpb` bundle instead of adding a custom connector |
| "Needs re-authentication" | Obsidian session expired — re-auth form is on the Status tab |
| OAuth fails with an issuer error | Service booted before it had a domain — redeploy |
| Daily notes go to the wrong place | Set the folder and format on the Settings tab; the sync client does not sync your vault's `.obsidian` config |

---

ob-sync is an independent, unofficial project. It is not affiliated with,
endorsed by, or sponsored by Obsidian or Railway. "Obsidian" and "Obsidian Sync"
are trademarks of their respective owners.

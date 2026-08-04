# Commercial licensing

notemesh is dual-licensed.

## The open-source option — AGPL-3.0

The default. See [LICENSE](LICENSE). Free to use, modify, and self-host.

**Running your own instance triggers no obligation.** notemesh is single-user by
design: when you deploy it for yourself, you are the only user of that service,
and you already have the source. The AGPL's network clause asks you to offer
source to the *users of your service* — which, here, is you.

You are also free to publish your modifications, deploy them, and share them,
provided the source stays available under the AGPL.

## The commercial option

You need a commercial licence if you want to **offer notemesh to other people as
a hosted service without making your source available** — for example running it
as a paid product, bundling it into a platform you sell, or offering managed
instances to customers.

That is the case AGPL-3.0 §13 covers, and a commercial licence removes the
source-disclosure requirement for it.

**Contact:** <https://changenode.com/contact/>

Terms are negotiated per case; there is no published price list. Tell me what
you want to build and we'll work out something sensible.

## Why it's arranged this way

Everything about notemesh's ordinary use — self-hosting, modifying it, deploying
it on Railway, running it for your own vault — is free and always will be. The
licence only asks something of you at the point where you are selling access to
other people, which is the one case where sharing the value back is reasonable.

## Contributing

Because notemesh is dual-licensed, contributions need a Contributor Licence
Agreement. See [CONTRIBUTING.md](CONTRIBUTING.md) — it explains why in one
paragraph, and it exists so this arrangement doesn't quietly break the first
time someone sends a pull request.

## A note on `obsidian-headless`

The Obsidian Sync backend spawns Obsidian's official headless client, which is
published to npm as `UNLICENSED` — proprietary, by Dynalist Inc. Nothing here
relicenses it. It is invoked as a separate process and installed from npm by
whoever deploys notemesh, not redistributed by this project. If you intend to
ship a prebuilt container image containing it, check that with Obsidian first.

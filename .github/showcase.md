---
title: Musizeer
claim: Your music on your own server, from whichever services you choose.
summary: A self-hosted music manager where every music service comes as a sandboxed provider you install from a catalog.
color: "#8539EF"
since: 2026
cover: .github/showcase/cover.png
demo: image
demo_media: .github/showcase/install-permissions.png
features:
  - title: One library, yours
    text: Search catalogs, keep favorites and playlists, download into your own library, play it and keep it in sync with your media server.
  - title: Providers you choose
    text: Catalogs, downloaders, storage, media servers, lyrics and audio identification are separate programs you install, remove or replace.
  - title: A sandbox for each provider
    text: A provider gets no network but the destinations it declares, none of the host's environment, and no file of the host but its workspace and the folders it declares.
  - title: Made for phones too
    text: The web app works on a phone as well as on a desktop, administration included.
decisions:
  - what: The host never names a provider
    why: It iterates over what providers declare, so any of them can be replaced without touching the host.
  - what: Providers return data, the host decides
    why: Whether a result is the right track, when to retry and what needs approval are decided in one place, whichever provider answers.
  - what: Providers as OCI images listed in catalogs
    why: Each one is installed and updated on its own, and an admin sees what it asks for before installing it.
  - what: Sandboxes with bubblewrap behind a gateway
    why: A provider is outside code, so it runs with only what it declared.
---

I got hooked on self-hosted services and wanted something like Seerr, but for music. I couldn't find one, so in March 2026 I started writing it. The name comes from there: Musizeer, as if it belonged to the same family. I use it every day, like the rest of my home server.

Extensibility has been the heart of the project from the start, but the core had to exist first. The sandboxes came later, so that installing a provider from a source nobody has verified doesn't mean trusting it with your server. Other projects have appeared in the months since, but none of the ones I've seen was built to be extended.

I'm releasing it because I care about open source. The arr stack and the services around it have given me a lot, and this is my way of giving something back. [Burnarr](https://github.com/sossiogll/burnarr), which I built alongside it, comes from the same place: a need no self-hosted service I could find was covering.

![Musizeer on a phone: Home, an album and Administration](.github/showcase/phones.png)

*The screenshots show invented music and invented providers.*

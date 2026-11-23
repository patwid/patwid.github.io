+++
title = "IRC with a Bouncer: soju, senpai and goguma"
date = 2026-11-23
draft = false
description = "Why I still use IRC, what a bouncer like soju adds, and how mine runs on my NAS, reachable only over my NetBird mesh from senpai on the desktop and goguma on the phone."
tags = ["irc", "soju", "nixos", "nix", "self-hosting", "netbird"]
categories = ["linux"]
+++

Most of the projects I care about talk on IRC: NixOS, qutebrowser, Asahi,
Alpine, sourcehut, and the whole family of emersion's tools. So IRC is my
chat. What made it work for me is not the client, but the *bouncer* between
the client and the networks: [soju](https://soju.im), running on my NAS.

This post covers what a bouncer is for, why soju, and how mine is set up: on
NixOS, with a real TLS certificate, and reachable only over my
[NetBird mesh]({{< relref "self-hosted-netbird-on-nixos.md" >}}), from
[senpai](https://sr.ht/~delthas/senpai/) on the desktops and
[goguma](https://codeberg.org/emersion/goguma) on my phone.

<!--more-->

## The problem with plain IRC

IRC is simple. A client connects to a network, joins channels, and sees
what's said while it's connected. That last part is the catch: there is no
history on the server. Close the laptop and you miss everything until you
reconnect, and a message sent to you while you were away is just gone.

It also means every device is its own connection. The desktop, the laptop
and the phone each show up as a separate user, each with its own
half of the conversation.

## What a bouncer does

A bouncer is an IRC client that never disconnects, and an IRC server for my
own clients at the same time. It stays connected to the networks, in all my
channels, and keeps a log of everything. My clients connect to the bouncer
instead of the networks:

```
senpai (desktop) ─┐
senpai (laptop)  ─┼─► soju (NAS) ─┬─► irc.libera.chat
goguma (phone)   ─┘               └─► irc.oftc.net
```

The networks see one user that is always there. When a client connects, it
gets what it missed. Any number of clients can be connected at once, and
they all see the same thing.

[ZNC](https://znc.in) is the classic bouncer, and it does this well. But it
predates most of modern IRC, and a client connected to ZNC mostly gets
replayed lines, with one connection per network.

## Why soju

soju is built around [IRCv3](https://ircv3.net), the set of extensions that
modernise the protocol, and some it defines itself. With a client that
speaks them, the bouncer stops feeling like a bolt-on:

- **History on demand.** Instead of replaying a fixed buffer on connect,
  soju offers `chathistory`: the client asks for history as it needs it,
  e.g. when I scroll up in a channel.
- **One connection for all networks.** With `soju.im/bouncer-networks`, a
  client logs in once and sees every network the bouncer is connected to.
  It can even add networks itself.
- **Read markers.** soju remembers what has been read, and tells every
  client. Read something on the phone and it isn't unread on the desktop
  anymore.
- **Push notifications.** soju can send Web Push notifications, so a phone
  client doesn't need to stay connected to be told about a highlight.

senpai and goguma are written with soju in mind, by people from the same
circle, and support all of the above. soju also comes with
[gamja](https://sr.ht/~emersion/gamja/), a web client, for when neither is
at hand.

## The setup

soju runs on my NAS, which is always on. The NAS is not reachable from the
internet, and I don't want it to be. Instead, soju is reachable only over
NetBird, the WireGuard mesh my machines and my phone are on.

That gives a few properties I like:

- **Nothing is exposed.** No port is open on my router, and the NixOS
  firewall doesn't open soju's port on the LAN either. NetBird lets mesh
  peers through on its own.
- **One address everywhere.** The bouncer is `chat.example.com`, whose A
  record points at the NAS's NetBird address. Every client uses that name, at
  home or not.
- **A real certificate.** As the name is real, Let's Encrypt can issue a
  certificate for it, so clients connect over plain `ircs://` with no
  self-signed certificate to trust.

The certificate can't be proved over HTTP, since Let's Encrypt can't reach
the NAS. It's proved by DNS instead: the ACME client creates a TXT record
through my DNS provider's API.

## soju on NixOS

NixOS has a module for soju. Mine listens on two addresses: `ircs` on 6697
for the native clients, and a plain WebSocket on loopback, which nginx serves
to gamja:

```nix
services.soju = {
  enable = true;
  hostName = domain;
  listen = [
    "ircs://:6697"
    "ws+insecure://127.0.0.1:${toString wsPort}"
  ];
  tlsCertificate = "${cert}/fullchain.pem";
  tlsCertificateKey = "${cert}/key.pem";
  # nginx, for gamja: the client's address is its X-Forwarded-For.
  acceptProxyIP = [ "localhost" ];
};
```

The certificate comes from NixOS's ACME module, with the DNS challenge:

```nix
security.acme.certs.chat = {
  inherit domain;
  dnsProvider = "infomaniak";
  environmentFile = config.sops.templates."acme-infomaniak.env".path;
  group = "soju-tls";
  reloadServices = [ "soju" ];
};
```

soju runs as a systemd dynamic user, so it can't be put into a group
beforehand. It reads the certificate through a supplementary group instead,
`soju-tls`, which nginx joins as well. On a renewal, soju is reloaded, which
swaps the certificate without dropping a connection:

```nix
users.groups.soju-tls = { };
users.users.${config.services.nginx.user}.extraGroups = [ "soju-tls" ];

systemd.services.soju = {
  wants = [ "acme-chat.service" ];
  after = [ "acme-chat.service" ];
  serviceConfig.SupplementaryGroups = [ "soju-tls" ];
};
```

### gamja

gamja is a static web app. nginx serves it at `https://chat.example.com`,
with the same certificate, and passes its WebSocket on to soju:

```nix
gamja = pkgs.gamja.override {
  gamjaConfig.server = {
    url = "/socket";
    auth = "mandatory";
    ping = 30;
  };
};

services.nginx.virtualHosts.${domain} = {
  onlySSL = true;
  useACMEHost = "chat";
  root = gamja;
  locations."/socket" = {
    proxyPass = "http://127.0.0.1:${toString wsPort}";
    proxyWebsockets = true;
  };
};
```

The `ping` is there because of nginx: it drops a WebSocket that's been quiet
for a minute, and soju doesn't ping idle clients. So gamja pings soju every
30 seconds, and the reply keeps the connection open.

## Users and networks

Unlike most of my NAS's services, soju's users, networks and channels are
not configuration. They're soju's own state, in `/var/lib/soju`, and are
managed through `sojuctl`, or by talking to `BouncerServ` from a client.

I still wanted the list of networks and channels in the flake, so a
reinstall doesn't depend on a backup. The module has them as a plain
attribute set:

```nix
networks = {
  libera = {
    addr = "irc.libera.chat";
    channels = [ "#nixos" "#qutebrowser" "#senpai" "#goguma" /* … */ ];
  };
  oftc = {
    addr = "irc.oftc.net";
    channels = [ "#asahi" "#alpine-linux" /* … */ ];
  };
};
```

and turns them into a script, `soju-setup`, that runs the `sojuctl`
commands to create the user, the networks and their channels. It skips
whatever exists already, so it can be run again after adding a channel:

```sh
ssh -t nas sudo soju-setup
```

It asks for the user's password, and, for each new network, the NickServ
password to authenticate with via SASL. Neither ends up in the
configuration. Channels I join or leave from a client afterwards are soju's
to keep, so the list in the flake is a starting point, not the truth.

## senpai on the desktops

[senpai](https://sr.ht/~delthas/senpai/) is a terminal client made for soju.
It logs into the bouncer once, shows every network, and fetches history as I
scroll. It's configured through a
[wrapper module]({{< relref "nix-wrapper-modules.md" >}}), on every desktop
that's on the mesh:

```nix
wrappers.senpai = lib.mkIf config.my.roles.home.enable {
  enable = true;
  settings = {
    # ircs on 6697 is senpai's default.
    address = config.inventory.chat.domain;
    nickname = config.inventory.user.name;
    password-cmd = [
      (lib.getExe' pkgs.himitsu "hiq")
      "-1dF" "password"
      "proto=pass" "name=soju"
    ];
  };
};
```

The password comes from
[himitsu]({{< relref "from-pass-to-himitsu.md" >}}), so it's never in a
file. Both the address and the nickname come from the same inventory the
NAS's configuration reads, so the client and the bouncer can't disagree.

## goguma on the phone

[goguma](https://codeberg.org/emersion/goguma) is a mobile IRC client, also
made for soju. It looks like a messenger, not a terminal: a list of
conversations, unread counts, and notifications.

The phone is a NetBird peer like any other machine, so goguma connects to
`chat.example.com` exactly as senpai does, with the same login. Because soju
keeps the read markers, what I read on the phone is read on the desktop, and
the other way round.

What I haven't set up yet are push notifications. soju supports them, and
goguma can receive them, so the phone wouldn't need to hold a connection
open all day to tell me about a mention. For now, goguma only notifies me
while it's connected.

The one thing to keep in mind: if NetBird isn't connected on the phone, the
bouncer is simply not there. That has been rare enough not to matter.

## Logging in

A client logs in as `patwid` to get all networks at once, which senpai,
goguma and gamja all support. A client without `bouncer-networks` support
can log in as `patwid/libera` instead, and gets a plain connection to that
one network, as if soju were the network itself.

## Trade-offs

- **The NAS is a dependency.** If it's down, I'm off IRC everywhere. The
  networks see me disconnect, and history has a gap.
- **The mesh is a dependency.** No NetBird, no bouncer. Exposing soju to the
  internet would remove that, but at the cost of a public login prompt I
  don't need.
- **A NetBird address change means a DNS change.** The A record holds the
  NAS's mesh address. If a reinstall loses NetBird's state, the NAS gets a new
  address, and the record has to follow by hand.

None of that has bitten me so far. What I got in return is IRC that behaves
like a modern messenger, on every device, without anyone else's server in the
middle.

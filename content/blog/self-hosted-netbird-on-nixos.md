+++
title = "A self-hosted NetBird on NixOS"
date = 2026-11-22
draft = false
description = "Running my own NetBird coordination server on a VPS: one binary behind nginx, declarative clients that join on first boot, and peers found by name rather than address."
tags = ["nixos", "netbird", "wireguard", "self-hosting", "networking"]
+++

I wanted my machines — desktop, laptop, a media PC and a NAS — to reach each
other from anywhere, without opening anything at home to the internet. A
WireGuard mesh is the obvious answer, and there are a few ways to get one
without managing keys by hand.

## Why NetBird

- **Tailscale** is the most polished option, but its coordination server is a
  hosted service. I wanted the control plane on my own machine.
- **Headscale** is a self-hosted, open-source implementation of Tailscale's
  coordination server. It works with the official clients, but it is a
  reimplementation that follows Tailscale's protocol rather than defining it,
  and it has no web UI of its own.
- **Plain WireGuard** means writing every peer into every other peer's config,
  and no NAT traversal beyond what you set up yourself.
- **NetBird** is open source end to end — server, dashboard and clients — and
  designed to be self-hosted. I was already using it for work, so the clients
  and CLI were familiar.

What tipped it: since version 0.62, the server is a single binary with an
embedded identity provider. Self-hosting used to mean management, signal,
relay and TURN services plus a Keycloak or Zitadel next to them. Now it is
one systemd unit and an nginx vhost.

## The shape of it

- A **VPS** runs the coordination server at `netbird.example.com`, behind
  nginx with a Let's Encrypt certificate.
- The **home machines** are the peers. Each runs the client and joins on its
  own with a setup key.
- The **NAS** doubles as an exit node that peers can opt into.
- Peers find each other as `<host>.nb.home.arpa`, served by NetBird's own DNS.

## The server

The `netbird-combined` package in nixpkgs provides `netbird-server`, which
bundles management, signal, relay, STUN and [Dex](https://dexidp.io/) as the
identity provider. It speaks cleartext HTTP/2 on loopback; nginx terminates
TLS in front of it.

Secrets are handled with [sops-nix](https://github.com/Mic92/sops-nix). The
config is generated as YAML with sops placeholders in place of the secrets,
and `sops.templates` renders the real values into `/run/secrets` at
activation, so nothing secret ends up in the Nix store.

Here is the whole server module:

```nix
{ config, lib, pkgs, ... }:
let
  domain = "netbird.example.com";
  url = "https://${domain}";
  backend = "127.0.0.1:8011";
  stunPort = 3478;
  stateDir = "/var/lib/netbird-server";

  secret = {
    sopsFile = ./secrets/netbird-server.yaml;
    restartUnits = [ "netbird-server.service" ];
  };
  inherit (config.sops) placeholder;

  configFile = (pkgs.formats.yaml { }).generate "netbird-server.yaml" {
    server = {
      listenAddress = backend;
      exposedAddress = "${url}:443";
      stunPorts = [ stunPort ];
      metricsPort = 9090;
      healthcheckAddress = "127.0.0.1:9000";
      logLevel = "info";
      logFile = "console";
      dataDir = stateDir;
      disableAnonymousMetrics = true;

      authSecret = placeholder.netbird-relay-auth;

      auth = {
        issuer = "${url}/oauth2";
        signKeyRefreshEnabled = true;
        sessionCookieEncryptionKey = placeholder.netbird-session-cookie;
        dashboardRedirectURIs = [
          "${url}/nb-auth"
          "${url}/nb-silent-auth"
        ];
        # where `netbird up` listens for the browser login's callback
        cliRedirectURIs = [ "http://localhost:53000/" ];
      };

      reverseProxy.trustedHTTPProxies = [ "127.0.0.1/32" ];

      store = {
        engine = "sqlite";
        encryptionKey = placeholder.netbird-store-encryption;
      };
    };
  };
in
{
  sops.secrets = {
    netbird-relay-auth = secret;
    netbird-store-encryption = secret;
    netbird-session-cookie = secret;
  };

  sops.templates."netbird-server.yaml" = {
    file = configFile;
    restartUnits = [ "netbird-server.service" ];
  };

  systemd.services.netbird-server = {
    description = "NetBird coordination server";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      ExecStart = "${lib.getExe' pkgs.netbird-combined "netbird-server"} --config ${
        config.sops.templates."netbird-server.yaml".path
      }";
      Restart = "always";
      StateDirectory = "netbird-server";
      StateDirectoryMode = "0700";
      WorkingDirectory = stateDir;

      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectHome = true;
      ProtectSystem = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictNamespaces = true;
      RestrictSUIDSGID = true;
    };

    # A restart drops every peer's management stream; don't do it on an
    # unrelated rebuild.
    stopIfChanged = false;
  };

  # STUN is spoken directly, not through nginx.
  networking.firewall.allowedUDPPorts = [ stunPort ];
}
```

The three secrets are just random strings; `openssl rand -base64 32` for each
is fine.

### The dashboard and nginx

The dashboard is a static site. The NixOS module
`services.netbird.server.dashboard` builds it with the right OIDC settings and
serves it at `/` of an nginx vhost. Dex registers a client called
`netbird-dashboard` for it on its own:

```nix
services.netbird.server.dashboard = {
  enable = true;
  enableNginx = true;
  inherit domain;
  managementServer = url;
  settings = {
    AUTH_AUTHORITY = "${url}/oauth2";
    AUTH_AUDIENCE = "netbird-dashboard";
    AUTH_CLIENT_ID = "netbird-dashboard";
    AUTH_SUPPORTED_SCOPES = "openid profile email groups";
    AUTH_REDIRECT_URI = "/nb-auth";
    AUTH_SILENT_REDIRECT_URI = "/nb-silent-auth";
  };
};
```

Everything else on the same vhost is routed to the backend by regex
locations, which nginx prefers over the dashboard's `/` prefix location. The
relay is a websocket, management and signal are gRPC, and the REST API and
Dex's endpoints are plain HTTP:

```nix
services.nginx.virtualHosts.${domain} = {
  forceSSL = true;
  enableACME = true;

  # peers hold their streams open indefinitely
  extraConfig = ''
    client_header_timeout 1d;
    client_body_timeout 1d;
  '';

  locations = {
    "~ ^/(relay|ws-proxy/)" = {
      proxyPass = "http://${backend}";
      proxyWebsockets = true;
      extraConfig = "proxy_read_timeout 1d;";
    };

    "~ ^/(signalexchange\\.SignalExchange|management\\.(ManagementService|ProxyService))/" = {
      extraConfig = ''
        grpc_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        grpc_pass grpc://${backend};
        grpc_read_timeout 1d;
        grpc_send_timeout 1d;
        grpc_socket_keepalive on;
      '';
    };

    "~ ^/(api|oauth2)/" = {
      proxyPass = "http://${backend}";
    };
  };
};

networking.firewall.allowedTCPPorts = [ 80 443 ];
```

The long timeouts matter: without them nginx closes idle streams and peers
reconnect over and over.

### One-time setup in the dashboard

The server starts with no accounts. A few things are done once, by hand:

1. **Owner account.** Opening the dashboard the first time redirects to
   `/setup`, where you create the owner with an e-mail and password. The page
   stops answering once an account exists.
2. **DNS domain.** Under *Settings → Networks*, set it to `nb.home.arpa` (or
   whatever you like). The default is `netbird.selfhosted`, and the server
   config has no option for it.
3. **Setup key.** Under *Setup Keys*, create a reusable key and put it into
   sops for the clients.
4. **Exit node** (optional). *Networks → Network Routes → Add Exit Node*, with
   the NAS as routing peer. With *Auto apply* off, a peer uses it only after
   `netbird-home routes select <network-id>`.

Add `/var/lib/netbird-server` to your backups, and keep the store encryption
key with it: it decrypts the users' names and e-mail addresses.

## The clients

Rather than `services.netbird.enable`, I use the module's named clients. A
client named `home` gets its own interface, port, systemd unit, state
directory and a `netbird-home` CLI wrapper. That keeps it out of the way of a
second network — my machines also join one for work — and makes every command
say which network it is about:

```nix
{ config, ... }:
{
  services.netbird.clients.home = {
    port = 51821;
    environment.NB_MANAGEMENT_URL = "https://netbird.example.com:443";
    ui.enable = false;

    login = {
      enable = true;
      setupKeyFile = config.sops.secrets.netbird-setup-key.path;
    };
  };

  sops.secrets.netbird-setup-key.sopsFile = ./secrets/netbird-client.yaml;

  # the daemon runs as its own user; the control socket is group-restricted
  users.users.alice.extraGroups = [ "netbird-home" ];
}
```

The `login` block is what makes joining hands-off: a `netbird-home-login`
unit runs `up` with the setup key while the client needs a login, and does
nothing once it has one. A freshly installed machine joins the network on its
first boot. Without a setup key, `netbird-home up` prints a URL to complete in
the browser instead.

Note `NB_MANAGEMENT_URL`: without it, the client falls back to NetBird's
hosted service.

## Names, not addresses

At first I kept a list of every peer's NetBird IP in my config. That broke
on every reinstall: a machine that loses its state registers as a new peer
and gets a new address.

With the DNS domain set, NetBird's own DNS resolves `<host>.nb.home.arpa` to
whatever address the peer currently has. So everything — NFS mounts, ssh,
deploys, bookmarks for the NAS's web UIs — uses those names, and a reinstalled
machine is reachable under the same name without touching any config.

## NetBird decides, not the NixOS firewall

This one surprised me. I had written firewall rules that trusted only
specific NetBird addresses, and they did nothing. The NetBird client inserts
an accept for its whole interface at the top of every input chain — the NixOS
firewall's included, and again whenever a chain is recreated — and then
filters peers in a table of its own, according to the access policies in the
dashboard. By default, those let every peer reach every other peer on every
port.

So the model is:

- **Over NetBird**, access is whatever the dashboard's policies say. Every peer
  is mine (my phone included), so I leave it open and treat each peer as
  trusted.
- **On the LAN and the internet**, the NixOS firewall decides as before. On my
  LAN only ssh and syncthing are open.

Two consequences:

- The VPS running the server is **not** a peer. It faces the internet, and as
  a peer it could reach everything the home machines listen on. The server
  doesn't need a client next to it.
- Services meant only for NetBird peers open **no** firewall ports. NetBird
  lets peers in regardless, and opening a port would let the LAN in too. For
  HTTPS on those, I get certificates via the ACME DNS challenge, since nothing
  is reachable over HTTP from outside.

## Testing it

NixOS VM tests cover both halves:

- **The server**: the VPS configuration boots next to a client VM, with
  Let's Encrypt replaced by a self-signed certificate and test secrets. The
  test checks that the services start, that nginx sends each path to the
  right backend, and that only ssh, http and https are open.
- **The trust model**: the NAS configuration boots with NetBird replaced by a
  plain WireGuard tunnel using the same interface name. Over the tunnel,
  everything answers; from a VM on the "LAN", only ssh and syncthing do.

## When NetBird is down

If the VPS is down and a machine restarts, the mesh can't form. I keep LAN
names (`<host>.home.arpa`) in `/etc/hosts` as a fallback for ssh, and
syncthing finds its peers on its own. NFS and the web UIs simply wait for
NetBird to come back, which in practice has been fine.

## Takeaways

- `netbird-combined` with its embedded Dex makes self-hosting NetBird a single
  systemd unit plus an nginx vhost.
- Named clients (`services.netbird.clients.<name>`) are the way to run more
  than one network on a machine.
- A setup key in sops plus `login.enable` makes new machines join on first
  boot.
- Let NetBird's DNS name your peers instead of writing down addresses.
- NetBird, not your host firewall, decides what peers can reach.

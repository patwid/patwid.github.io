+++
title = "Syncthing as a Hub: My Files on Every Machine"
date = 2026-11-13
draft = false
description = "Why I sync my files with Syncthing, and how NixOS declares every device and folder from one inventory, with the NAS as the hub."
tags = ["syncthing", "nixos", "nix", "homelab", "self-hosting"]
categories = ["linux"]
+++

My documents, pictures and downloads are on every machine I use, and none of
them are in anyone's cloud. They're kept in sync by
[Syncthing](https://syncthing.net), with my NAS as the one peer that is always
on. Which device syncs which folder is not set up by clicking through a web
UI. NixOS declares it, from the same inventory that describes the rest of my
machines.

This post covers why Syncthing works for me, and then how the NixOS side is
put together. The flake it lives in is described in
[One Flake, Seven Machines]({{< relref "nixos-setup.md" >}}).

<!--more-->

## Why Syncthing

Syncthing keeps folders in sync between devices, peer to peer. There is no
server in the middle that holds the files. Every device has a full copy of
the folders it shares, and changes go directly from one device to another
over TLS. That has a few consequences I like:

- **No account, no provider.** Devices identify each other by a *device ID*,
  the hash of a certificate each device generates for itself. Two devices
  sync once each one has added the other's ID. Nobody else is involved.
- **The files are plain files.** A synced folder is an ordinary directory.
  Programs don't know it's synced, and nothing breaks if Syncthing stops.
- **It works offline.** Every device has everything, so a laptop on a train
  has the same documents as the desktop at home, and catches up later.
- **It finds its peers by itself.** Syncthing tries the addresses it's given,
  falls back to global discovery to find a device's current address, and to
  public relays if no direct connection is possible.

## What I sync

Three folders:

| Folder | On the desktops |
| --- | --- |
| `documents` | `~/documents` |
| `pictures` | `~/pictures` |
| `downloads` | `~/downloads` |

`downloads` has an ignore pattern: `downloads/local` stays on the device it
was downloaded on, for things too big or too short-lived to copy to every
machine.

## A hub, not a mesh

Peer to peer doesn't have to mean everyone with everyone. Syncthing can sync
any device with any other, and the obvious setup is a full mesh where every
device knows every other. I don't do that. My NAS is always on, so it's the
hub: every other device syncs every folder with the NAS, and only with the
NAS. There are no direct connections between the others.

That makes the NAS the most up-to-date copy, and a device that comes back
after a week only needs to reach one peer to catch up. Adding a device means
adding it to the NAS and nothing else, rather than to every other device too.

The cost is that two desktops can't sync with each other while the NAS is
down. They can still both sync with it once it's back, and in practice it's
never down for long.

## Device IDs in the inventory

Every host in my inventory can have a `syncthingId`:

```nix
hosts = {
  laptop = {
    roles = [ "desktop" "apple-silicon" "laptop" "home" "work" ];
    # …
    syncthingId = "<DEVICE-ID>";
  };

  nas = {
    roles = [ "nas" "home" ];
    # …
    syncthingId = "<DEVICE-ID>";
  };
};
```

A device ID is the hash of the device's public certificate, so it's not a
secret, and it can sit in the inventory in plain text next to the hosts' SSH
public keys. A host prints its own with `syncthing device-id`.

A host *with* an ID syncs every folder with the NAS, declaratively. A host
*without* one runs Syncthing too, but keeps whatever devices and folders its
web UI has, and the NAS doesn't sync with it. That's the state a freshly
installed machine is in until I've added its ID.

## The module

Everything is in one file, `modules/syncthing.nix`, which contributes to two
roles: `desktop`, for the machines I work on, and `nas`. It starts with the
folders, by label, with their IDs and where they live on a desktop:

```nix
folders = {
  documents = {
    id = "<FOLDER-ID>";
    path = "~/documents";
  };
  downloads = {
    id = "<FOLDER-ID>";
    path = "~/downloads";
    ignore = [ "/local" ];
  };
  pictures = {
    id = "<FOLDER-ID>";
    path = "~/pictures";
  };
};
```

Then comes a function that turns a list of peers into the settings of
`services.syncthing`. The desktops and the NAS both call it, with different
peers, addresses and paths:

```nix
syncthing =
  { config, lib, peers, addressesOf, pathOf }:
  let
    declarative = config.inventory.hosts.${config.networking.hostName}.syncthingId != null;
  in
  {
    enable = true;
    overrideDevices = declarative;
    overrideFolders = declarative;
    settings.options.urAccepted = -1;

    settings.devices = lib.mkIf declarative (
      lib.genAttrs peers (name: {
        id =
          let id = config.inventory.hosts.${name}.syncthingId;
          in
          if id != null then id
          else throw "syncthing: ${config.networking.hostName} syncs with ${name}, which has no syncthingId in the inventory";
        addresses = addressesOf name;
      })
    );

    settings.folders = lib.mkIf declarative (
      lib.mapAttrs' (label: folder:
        lib.nameValuePair folder.id ({
          inherit label;
          path = pathOf label;
          devices = peers;
        } // lib.optionalAttrs (folder ? ignore) { ignorePatterns = folder.ignore; })
      ) folders
    );
  };
```

A few details:

- **`overrideDevices` and `overrideFolders`** make the NixOS configuration the
  only source of truth. Devices or folders added in the web UI are removed
  the next time the service starts. They're only on once the host has an ID,
  so a new machine's web UI still works until then.
- **`urAccepted = -1`** declines the anonymous usage reporting, so the web UI
  doesn't ask.
- **A peer without an ID is an evaluation error**, not a device that silently
  never connects.

### On the desktops

A desktop's only peer is the NAS. Syncthing runs as my user, on my own files,
with its configuration under `~/.config/syncthing`:

```nix
flake.modules.nixos.desktop = { config, lib, ... }: {
  services.syncthing = syncthing {
    inherit config lib;
    peers = [ config.inventory.nas.host ];
    addressesOf = name: /* see below */;
    pathOf = label: folders.${label}.path;
  } // {
    user = user.name;
    inherit group;
    configDir = "${home}/.config/syncthing";
    dataDir = "${home}/.local/share/syncthing";
  };
};
```

The addresses are where the network setup comes in. My home machines are on a
[NetBird mesh]({{< relref "self-hosted-netbird-on-nixos.md" >}}), and on the
home LAN when they're at home. So on a host with the `home` role, the NAS's
addresses are its NetBird name first, then its LAN name, then `dynamic`, which
is Syncthing's global discovery:

```nix
addressesOf = name:
  let
    inherit (config.inventory) hosts networks;
    peer = hosts.${name};
    self = hosts.${config.networking.hostName};
    on = network: "tcp://${name}.${networks.${network}.domain}:22000";
  in
  lib.optionals config.my.roles.home.enable (
    lib.optional (peer.netbird && self.netbird) (on "netbird")
    ++ lib.optional (peer.lan != null && self.lan != null) (on "lan")
  )
  ++ [ "dynamic" ];
```

That gives `tcp://nas.nb.home.arpa:22000`, then `tcp://nas.home.arpa:22000`,
then whatever global discovery finds. If the mesh is down, the LAN still
works at home. My work machines are on neither network, so they get only
`dynamic` and reach the NAS through discovery, and a relay if they have to.

### On the NAS

The NAS's peers are every other host in the inventory that has an ID. It
doesn't need to know anyone's address, because the desktops connect to it:

```nix
flake.modules.nixos.nas = { config, lib, ... }: {
  services.syncthing = syncthing {
    inherit config lib;
    peers = lib.attrNames (
      lib.filterAttrs
        (name: host: name != config.networking.hostName && host.syncthingId != null)
        config.inventory.hosts
    );
    addressesOf = _: [ "dynamic" ];
    pathOf = label: "${dataPath}/syncthing/${label}";
  } // {
    guiAddress = "0.0.0.0:8384";
    openDefaultPorts = true;
  };

  systemd.tmpfiles.settings.syncthing = lib.mapAttrs' (label: _:
    lib.nameValuePair "${dataPath}/syncthing/${label}" {
      d = { user = "syncthing"; group = "syncthing"; mode = "0755"; };
    }
  ) folders;
};
```

Here Syncthing runs as its own `syncthing` user, and the folders live under
the NAS's data directory, which tmpfiles creates with the right owner.

`openDefaultPorts` opens the sync port, 22000, to everyone, LAN included. The
web UI listens on every interface but its port isn't opened in the firewall:
it's only reachable over NetBird, which lets mesh peers through on its own.
A VM test checks exactly that: a mesh peer reaches the web UI, a plain LAN
machine reaches only SSH and port 22000. Every home machine has a
[qutebrowser]({{< relref "qutebrowser-on-niri/index.md" >}}) quickmark for the
NAS's web UI, generated from the same module, so `o syncthing` opens it.

## Keeping a device's identity

A device ID is the hash of the device's certificate, and Syncthing generates
that certificate on first start. Reinstall a machine and it gets a new
certificate, a new ID, and the inventory is out of date.

So the certificate and key don't get generated. They're stored in each host's
[sops](https://github.com/getsops/sops-nix) file, and copied into Syncthing's
configuration directory before it starts:

```nix
identity = { config }:
  let
    secret = {
      sopsFile = ../secrets/${config.networking.hostName}.yaml;
      restartUnits = [ "syncthing.service" ];
    };
  in
  {
    sops.secrets = {
      syncthing-cert = secret;
      syncthing-key = secret;
    };
    services.syncthing = {
      cert = config.sops.secrets.syncthing-cert.path;
      key = config.sops.secrets.syncthing-key.path;
    };
  };
```

A reinstalled machine comes back with the same ID, and the NAS syncs with it
right away.

This also made replacing my work machine easy. The new one got the old one's
certificate and key, and the inventory entry with the `syncthingId` moved
over. The old machine keeps running for now, so its Syncthing is turned off
explicitly: two devices with one ID would conflict on the NAS.

```nix
# hosts/<old-work-machine>/configuration.nix
services.syncthing.enable = lib.mkForce false;
```

## Adding a device

For a new NixOS machine, it comes down to:

1. Generate a certificate and key (`syncthing generate`), and put both into
   the host's sops file.
2. Add the device ID it prints to the host's inventory entry.
3. Deploy the new host and the NAS.

The new host syncs all three folders with the NAS, and the NAS knows the new
device. Nothing gets clicked in a web UI and nothing needs accepting, because
both ends were declared by the same commit.

## Trade-offs

The hub is a single point of failure for syncing, not for the data. That
trade-off works for me, but the setup would take a full mesh with one
change: give every host the same peer list the NAS has.

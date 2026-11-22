+++
title = "One Flake, Seven Machines: How I Run NixOS at Home and Work"
date = 2026-11-12
draft = false
description = "A tour of my NixOS setup: a dendritic flake-parts layout, roles from an inventory, wrappers instead of home-manager, sops secrets, VM tests, and hosts that upgrade themselves."
tags = ["nixos", "nix", "flakes", "homelab", "self-hosting"]
categories = ["linux"]
+++

Every machine I use runs NixOS, and all of them are built from a single flake:
two work desktops, a home desktop, an Apple silicon laptop, an Apple silicon
media PC, a NAS and a small VPS. This post walks through how that flake is
organised and the handful of decisions that keep it manageable. None of it is
novel on its own; the value is in how the pieces fit together.

<!--more-->

## The shape of the problem

Seven machines sounds like seven configurations, but most of what they need is
shared. Every host wants the same shell, editor, git settings and Nix settings.
Five of them want a graphical session. Four of them live on my home network and
should see the NAS. Four need work tooling. Only one serves public services.

The trap is to organise the code by machine (`laptop.nix` imports `desktop.nix`
imports `common.nix`…) and end up with an inheritance tree that nobody can
reason about. I organise it along two other axes instead:

- **Topics**: one file or directory per program or service (`git.nix`,
  `syncthing.nix`, `niri/`, `netbird/`).
- **Roles**: what a machine is *for* (`desktop`, `home`, `work`, `nas`,
  `laptop`, `apple-silicon`, plus one per public service).

A host is then just a list of roles plus its hardware.

## A dendritic flake

The flake uses [flake-parts](https://flake.parts) in what the community has
started calling the *dendritic* style, the same layout as
[this blog's flake]({{< relref "how-this-blog-is-built.md" >}}) at a bigger scale: every `.nix`
file under `modules/` is a flake-parts module, and they are all imported automatically by `import-tree`.
The entire `outputs` of the flake is this:

```nix
outputs =
  inputs:
  inputs.flake-parts.lib.mkFlake { inherit inputs; } (
    inputs.import-tree [
      ./modules
      ./inventory
    ]
  );
```

There is no list of files to keep in sync. Adding a program means adding a
file; deleting it means deleting the file.

Each topic file contributes its piece of whichever roles care about it, as
`flake.modules.nixos.<role>`. Things every host gets go into a special `base`
module:

```nix
# modules/syncthing.nix
{
  flake.modules.nixos.desktop = { config, ... }: {
    services.syncthing = { /* sync my documents */ };
  };

  flake.modules.nixos.nas = {
    services.syncthing = { /* the always-on peer */ };
  };
}
```

So everything about Syncthing, on every kind of machine, lives in one place.
When I want to know what a role contains, `grep -rl 'flake.modules.nixos.work'
modules` tells me.

### Roles are derived, not declared

The set of roles is simply "every name under `flake.modules.nixos` except
`base`". A small module turns that into NixOS options:

```nix
{ config, lib, ... }:
{
  options.roles = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    readOnly = true;
    default = lib.attrNames (removeAttrs config.flake.modules.nixos [ "base" ]);
  };

  config.flake.modules.nixos.base = {
    options.my.roles = lib.genAttrs config.roles (role: {
      enable = lib.mkEnableOption "the ${role} role";
    });
  };
}
```

Every host gets `my.roles.<role>.enable` set exactly for the roles it has. That
matters for the cases where one role behaves differently in the presence of
another. KDE Connect, for instance, belongs to the desktop, but should only pair
with my phone on machines that are on the home network:

```nix
flake.modules.nixos.desktop = { config, lib, ... }: {
  config = lib.mkIf config.my.roles.home.enable {
    programs.kdeconnect.enable = true;
  };
};
```

## The inventory

Which host has which roles does not live in the host's configuration. It lives
in a single *inventory*: a plain attribute set, type-checked against a schema
module, describing every machine, including facts about machines that are
not NixOS at all.

```nix
hosts = {
  laptop = {
    roles = [ "desktop" "apple-silicon" "laptop" "home" "work" ];
    lan = "192.168.1.17";
    userKey = "ssh-ed25519 AAAA… me@laptop";
    hostKey = "ssh-ed25519 AAAA…";
    sshFrom = home;
    syncthingId = "…";
  };

  nas = {
    roles = [ "nas" "home" ];
    lan = "192.168.1.64";
    # …
  };
};
```

The inventory is both a flake output and an option on every host
(`config.inventory`), so any module can ask questions about *other* machines
without evaluating them. That is where a lot of the cross-host wiring comes
from:

- `/etc/hosts` entries for the LAN come from the `lan` addresses.
- The list of mesh VPN peers is "every host with the `home` role".
- Syncthing's device list comes from the `syncthingId`s.
- `authorized_keys` on each host is built from the `userKey`s of the hosts in
  its `sshFrom`. Home machines can reach each other and the VPS; work machines
  can reach each other; neither can reach the other, so a compromised machine
  on one side gets nothing on the other.
- The secrets configuration (more on that below) is generated from the
  `hostKey`s.

Building the actual `nixosConfigurations` is then a short function: for every
directory under `hosts/`, take `base`, the host's own `configuration.nix`, and
the modules of the roles the inventory gives it. A role that no module defines,
or a host directory that is missing from the inventory, is an evaluation error
rather than a silent omission.

```nix
role = hostname: name:
  if lib.elem name config.roles then
    {
      imports = [ config.flake.modules.nixos.${name} ];
      my.roles.${name}.enable = true;
    }
  else
    throw "${hostname}: the inventory gives it the role ${name}, which no module defines";
```

## Hosts are just hardware

With roles and the inventory doing the work, `hosts/<name>/configuration.nix`
shrinks to the truly machine-specific bits: disk layout, bootloader quirks, the
odd kernel parameter.

Hardware detection comes from
[nixos-facter](https://github.com/nix-community/nixos-facter): a `facter.json`
report sits next to each host's configuration and NixOS derives the kernel
modules, firmware and even the system architecture from it. Regenerating it is
an overwrite, not a merge, which is exactly how a generated file should behave.

Disks are declared with [disko](https://github.com/nix-community/disko), which
means [nixos-anywhere](https://github.com/nix-community/nixos-anywhere) can
install any non-Apple host from scratch in one command over SSH, from a rescue
system, an installer, or the machine's current OS. The NAS's data disk is
marked so disko mounts it but never touches it.

The two Apple silicon machines are the exception: the Asahi installer
partitions the disk next to macOS and places the peripheral firmware on the
EFI partition, so they're installed by hand once and deployed normally after
that.

## Wrappers instead of home-manager

There is no home-manager in this setup. User-level program configuration is
done with **nix-wrapper-modules**: each program is wrapped so that its config
is baked into the wrapper, and the wrapper is what lands on `PATH`.

Every host has every wrapper as a NixOS option, `wrappers.<program>`, inert
until something enables it:

```nix
# modules/git.nix
{ inputs, ... }:
{
  flake.wrappers.git = inputs.nix-wrapper-modules.wrapperModules.git;

  flake.modules.nixos.base = { config, ... }: {
    wrappers.git = {
      enable = true;
      settings = {
        user.name = config.inventory.user.fullName;
        init.defaultBranch = "master";
        diff.algorithm = "histogram";
        rerere.enabled = true;
        # …
      };
    };
  };
}
```

Because they are ordinary NixOS options, any role or module can add to a
program's configuration, and a rollback takes the program and its config back
together. Programs nix-wrapper-modules doesn't cover upstream get a small local
definition in `wrappers/`. How this works in detail, and why I left
home-manager for it, is in
[Dotfiles Without a Home]({{< relref "nix-wrapper-modules.md" >}}).

## One package set

Every host uses the flake's own `pkgs` as its `nixpkgs.pkgs`. That has two
consequences I consider features:

1. There is exactly one place where nixpkgs is configured (unfree, insecure
   exceptions). A module *cannot* set `nixpkgs.config`; package tweaks have to
   go through an overlay.
2. The hosts and `nix build .#<package>` see literally the same packages.

Overlays live next to the topic that needs them, as `flake.overlays.<topic>`,
and the default overlay composes them all by name. There's also a slot for
pinning a package to the stable channel when it breaks on unstable. It's empty
on purpose, and its comment says to drop the pin once upstream is fixed.

Local packages (a handful of shell menus, a browser extension, some Hare
libraries for a password-manager prompt) live under `packages/<name>/package.nix`,
modelled on nixpkgs' `pkgs/by-name`. They join the package set at the top
level, so a local package with the same name as an upstream one replaces it
everywhere.

## Secrets

Secrets are [sops](https://github.com/getsops/sops) files decrypted at
activation by sops-nix into `/run/secrets`, so nothing secret ever enters the
Nix store.

The interesting part is who can decrypt what. `.sops.yaml` is *generated* from
the inventory: each secrets file is encrypted to my own age key plus the SSH
host key (converted with `ssh-to-age`) of every host whose configuration
actually reads from that file. The NAS's secrets are readable by the NAS, the
VPS's by the VPS, and so on. `nix flake check` fails if the generated file is
stale, so I can't forget to re-key after adding a host.

A topic declares the secrets it needs right next to the service that uses them:

```nix
flake.modules.nixos.myservice = { config, ... }: {
  sops.secrets.myservice-env.sopsFile = ../secrets/${config.networking.hostName}.yaml;
  services.myservice.environmentFile = config.sops.secrets.myservice-env.path;
};
```

My personal age identity never touches disk in plain form; it lives in my
password manager and sops asks for it through a command (`SOPS_AGE_KEY_CMD`).
Each host's private SSH key, which is its sops identity, is backed up in a
secrets file only I can read, and the install script injects it during a
reinstall so a freshly wiped machine can decrypt its secrets on first boot.

## The home network

The home machines and my phone are on a self-hosted
[NetBird](https://netbird.io) mesh, with the coordination server running on the
VPS. Inside the mesh every host is `<host>.nb.home.arpa`; on the LAN it's
`<host>.home.arpa`. Everything uses the mesh names: NFS mounts of the media
library, the NAS web UIs, deploys.

Over the mesh, every peer is as trusted as a home machine, which is why the
internet-facing VPS is *not* a peer. The server, the clients and that trust
model are covered in
[A self-hosted NetBird on NixOS]({{< relref "self-hosted-netbird-on-nixos.md" >}}).

## Testing the configuration

`nix flake check` builds every host for the current architecture (including the
disko scripts), checks formatting with treefmt/nixfmt, and lints with statix and
deadnix. A pre-commit hook refuses unformatted Nix.

More usefully, there are **NixOS VM tests built from the real host
configurations**. A small helper takes a host's own module list and swaps out
only what a VM can't have:

- the hardware report and disko layout,
- the secrets, replaced by a test secrets file encrypted to a throwaway key
  committed next to it,
- the mesh VPN, replaced by a plain WireGuard tunnel with the same interface
  name,
- Let's Encrypt, replaced by a self-signed certificate the test client trusts.

The VPS test checks that the services start, that nginx routes every path of
every site where it belongs, and that only SSH, HTTP and HTTPS are reachable.
The NAS test checks the mesh trust model: a mesh peer can mount the media and
reach the web UIs, a plain LAN machine only SSH and Syncthing.

Because the tests boot the actual host configurations, a firewall rule or a
reverse-proxy route that looks right but isn't fails a check instead of
reaching a machine.

## Deploying

Machines with an address in the inventory are deployed with
[deploy-rs](https://github.com/serokell/deploy-rs), and the deploy nodes are
generated from the inventory too: the mesh name if the host is on the mesh,
otherwise its LAN name, otherwise its public address.

Two details I care about:

- **No trusted users.** My user is not a trusted user of any host's Nix daemon,
  because a trusted user can add arbitrary unsigned paths to the store and is
  effectively root without a password. So deploys copy derivations and build on
  the target rather than pushing pre-built closures.
- **Magic rollback.** deploy-rs confirms the new generation over a *fresh* SSH
  connection; if that doesn't succeed within 30 seconds, the host re-activates
  the previous generation. A broken firewall or SSH config undoes itself.

For the times I deploy with plain `nixos-rebuild` instead, the safety net is
manual: schedule a reboot with `systemd-run --on-active=10min`, `nixos-rebuild
test` (activate but don't make it the boot default), open a new SSH session,
and only then cancel the reboot and `switch`.

## Hosts that upgrade themselves

I don't want to remember to update seven machines, so they update themselves.

On Sunday night, CI bumps `flake.lock` on top of the main branch, builds every
x86_64 host and VM test, evaluates the aarch64 hosts (building Asahi kernels
under emulation on hosted runners isn't worth it), and pushes the bump **only if
everything passes**. If anything was pushed to the branch while it was running,
the push is a non-fast-forward and the bump simply waits a week.

On Monday at midnight, every host runs `system.autoUpgrade` against the main
branch:

- **Servers** switch immediately, or reboot when the kernel, its modules or the
  initrd changed; otherwise they'd run their first kernel forever. Reboots only
  happen inside a night-time window, and the NAS upgrades two hours after the VPS
  so the two are never down at once (the NAS's mesh client needs the VPS to be
  up).
- **Desktops** use `operation = "boot"`: the new generation becomes the default
  at the next boot, rather than restarting things under me mid-session.

Each host fetches the configuration using its own SSH host key, registered as
a read-only deploy key. No host holds a key that could push to anything.

Rollbacks need generations to roll back to, so garbage collection keeps the
newest ten system generations regardless of age, and the bootloader lists the
same ten. A machine that's been off for two months still has ten options in the
boot menu, not zero.

## The desktop, briefly

The graphical side is deliberately small: the [niri](https://github.com/YaLTeR/niri)
scrollable-tiling Wayland compositor, foot, fuzzel as a launcher (plus a set of
little menus built on it for passwords, podcasts, videos and news feeds),
waybar, fnott for notifications, and a shared theme option so every program
agrees on light or dark. Passwords live in himitsu, with a small browser
extension and SSH agent integration. Email is aerc, chat is IRC through a soju
bouncer on the NAS.

All of it is configured the same way as everything else: a topic file
contributing to the `desktop` role, with wrappers for the per-user bits. The
full list of wrapped programs is in the
[wrapper post]({{< relref "nix-wrapper-modules.md#how-my-setup-uses-it" >}}).

## What I'd tell someone starting out

- **Organise by topic, assemble by role.** Machine-centric imports don't scale
  past three hosts.
- **Put facts about machines in one data structure.** Once hosts can see each
  other's addresses and keys without evaluating each other, a whole class of
  copy-paste disappears.
- **Make mistakes fail evaluation.** Unknown roles, missing hosts and stale
  secrets configurations are all errors, not warnings.
- **Test the real configs in VMs.** It's less work than it sounds when you
  substitute only what the VM can't provide.
- **Let CI gate the lockfile, and let hosts pull.** Updating is boring when
  it happens every week and only once it builds.

The result is a setup where adding a machine is a directory with a hardware
report, a disk layout and an inventory entry, and most weeks I don't think
about any of it at all.

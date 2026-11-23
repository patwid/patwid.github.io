+++
title = "Dotfiles Without a Home: Configuring Programs with nix-wrapper-modules"
date = 2026-10-24
draft = false
description = "Why I replaced home-manager with nix-wrapper-modules on NixOS: programs that carry their own configuration, configured through ordinary NixOS options."
tags = ["nixos", "nix", "nix-wrapper-modules", "home-manager", "dotfiles"]
categories = ["linux"]
+++

On my [NixOS machines]({{< relref "nixos-setup.md" >}}) there's no home-manager and almost nothing in
`~/.config` that I wrote myself. My terminal, compositor, browser, mail
client, notification daemon, git and ssh still have a lot of configuration.
It just doesn't live in my home directory. Each program is *wrapped*: the
binary on my `PATH` is a small launcher that points the real program at a
config file in the Nix store.

The tool behind this is
[nix-wrapper-modules](https://github.com/nix-community/nix-wrapper-modules).
This post explains what it does, how I plug it into NixOS, and where it works
well or doesn't.

<!--more-->

## The idea: a program that brings its own config

Most programs have a way to be told where their config is: a `--config` flag,
an environment variable, or an `XDG_CONFIG_HOME` they respect. If you can say
"read your config from *here*", you don't need to put a file in `$HOME` at all.
You can generate the file in the Nix store and pass its path to the program
every time it runs.

The quick version looks like this:

```nix
pkgs.writeShellScriptBin "foot" ''
  exec ${pkgs.foot}/bin/foot --config ${./foot.ini} "$@"
''
```

That works, but you lose things quickly. The man pages, desktop entry, D-Bus
service file and shell completions all belong to the original package, and the
desktop file still launches the *unwrapped* binary. The next step is
`symlinkJoin` plus `wrapProgram` plus some `sed` on `.desktop` files. After
that you'll want to override it per machine, at which point you're writing a
small module system of your own.

nix-wrapper-modules is that module system, already written. A wrapper is
described by a module with typed options. Evaluating it gives you a single
derivation containing the wrapped binary next to the rest of the original
package, with self-references in desktop files (and anything else you list)
patched to point at the wrapper. The `nixpkgs` module system you already
know is what drives it.

## Using an upstream module

The project ships wrapper modules for well over a hundred programs. Used on
its own, outside any NixOS configuration, it looks like this:

```nix
inputs.nix-wrapper-modules.wrappers.foot.wrap {
  inherit pkgs;
  settings.main.font = "monospace:size=11";
  settings.cursor.blink = "yes";
}
```

That's a derivation. You can `nix run` it, put it in a dev shell, or install
it on a machine that has never seen your NixOS configuration. Each wrapper
behaves like any other package.

## Plugging it into NixOS

What I actually wanted was to configure these programs *from* NixOS, the
same way I configure services. Every wrapper module has an `install` attribute
that is an importable NixOS (or home-manager, or nix-darwin) module. Importing
it creates an option at `wrappers.<name>`. Setting `enable = true` adds the
wrapped package to `environment.systemPackages`.

My flake uses flake-parts, and nix-wrapper-modules provides a flake-parts
module for it. I import it once and install every wrapper on every host:

```nix
{ config, inputs, lib, ... }:
{
  imports = [ inputs.nix-wrapper-modules.flakeModules.wrappers ];

  # Every host gets every wrapper as an option, inert until enabled.
  flake.modules.nixos.base.imports =
    map (w: w.install) (lib.attrValues config.flake.wrappers);

  # Also expose them as flake packages.
  perSystem.wrappers.control_type = "build";
}
```

Then each program gets its own file that names the wrapper and configures it:

```nix
# modules/foot.nix
{ inputs, ... }:
{
  flake.wrappers.foot = inputs.nix-wrapper-modules.wrapperModules.foot;

  flake.modules.nixos.desktop = { config, lib, pkgs, ... }: {
    wrappers.foot = {
      enable = true;
      settings = {
        main.shell = "${lib.getExe pkgs.tmux} new-session";
        main.font = "monospace:size=${toString config.my.theme.fontSize}";
        main.pad = "8x4";
        cursor.blink = "yes";
      };
    };
  };
}
```

`wrappers.foot` is an ordinary NixOS option, so it gets everything that
comes with that. It can read any other option (the theme's font size here).
It can be set with `lib.mkIf`, with priorities, and from several modules at
once.

### Several modules, one program

That last point mattered most to me. My browser wrapper has a `quickmarks`
option, and different parts of the configuration each add their own entries
to it:

```nix
# the browser's own module
wrappers.qutebrowser = {
  enable = true;
  quickmarks.yt = "https://youtube.com";
};

# the module for the NAS web UIs, only on home machines
wrappers.qutebrowser.quickmarks = lib.mapAttrs (name: _: "https://${name}.example.org") ports;

# the syncthing module
wrappers.qutebrowser.quickmarks.syncthing = "http://localhost:8384/";
```

The option merges like any attribute set, and the browser ends up with all of
them. The module that runs Syncthing is also where its bookmark is defined.
My ssh client config works the same way: `matchBlocks` is built partly from a
list of my machines and partly from a separate work module that adds its jump
hosts.

Hardware-specific settings work like this too. My Apple silicon machines need
niri pointed at a particular render device, so their hardware module adds one
line:

```nix
wrappers.niri.settings.debug.render-drm-device = "/dev/dri/renderD128";
```

Nothing else about niri needs to know about it.

### Handing the wrapper to NixOS

The evaluated wrapper is available as `config.wrappers.<name>.wrapper`. Where
NixOS has its own module for a program, I give that module the wrapper as its
package, so NixOS's integration (sessions, PAM, polkit, completions) and my
configuration end up in one binary:

```nix
programs.niri = {
  enable = true;
  package = config.wrappers.niri.wrapper;
};

programs.git = {
  enable = true;
  package = config.wrappers.git.wrapper;
};
```

The same works for systemd units, scripts and keybindings. Anything that
launches the program can use the wrapper directly:

```nix
systemd.user.services.fnott.serviceConfig.ExecStart =
  lib.getExe config.wrappers.fnott.wrapper;
```

The idle daemon locks the screen with the wrapped locker in the same way, and
my launcher menus call the wrapped launcher, so every entry point gets the
same configuration.

One case needs care. ssh's client and server share a package. I want the
client wrapped, but sshd shouldn't inherit a wrapped client, so the server
keeps the plain package explicitly:

```nix
programs.ssh.package = config.wrappers.openssh.wrapper;
services.openssh.package = pkgs.openssh;
```

## Writing your own wrapper module

For programs without an upstream module, writing one is short. This is
roughly the one for fnott, a notification daemon configured by an INI file:

```nix
{ config, wlib, lib, pkgs, ... }:
{
  imports = [ wlib.modules.default ];

  options.settings = lib.mkOption {
    type = lib.types.attrsOf lib.types.anything;
    default = { };
    description = "fnott.ini; attrset values become sections.";
  };

  config = {
    package = lib.mkDefault pkgs.fnott;

    # Generate the file inside the wrapper's own output...
    constructFiles.config = {
      relPath = "fnott.ini";
      content = lib.generators.toINIWithGlobalSection { } {
        globalSection = lib.filterAttrs (_: v: !lib.isAttrs v) config.settings;
        sections = lib.filterAttrs (_: v: lib.isAttrs v) config.settings;
      };
    };

    # ...and point the program at it.
    flags."--config" = config.constructFiles.config.path;

    # D-Bus activation should start the wrapper, not the bare binary.
    filesToPatch = [ "share/dbus-1/services/*.service" ];
  };
}
```

The pieces it uses:

- `wlib.modules.default` brings in the standard wrapper options (`package`,
  `flags`, `env`, `constructFiles`, `filesToPatch` and more).
- `constructFiles` writes a generated file *into the wrapper derivation
  itself*, so the config and the launcher are one store path.
- `flags` and `env` correspond to `makeWrapper`'s `--add-flags` and `--set`,
  as module options, with control over ordering.
- `filesToPatch` rewrites references to the original package in the listed
  files. Desktop files are patched by default. For a D-Bus-activated daemon
  you also want its service file, or D-Bus will start the unwrapped program
  and skip your config.

The custom ones I've written mostly follow this pattern: a `settings` option,
a function that serialises it to the program's format (INI, scfg, a Python
`config.py` for qutebrowser, an ssh config), and one flag pointing at the
result. The serialiser usually takes the most code. The wrapping itself is a
few lines.

In the flake, a local wrapper is just a path:

```nix
flake.wrappers.fnott = ../wrappers/fnott/module.nix;
```

and from there it's used exactly like an upstream one.

## How my setup uses it

My flake has one file per program, and each file adds its part to whichever
roles need it (the layout is described in
[One Flake, Seven Machines]({{< relref "nixos-setup.md" >}})). Wrappers fit that layout without any changes: a program's file names its
wrapper with `flake.wrappers.<name>`, and its role modules set
`wrappers.<name>`.

These are the programs I wrap today:

| Program | Wrapper module | Enabled by | Notes |
| --- | --- | --- | --- |
| git | upstream | every host | handed to `programs.git.package` |
| openssh (client) | local | every host | `matchBlocks` built from the machine inventory |
| niri | upstream | desktop | handed to `programs.niri.package` |
| foot | upstream | desktop | |
| fuzzel | upstream | desktop | the launcher behind all my menus |
| waybar | upstream | desktop | |
| swayidle, swaylock | upstream | desktop | run from a systemd user unit |
| fnott | local | desktop | D-Bus service file patched |
| qutebrowser | local | desktop | quickmarks added from many modules |
| gnupg | local | desktop | public keyring built in the store |
| aerc, mbsync | local | desktop | aerc calls the wrapped mbsync |
| himitsu, himitsu-ssh | local | desktop | password store and its ssh agent |
| senpai | local | desktop with `home` | IRC client for the bouncer on the NAS |

Seven of these come from upstream and the rest are local modules of 40 to
130 lines each, in a `wrappers/<program>/module.nix` directory laid out the
same way as upstream's. If I ever want to contribute one upstream, it can be
copied over as is.

A few patterns come up repeatedly.

**Everything reads the same theme.** A custom `my.theme` option holds the
light or dark variant, font size and palette. foot, fuzzel, waybar, swaylock,
fnott and qutebrowser all read their colours and fonts from it.
Switching the variant re-themes everything at the next rebuild, with no
per-program theme files to keep in sync.

**Wrappers call each other by store path.** aerc checks for mail by running
mbsync, so its config calls the wrapped mbsync directly:

```nix
check-mail-cmd = "${lib.getExe config.wrappers.mbsync.wrapper} personal";
```

aerc always runs the mbsync with the right config, whatever is on `PATH`.
The idle daemon locks the screen with `lib.getExe
config.wrappers.swaylock.wrapper` the same way.

**…or rely on the wrapper being the one on `PATH`.** My launcher menus
(passwords, podcasts, videos, bookmarks, news feeds) are small shell scripts
that call `fuzzel --dmenu`. They deliberately don't depend on fuzzel
themselves. The fuzzel on `PATH` is the wrapped one, so every menu gets the
same look without being passed any config.

**Package patches still go through overlays.** I carry a small patch to
fuzzel's program sorting. It's an ordinary overlay on `pkgs.fuzzel`, and the
wrapper's `package` defaults to `pkgs.fuzzel`, so the wrapper picks up the
patched build automatically. The overlay handles the build and the wrapper
handles the config.

**Data can be built in too, not only config.** My gnupg wrapper takes a
list of public key files and imports them into a keyring at build time:

```nix
keyring = pkgs.runCommand "gpg-keyring" { } ''
  export GNUPGHOME=$(mktemp -d)
  ${lib.concatMapStringsSep "\n" (key: "${gpg} --import ${key}") config.publicKeys}
  mkdir $out && cp $GNUPGHOME/pubring.kbx $out/
'';

flags = {
  "--keyring" = "${keyring}/pubring.kbx";
  # The store is read-only, so there is no writable trustdb; the keyring
  # holds only my own keys, so trust them outright.
  "--trust-model" = "always";
};
```

The key files sit in the configuration repository, one file per key, and the
module reads the directory, so adding a key means adding a file. The agent
is still run by NixOS's own `programs.gnupg` module, with the wrapper as
its package.

**Secrets stay out of the store.** The store is world-readable, so a wrapper's
generated config can't contain a password. It holds a *command* that fetches
the secret at runtime instead. senpai's `password-cmd`, mbsync's `PassCmd`
and aerc's credentials all query my password manager when they run.

**Not everything is wrapped.** Programs that NixOS already configures
system-wide (bash, tmux, vim, dconf) go through
their NixOS modules. Wrappers are for user-level programs that would
otherwise need a dotfile.

## Why not home-manager?

I used home-manager for years and it's a good tool. Moving to wrappers gave
me a few things:

- **One module system, one activation.** No second generation that can fall
  out of step with the system, no separate `home-manager switch`, no question
  of whether a setting goes in NixOS or in home-manager.
- **No files in `$HOME` to fight over.** Nothing gets linked into
  `~/.config`, so nothing gets clobbered by an application, blocked by a
  file that's already there, or left behind as a stale symlink.
- **Config travels with the binary.** The configuration is part of the
  program's store path. Rolling back the system rolls back the program and its
  config together, and the same wrapper can be `nix run` somewhere else.
- **Configuration can come from anywhere.** Because wrappers are plain NixOS
  options, a hardware module, a role or a service module can each add to a
  program's config without a special mechanism.

## Where it doesn't fit

Wrapping only works if the program cooperates. Two conditions matter:

1. The program has to let you say where its configuration is, ideally *only*
   its own config rather than all of `XDG_CONFIG_HOME`.
2. It must not insist on writing to that configuration at runtime, since a
   store path is read-only.

Most CLI tools and Wayland-era desktop programs meet both. Some don't, and a
few need workarounds:

- **Programs that only read `XDG_CONFIG_HOME`.** Pointing it at the store
  works, but *child processes inherit it*. My browser is wrapped this way, and
  its generated `config.py` begins by removing `XDG_CONFIG_HOME` from the
  environment once the browser has located its directories. Otherwise
  everything it launches (a video player, a download handler) would look for
  its config in the browser's store path.
- **Programs that write their config.** GUI apps that save preferences to the
  same file they read from don't work well wrapped. I leave those alone or
  configure them through whatever system-level mechanism they have.
- **State that isn't config.** Mail queues, password stores, caches and
  histories still live in `$HOME`, as they should. Wrappers handle
  configuration, not data.

## Summary

nix-wrapper-modules turns "a program plus its config" into a single
derivation, described by a module. Installed through its NixOS integration,
every wrapper becomes an ordinary option, so configuring my terminal works
exactly like configuring nginx: any module can set or extend it, and the
result rolls back with the system. Combined with handing the wrapper to NixOS
as `programs.<name>.package` wherever NixOS has a module, it replaced
home-manager for me entirely, and I haven't missed my dotfiles.

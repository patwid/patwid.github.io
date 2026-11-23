+++
title = "From pass to himitsu"
date = 2026-11-18
draft = false
description = "Why I'm moving my passwords from pass to himitsu, and how NixOS runs the daemon, the prompter, the menus, the browser integrations and the store's key."
tags = ["himitsu", "pass", "nixos", "nix", "security"]
categories = ["linux"]
+++

For years my passwords lived in [pass](https://www.passwordstore.org), the
standard Unix password manager: one GPG-encrypted file per password, in a
directory. They're now moving to [himitsu](https://himitsustore.org), a
secret store built around a daemon and a small query language. Most of what I
use day to day already reads from himitsu: the password menu, three browsers,
my mail client, my IRC client and sops.

This post covers why I switched, what the store looks like, and how NixOS puts
it together. The flake it lives in is described in
[One Flake, Seven Machines]({{< relref "nixos-setup.md" >}}).

<!--more-->

## What pass does well, and what it doesn't

pass is a shell script around GPG. A password is a file such as
`mail/tbwnet.gpg`, the first line of the decrypted file is the password, and
anything after it is free-form notes. It's simple, it's easy to back up, and
every tool can call `pass show`.

Its simplicity has limits, though:

- **The structure is a convention.** "First line is the password" is all
  there is. Usernames, URLs or OTP seeds go in the notes, in whatever format
  I used that day, and every script that wants one of them parses it itself.
  My mail client's command was `pass mail/tbwnet | head -n 1`.
- **The names are not encrypted.** The directory tree, which says which
  services I have accounts with, is in the clear.
- **Every decryption is GPG.** That means gpg-agent, pinentry, key IDs, and a
  cached passphrase that any program running as me can use without asking.

## What himitsu does differently

himitsu stores *keys*, each a list of key/value pairs:

```
proto=web host=example.org username=patrick password!=<secret>
proto=pass name=mail/tbwnet password!=<secret>
proto=age comment=sops skey!=<secret>
```

A trailing `!` marks a field as secret. Everything else is plain text that can
be queried without unlocking anything secret, and a query is just a partial
key: `hiq proto=web host=example.org` lists every web login for that host,
with the secrets left out.

Three properties make this a better fit for me:

- **Fields have names.** A script asks for the field it wants. `hiq -dF
  password proto=pass name=mail/tbwnet` prints the password and nothing else,
  without `head`. Browser integrations fill every field into the form input of
  the same name, so a key with `email=` or `otp=` fills those inputs too.
- **A daemon owns the secrets.** `himitsud` runs in my session. I unlock it
  once with my passphrase, and after that it decides who gets what.
- **Decryption needs consent.** When a program asks for a secret field,
  himitsud shows a *prompter*, a small dialog that says which program wants
  which key, and I allow or deny it. Unlocked doesn't mean any process can
  read everything without me noticing.

## The daemon and the prompter

himitsud reads an INI configuration file, and the only thing mine sets is the
prompter. I use [hiprompt-gtk](https://git.sr.ht/~sircmpwn/hiprompt-gtk),
which isn't in nixpkgs, along with the Hare GTK bindings it needs, so those
are packaged in the flake. The daemon is configured through a
[wrapper module]({{< relref "nix-wrapper-modules.md" >}}), which bakes the
configuration file into the `himitsud` command:

```nix
# wrappers/himitsu/module.nix
config = {
  package = lib.mkDefault pkgs.himitsu;
  binName = "himitsud";
  exePath = "bin/himitsud";

  flags."-C" = config.constructFiles.config.path;

  constructFiles.config = {
    relPath = "himitsu.ini";
    content = toINI config.settings;
  };
};
```

On every desktop, it's enabled with the prompter and run as a user service
tied to the graphical session, since the prompter needs a display:

```nix
wrappers.himitsu = {
  enable = true;
  settings.himitsud.prompter = lib.getExe pkgs.hiprompt-gtk;
};

systemd.user.services.himitsud = {
  description = "Himitsu secret storage daemon";
  partOf = [ "graphical-session.target" ];
  after = [ "graphical-session.target" ];
  wantedBy = [ "graphical-session.target" ];
  serviceConfig = {
    ExecStart = lib.getExe config.wrappers.himitsu.wrapper;
    Restart = "on-failure";
  };
};
```

One packaging detail took a while to find: hiprompt-gtk aborts when it can't
find its GSettings schemas, and a systemd user service has no schema search
path. Wrapping it with `wrapGAppsHook4` fixes that.

## Programs that read passwords

The command-line client is `hiq`. Two flags make it convenient in
configuration files: `-F <field>` prints a single field's value, and `-1`
fails unless exactly one key matches, so an ambiguous query is an error, not
a guess. aerc and senpai went from `pass` to `hiq`:

```nix
# aerc
credCmd = "${lib.getExe' pkgs.himitsu "hiq"} -1dF password proto=pass name=mail/tbwnet";

# senpai
password-cmd = [
  (lib.getExe' pkgs.himitsu "hiq")
  "-1dF" "password"
  "proto=pass" "name=soju"
];
```

sops is the third. My personal age identity, which decrypts the flake's
secrets, is a key in himitsu, and sops asks for it through a command:

```nix
env.SOPS_AGE_KEY_CMD = "hiq -1dF skey proto=age comment=sops";
```

Editing a secret now shows the prompter, with "sops" asking for the age key.

## The menu

`Mod+P` opens a [fuzzel](https://codeberg.org/dnkl/fuzzel) menu of my
passwords, and copies the chosen one to the clipboard. It used to run pass,
and the himitsu version is a short script:

```bash
# Seconds until the copied password is cleared from the clipboard.
clear_after=45

entries=$(hiq proto=pass | sort)
entry=$(fuzzel --dmenu <<< "$entries")

if [ -n "$entry" ]; then
  read -ra query <<< "$entry"
  password=$(hiq -Fpassword -d -- "${query[@]}")
  printf '%s' "$password" | wl-copy --trim-newline

  # Clear the clipboard later, unless something else was copied since.
  (
    sleep "$clear_after"
    if [ "$(wl-paste --no-newline 2>/dev/null)" = "$password" ]; then
      wl-copy --clear
    fi
  ) >/dev/null 2>&1 &
fi
```

Listing the keys doesn't decrypt anything. Every line `hiq` prints is a
valid query for that one key, so the chosen line goes back to `hiq` as is.

The menu lists the keys first and only then starts fuzzel, rather than piping
one into the other. If the store is locked, `hiq` triggers the unlock prompt,
and when fuzzel started at the same time, its layer-shell surface could take
the keyboard focus first, and niri never gave it back to the prompt.

## Logging in on the web

Web logins are keys with `proto=web` and the site's `host`. I use three
browsers, and each fills those keys the same way: find the keys for the
current page's exact host, pick one with fuzzel if there are several, decrypt
the secret fields, and put every field into the input whose `name` or
`autocomplete` attribute matches. That's the behaviour of the official
Firefox add-on, and I copied it for the other two.

- **Firefox** uses the upstream add-on. NixOS installs its native messaging
  host, and a Firefox policy force-installs the add-on from AMO. The same
  policies turn off Firefox's own password manager.
- **qutebrowser** gets a userscript, bound to `,p`. It runs `hiq` for the
  page's host and writes a `jseval` command that fills the form back to
  qutebrowser.
- **Chromium** gets an extension I wrote, since there's none upstream. An
  extension can't run `hiq` itself, so a native messaging host does the
  lookup, the picker and the decryption, and the extension only fills in what
  comes back. It's shipped as a CRX in the system path, which Chromium
  installs without asking.

Two details came up with real sites. Some logins, typically the ones behind
an identity provider, ask for the username on one page and the password on
the next. There's no form with both inputs, so the scripts fall back to the
form that covers the most fields, and I run them again on the second page.
And the qutebrowser script decrypts only the fields marked secret, one query
each, because every decrypting query is one consent prompt. Decrypting the
whole key would also ask for fields that never needed it.

## Keeping the key out of the store

A himitsu store is a directory, `~/.local/share/himitsu`, which I keep on
every machine I use, so it gets copied around.

The directory holds the encrypted keys and a file called `key`: the store's
master key, encrypted with my passphrase. Anyone with a copy of the whole
directory can try passphrases against it offline, as fast as their hardware
allows. A directory that's copied to many places shouldn't contain that file.

So `key` comes from [sops](https://github.com/Mic92/sops-nix) instead.
himitsu reads it at a fixed path in the store, and sops-nix can put a secret
at any path, as a link:

```nix
sops.secrets.himitsu-key = {
  sopsFile = ../secrets/himitsu.yaml;
  owner = user.name;
  mode = "0400";
  path = "${store}/key";
};
```

`secrets/himitsu.yaml` is encrypted for me and for each desktop's host key,
so a machine decrypts it at activation, without my age identity. The link
is left out when the store is copied, so a copy of the store alone is just
encrypted data with no key to attack.

sops-nix creates missing parent directories of a link as root, which would
leave `~/.local/share` owned by root on a fresh install. tmpfiles creates
them first, owned by me, with the store itself at `0700`.

There's an apparent loop here: the age identity sops uses to edit secrets is
stored in himitsu, and himitsu's key comes from sops. It isn't one, because
the two use different identities. The machine decrypts the himitsu key with
its host key, and I need my own age identity only to edit secrets, by which
time himitsu is unlocked.

Changing the passphrase, with `himitsu-store -r`, writes a new `key` over the
link. That file goes into `secrets/himitsu.yaml`, the file gets deleted, and
the next activation puts the link back.

## Where the migration stands

<!-- TODO: how the pass entries were imported -->

My pass entries are now `proto=pass` keys whose `name` is their old path in
pass, which kept the menu and the mail and chat configurations close to what
they were. Web logins I'm converting to `proto=web` keys with a `host` and a
`username` as I come across them.

pass hasn't gone yet. Its store is still there and `Mod+Alt+P` still opens
the old menu, for the entries I haven't moved. Two things are still to come:

- **SSH keys.** himitsu-ssh provides `hissh-agent`, an SSH agent backed by
  the store. It's packaged and configured, but the service is off for now.
- **The Secret Service API**, which would let desktop programs store their
  secrets in himitsu too. I tried an agent for it and took it out again the
  next day.

Once the last entries have moved, the pass store and its menu can go.

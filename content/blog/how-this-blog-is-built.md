+++
title = "How this blog is built"
date = 2026-11-21
draft = false
description = "Hugo with the Bear Blog theme, pinned and wired up by a Nix flake, icons rendered from one SVG, and deployed to GitHub Pages by a single workflow."
tags = ["hugo", "nix", "github-pages", "meta"]
+++

A blog about the things I build should probably start with the blog itself.
It is deliberately small: a static site, one theme, a handful of overrides,
and a Nix flake that makes the build the same on my laptop and in CI.

## The pieces

- **[Hugo](https://gohugo.io/)** turns Markdown into HTML.
- **[hugo-bearblog](https://github.com/janraasch/hugo-bearblog)** is the
  theme, modelled after [Bear Blog](https://bearblog.dev/): no JavaScript,
  hardly any CSS, and pages that load before you notice.
- **A Nix flake** pins Hugo, the theme and the tools that render the icons.
- **GitHub Pages** hosts the result, built and deployed by a GitHub Actions
  workflow on every push to `master`.

## The theme as a flake input

Hugo themes are usually added as a git submodule or a Hugo module. I started
with a submodule, which meant a fresh clone needed `--recurse-submodules` to
build at all, and updating the theme was a separate step from updating
everything else.

Now the theme is just another flake input, fetched as plain source:

```nix
{
  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    import-tree.url = "github:vic/import-tree";
    hugo-theme = {
      url = "github:janraasch/hugo-bearblog";
      flake = false;
    };
  };

  # Dendritic pattern: every file under ./nix is a flake-parts module.
  outputs = inputs: inputs.flake-parts.lib.mkFlake { inherit inputs; } (inputs.import-tree ./nix);
}
```

Its revision lives in `flake.lock` next to nixpkgs, so `nix flake update`
updates the theme and Hugo together. Switching themes is a one-line change
to the URL, which came in handy: I tried two more themes the same afternoon
before settling on this one.

The outputs follow the dendritic pattern: [import-tree](https://github.com/vic/import-tree)
loads every file under `nix/` as a
[flake-parts](https://flake.parts/) module. The dev shell, the icons, the
formatter and the supported systems each get their own small file, and
adding something new means adding a file rather than editing a central
`flake.nix`.

## The dev shell

Hugo expects the theme under `themes/`. The dev shell puts it there with a
symlink into the Nix store:

```nix
{ inputs, ... }:
{
  perSystem =
    { pkgs, self', ... }:
    {
      devShells.default = pkgs.mkShellNoCC {
        packages = [ pkgs.hugo ];
        shellHook = ''
          mkdir -p themes
          ln -sfT ${inputs.hugo-theme} themes/main
          mkdir -p generated
          ln -sfT ${self'.packages.icons} generated/icons
        '';
      };
    };
}
```

`themes/` and `generated/` are in `.gitignore`; both are rebuilt from the
flake whenever the shell starts. With [direnv](https://direnv.net/) and a
one-line `.envrc` (`use flake`), that happens on `cd`, and writing a post is
just:

```sh
hugo server --buildDrafts
```

## Icons from one SVG

A site wants a surprising number of icons: a `favicon.ico` with several
sizes, an SVG favicon, an Apple touch icon, and a larger PNG that link
previews in chat apps pick up. Rather than check in a folder of binaries, I
keep a single `icons/icon.svg` and let a Nix derivation render the rest:

```nix
packages.icons =
  pkgs.runCommand "icons"
    {
      src = ../icons/icon.svg;
      nativeBuildInputs = [
        pkgs.resvg
        pkgs.imagemagick
      ];
    }
    ''
      mkdir -p $out/images
      render() { resvg --width "$1" --height "$1" "$src" "$2"; }

      cp "$src" $out/favicon.svg
      render 180 $out/apple-touch-icon.png
      render 512 $out/images/icon.png

      for size in 16 32 48; do render $size ico-$size.png; done
      magick ico-16.png ico-32.png ico-48.png $out/favicon.ico
    '';
```

The dev shell links the output to `generated/icons`, and a module mount in
`hugo.toml` serves it alongside the regular static files:

```toml
[module]
  [[module.mounts]]
    source = 'static'
    target = 'static'
  [[module.mounts]]
    source = 'generated/icons'
    target = 'static'
```

The 512-pixel PNG doubles as the share image and as the avatar on the home
page. Changing the logo means editing one SVG, which is currently a single
blue square.

## A few overrides

The theme does almost everything I want. What it doesn't is handled by three
small files under `layouts/`, which Hugo prefers over the theme's own:

- **`home.html`** shows the list of posts below the intro text on the home
  page, with a round avatar on top.
- **`_partials/favicon.html`** links the generated icons.
- **`_partials/custom_head.html`** adds a few lines of CSS: padding for code
  blocks, dark code blocks in dark mode, the date on its own line above each
  post title, centered post images, and the avatar.

The dark mode fix is the only one that needed some thought. The theme
follows the system's dark mode, but Hugo's syntax highlighter writes a light
background directly onto every code block. Plain code text picked up the
theme's dark-mode text color, so it was light grey on light grey. Hugo
writes the highlight colors inline, so CSS can't swap in a dark palette.
Instead, I pin the code text to the light-mode color and, in dark mode,
invert the whole block and rotate the hues back:

```css
.highlight pre {
  color: #444;
}

@media (prefers-color-scheme: dark) {
  .highlight pre {
    filter: invert(1) hue-rotate(180deg);
    background-color: #aad6e4 !important;
  }
}
```

The light background turns dark and the dark text turns light. Strings,
keywords and comments keep roughly their colors. One catch: the highlighter's
light grey inverts to almost black, darker than the page. So in dark mode
I replace it with a light blue that inverts to a shade lighter than the page's
dark teal. That way the code block stands out the same way it does in light
mode. Hugo's config and the theme stay as they are.

Tags are switched off entirely. With a few posts there is nothing to browse
by, and the theme then renders no tag pages or links:

```toml
disableKinds = ["taxonomy", "term"]
ignoreErrors = ["error-disable-taxonomy"]
[permalinks]
  blog = "/:slug/"
```

The permalink setting gives posts short, Bear Blog-style URLs like
`/how-this-blog-is-built/` instead of `/blog/how-this-blog-is-built/`.

## Deploying

The workflow installs Nix and builds inside the same dev shell I use
locally, so CI gets exactly the Hugo, theme and icons from `flake.lock`:

```yaml
- name: Install Nix
  uses: cachix/install-nix-action@v31
  with:
    extra_nix_config: |
      experimental-features = nix-command flakes

- name: Setup Pages
  id: pages
  uses: actions/configure-pages@v5

- name: Build
  run: |
    nix develop --command hugo --gc --minify \
      --baseURL "${{ steps.pages.outputs.base_url || 'https://patwid.github.io/' }}"

- name: Upload artifact
  uses: actions/upload-pages-artifact@v4
  with:
    path: ./public
```

A second job hands the artifact to `actions/deploy-pages`. There is no
`gh-pages` branch and no build output in the repository; publishing a post is
a `git push`.

## Takeaways

- A theme as a non-flake input is simpler than a submodule and gets pinned and
  updated together with everything else.
- Generate binary assets like icons from a single source instead of checking
  them in.
- Building in CI with `nix develop --command` means the local preview and the
  deployed site come from the same toolchain.
- Most of a theme can stay untouched; a few files under `layouts/` cover the
  rest.

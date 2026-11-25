+++
title = "My Git Worktree Setup"
date = 2026-11-28
draft = false
description = "A bare clone in .bare, every branch checked out as its own directory under worktrees/, and relative paths so the whole project folder can be moved around."
tags = ["git", "worktree", "workflow"]
categories = ["linux"]
+++

I used to juggle branches with `git stash` and `git checkout`. Then I
started using worktrees for the odd review or hotfix, and by now every
project I work on is laid out around them: one directory per branch, all
sharing a single repository.

This post is the layout I settled on, how to create it, and the one detail
that makes it pleasant: worktrees that point at the repository with
*relative* paths.

<!--more-->

## Why worktrees

A worktree is an additional working directory attached to the same
repository. Each one has its own checked-out branch, its own index and its
own untracked files, but they all share one object database and one set of
refs.

That means I can have a long-running build or test suite going on one
branch, review a pull request in another, and keep working on a feature in
a third, without stashing, without a second clone, and without waiting for
a checkout to finish.

## The layout

The default way to use worktrees is to keep your normal clone and add
`git worktree add ../something` next to it. That works, but the main
checkout is special: it holds the repository, so it can't be removed or
moved without breaking the others.

I prefer a layout where no checkout is special:

```text
<project>/
├── .bare/          # the bare repository, objects and refs live here
├── .git            # a file: "gitdir: ./.bare"
└── worktrees/
    ├── main/       # a checkout of main
    ├── feature-x/  # a checkout of feature-x
    └── hotfix/     # ...
```

`.bare` is a bare clone, so it has no working tree of its own. Every branch,
including `main`, is just another directory under `worktrees/`. The
`.git` file in the project root makes Git commands work from there too, as
if `.bare` were the `.git` directory.

## Setting it up

Clone bare into `.bare`:

```sh
mkdir <project> && cd <project>
git clone --bare <url> .bare
echo "gitdir: ./.bare" > .git
```

A bare clone doesn't set up remote-tracking branches, so `origin/*` would
not exist and `git fetch` would update nothing useful. Fix the refspec and
fetch:

```sh
git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git fetch origin
```

Now tell Git to store worktree paths relative (more on that below), and add
the first worktree:

```sh
git config worktree.useRelativePaths true
git worktree add worktrees/main main
```

New branches work the same way:

```sh
git worktree add -b feature-x worktrees/feature-x origin/main
```

## Relative paths

Every worktree is linked to the repository in both directions, and by
default both links are absolute paths:

- `worktrees/main/.git` is a file containing
  `gitdir: /home/me/<project>/.bare/worktrees/main`
- `.bare/worktrees/main/gitdir` contains
  `/home/me/<project>/worktrees/main/.git`

Move or rename the project directory, or open it under a different path in
a container, and both links point nowhere. Git then reports the worktrees as
`prunable`, and `git worktree prune` will happily delete their metadata.

Since Git 2.48 there is a setting for this. With `worktree.useRelativePaths`
enabled, the links become:

```text
worktrees/main/.git            →  gitdir: ../../.bare/worktrees/main
.bare/worktrees/main/gitdir    →  ../../../worktrees/main/.git
```

Now the project folder is self-contained. I can rename it, move it, sync it
to another machine or mount it in a container at a different path, and
everything keeps working.

The setting needs Git 2.48 or newer, and it turns on the
`extensions.relativeWorktrees` repository extension, so older versions
refuse to touch the repository rather than silently misread it.

If worktrees already exist with absolute paths, convert them in one go:

```sh
git worktree repair --relative-paths
```

## Running in a Docker sandbox

A worktree on its own is not a complete repository: its `.git` file points
into `.bare`, so a tool that only sees `worktrees/<name>` can't run any Git
command. That matters when I run Claude Code in a [Docker
sandbox](https://docs.docker.com/ai/sandboxes/) (`sbx`). The sandbox needs
the worktree and the bare repository, so I mount both:

```sh
cd worktrees/feature-x
sbx run claude . ../../.bare --name <project>-feature-x
```

The first path is the workspace, the second is the bare repository it
links to. Because the links are relative (see above), `../../.bare` resolves
from the worktree no matter where the sandbox mounts the project, which is
exactly the case relative paths were meant for.

I name the sandbox after the project and the worktree, so there is one
sandbox per branch and `sbx ls` stays readable.

The mounts are only needed the first time. To come back to the sandbox
later, run it by name from anywhere:

```sh
sbx run --name <project>-feature-x
```

## Day to day

```sh
git worktree list                    # what's checked out where
git worktree add worktrees/pr-123 origin/some-branch
git worktree remove worktrees/pr-123 # when the branch is done
git worktree prune                   # forget directories deleted by hand
```

A few things I ran into:

- **A branch can only be checked out once.** Git refuses to check out the
  same branch in two worktrees. That's a feature, but it means `main` is
  taken by `worktrees/main`; for a throwaway look at it elsewhere, use
  `git worktree add --detach`.
- **Untracked files don't carry over.** Each worktree starts clean, so
  things like `.env` files, `node_modules` or build output have to be
  created again, or provided another way, in every worktree.
- **Run commands from inside a worktree.** From the project root, Git sees
  the bare repository and has no checkout to operate on. I `cd` into
  `worktrees/<name>` first.
- **Tools that look for `.git`.** Editors and language servers handle the
  `.git` file in a worktree fine, because it's the same mechanism Git itself
  uses. Open the worktree directory, not the project root.

## Wrapping up

The whole setup is a bare clone, a one-line `.git` file and one config
option. In return, every branch I'm working on is a plain directory I can
`cd` into, and the project folder stays movable.

+++
title = "Running AI Coding Agents in a Locked-Down Sandbox"
date = 2026-12-03
draft = false
description = "Using Docker sbx sandboxes, declared in an sbxenv.yaml file and a kit, to run AI coding agents with only the workspace mounted, an explicit network allowlist, and credentials injected by a proxy so they never enter the sandbox."
tags = ["docker", "sandbox", "security", "ai"]
categories = ["development"]
+++

AI coding agents are most useful when you stop approving every single
command. They are also most dangerous at that point. An agent that can run
arbitrary shell commands on my laptop can read my SSH keys, my browser
profile and my shell history, and it can send any of it anywhere.

The fix isn't a better prompt, it's a smaller blast radius. This post covers
how I run agents in a Docker `sbx` sandbox, declared in one file with the
experimental `sbx env` command: only the workspace is mounted, the network is
an explicit allowlist, and credentials are injected by a proxy so the agent
never holds them.

<!--more-->

## The threat model

I'm not worried about the agent being malicious. I'm worried about it being
*steerable*: a prompt injection hidden in a web page, an issue or a README,
or a compromised dependency that runs during a build. Once something is
executing with the agent's permissions, it can do whatever the agent can.

So the question becomes: what can the agent reach, and what is it holding?

1. **Filesystem.** Without isolation, my whole home directory.
2. **Network.** Without isolation, the entire internet.
3. **Credentials.** Without isolation, whatever tokens are in the
   environment or in dotfiles.

The goal is to cut each of those down to the minimum the task needs.

## The setup

| Resource | Restriction |
|----------|-------------|
| Filesystem | Only the project workspace is mounted. Nothing else from the host. |
| Network | Default deny. Only hosts on an explicit allowlist are reachable. |
| Credentials | Stored on the host and injected by the proxy. Never in the sandbox. |
| Definition | Files in the repository, reviewable like any other change. |

### Only the workspace

The sandbox gets the project directory and nothing else: no `~/.ssh`, no
`~/.config`, no other projects. If the agent trashes the workspace I have
Git; if it goes looking for anything outside of it, there is nothing to find.

### An explicit allowlist

Outbound traffic leaves through the sandbox's proxy, and the default is
deny. I list the hosts the task needs, for example the Git host and a package
registry, and everything else fails. That includes whatever a rogue build
script or injected instruction tries to phone home to.

### Credentials stay outside

Private resources need credentials, so the interesting part is giving the
agent *access* without giving it the *secret*. The secret lives on the host
side. When the sandboxed process makes a request to a host the secret is
bound to, the proxy adds the credential to the request. The process in the
sandbox never sees the raw value, so there is nothing to read from an
environment variable, a file or a process listing, and nothing to exfiltrate.

The token is also useless to an attacker outside the sandbox, because it is
only ever attached to requests for the hosts it is bound to.

## sbx env

`sbx env` manages a sandbox declared in an `sbxenv.yaml` file. According to
`sbx env --help`, the file selects the agent, kits, workspace mounts,
environment variables, secrets and credential bindings. The command is
marked **experimental**: it may change or be removed.

Changes that reach outside the sandbox need approval; `--force` skips the
prompt.

## The environment file

The top-level file only says *what* to run; the restrictions live in kits.

```yaml
schemaVersion: "1"
name: myproject
agent: claude
workspace: .

kits:
  - source: ./.docker-sbx/kits/project

sandboxOptions:
  memory: 8g
  cpus: 4
```

- `agent` picks the coding agent, here Claude Code.
- `workspace: .` is the only host directory the sandbox sees: the project
  itself.
- `kits` are composable building blocks. This one is a local kit in the
  repository (`./.docker-sbx/kits/project`) that holds the network policy and
  the credential binding.
- `sandboxOptions` caps resources, here 8 GB of memory and 4 CPUs.

Because the kit lives in the repository, the sandbox definition is versioned
and reviewed together with the code.

## Example: a Gradle project on a private Artifactory

A concrete case: a Java project built with Gradle that pulls private
libraries from a company Artifactory. The agent needs to build and run tests,
so it needs those libraries, which means it needs a credential.

The kit is a *mixin* that declares capabilities. Two of them do the work:

```yaml
# syntax=docker/sandbox-kit:3
schemaVersion: "3"
kind: mixin
displayName: My Project
description: "Network policy and Artifactory credentials"

capabilities:
  - type: com.docker.sandbox/network-policy@1
    config:
      runtime:
        allow:
          - artifactory.example.com
          - registry.npmjs.org
          - docs.gradle.org
          - "**.angular.dev"

  - type: com.docker.sandbox/credential@1
    description: Artifactory identity token (sent as a bearer token)
    config:
      service: artifactory
      phase: runtime
      apiKey:
        name: ORG_GRADLE_PROJECT_artifactoryApiKey
        proxyManaged: true
        inject:
          - domain: artifactory.example.com
            header: Authorization
            format: "Bearer %s"
```

### Allowlist

`network-policy` lists the hosts reachable at runtime. Everything else is
denied. Mine contains:

- **The Artifactory host.** It mirrors most of what the build needs, so one
  entry covers Maven dependencies and Gradle plugins.
- **Anything without a mirror**, here the npm registry for a frontend module.
- **Documentation sites** for the stack, so the agent can look things up
  instead of guessing. Wildcards like `"**.angular.dev"` cover subdomains.

### Credential binding

`credential` is the part that keeps the token out of the sandbox:

- `proxyManaged: true` means the proxy owns the value.
- `inject` says where the proxy attaches it: for requests to
  `artifactory.example.com`, it sets the `Authorization` header to
  `Bearer <token>`. Requests to any other host don't get it.
- The name `ORG_GRADLE_PROJECT_artifactoryApiKey` follows Gradle's convention
  for project properties from the environment, so the build can read it as
  `artifactoryApiKey`, exactly like on my own machine.

### HTTPS and the JVM

The proxy has to see the traffic to add a header, so it re-signs HTTPS with a
per-sandbox CA. The sandbox hands that CA over as a base64 string in the
`PROXY_CA_CERT_B64` environment variable. The OS certificate bundle trusts
it already, but a JDK has its own truststore, and Gradle then fails with
`PKIX path building failed`.

The fix is a startup hook in the kit that copies the JDK's `cacerts`, adds
the proxy CA, and points the JVM at the copy:

```sh
truststore="$HOME/.sbx-truststore.jks"
cp "$JAVA_HOME/lib/security/cacerts" "$truststore" && chmod u+w "$truststore"
echo "$PROXY_CA_CERT_B64" | base64 -d > "$truststore.pem"
"$JAVA_HOME/bin/keytool" -importcert -noprompt -trustcacerts -alias sbxproxy \
  -file "$truststore.pem" -keystore "$truststore" -storepass changeit
export JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS \
  -Djavax.net.ssl.trustStore=$truststore -Djavax.net.ssl.trustStorePassword=changeit"
```

Append the existing `JAVA_TOOL_OPTIONS` instead of replacing it: the sandbox
already uses it for the JVM's proxy settings.

## Using it

The first time, `sbx env run` creates the sandbox from the environment file
and attaches to the agent session:

```bash
sbx env run --name <project>
```

If the environment is split across several files, for example a shared
`sbxenv.yaml` plus a personal overlay, list them in order:

```bash
sbx env run sbxenv.yaml sbxenv.overlay.yaml --name <project>
```

After that the sandbox exists, so starting or rejoining it is just:

```bash
sbx run --name <project>
```

## Things to watch out for

The help text is blunt about these, and they matter:

- **Host commands run as you.** Lifecycle commands, command-based secrets and
  command-backed MCP servers execute on the host with your permissions. Keep
  secret helpers and their dependencies outside writable sandbox mounts and
  use absolute helper paths. A helper the agent can overwrite is a way out of
  the sandbox.
- **The env file is read-only inside the sandbox.** That is the default and I
  would leave it. `sandboxOptions.writableEnvFiles` would let the agent change
  what future invocations run on the host.
- **The workspace is still writable.** Anything the agent can write there
  ends up in your repository, so review the diff like you would any other
  contribution.
- **Secrets are provisioned at creation.** Changing a secret or binding means
  recreating the sandbox: remove it with `sbx rm --name <project>`, then run
  `sbx env run` again.
- **It's experimental.** Pin the `sbx` version and expect the file format to
  change.

## Summary

A few small files in the repository describe a sandbox that sees only the
workspace, can only talk to the hosts I name, and never holds the credentials
it uses.
The agent gets to work without asking permission for every command, and a
compromised agent or build gets nothing worth stealing and nowhere to send
it.

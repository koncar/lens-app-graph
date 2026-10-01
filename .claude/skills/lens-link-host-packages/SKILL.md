---
name: lens-link-host-packages
description: "Point this extension's @k8slens packages at the working tree of the running Lens development host with symlinks, so local host changes land without publishing. Also run it right after any npm install, which voids the links."
user_invocable: true
---

# Link this extension to the running Lens development host

Replaces the extension's `node_modules/@k8slens/*` entries with symlinks into the working tree of the Lens development host that is currently running, so type checking and `npm run build` use the host's local, possibly unpublished, packages.

## Procedure

1. Open `~/.k8slens/extensions/extension-development-instructions/README.md` and follow its link to the instruction titled "Linking host packages from the running Lens development host (development only)". Lens rewrites these files on every app load with the monorepo path of the host it was started from, and that instruction is the only trustworthy source of the path: never reuse a path from memory or from an earlier run, the developer may have switched branch or worktree since. If the README lists no such instruction, the running Lens is a production build with no working tree to link to. Say so and stop.
2. From the extension root (this directory), run the **Link** block from that file verbatim.
3. Verify with `ls -l node_modules/@k8slens`: every entry must be a symlink into the host tree. Report the host path you linked to.

## While linked

- Never run `npm install`, `npm install <package>`, `npm ci` or `npm update` without re-running this skill straight after. Any install puts the published copies back and silently voids the links. When a host change "isn't there", check for this first.
- A host change reaches the extension after `npm run build -w @k8slens/<package>` in the host monorepo, followed by `npm run build` here.
- `/lens-unlink-host-packages` restores the published packages.

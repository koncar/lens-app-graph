---
name: lens-unlink-host-packages
description: "Remove the symlinks into the Lens development host's working tree and reinstall the published @k8slens packages declared in package.json, so the extension builds the way it will for users."
user_invocable: true
---

# Unlink this extension from the Lens development host

Removes the symlinks `/lens-link-host-packages` created under `node_modules/@k8slens/` and reinstalls the published packages declared in `package.json`.

## Procedure

1. Check `ls -l node_modules/@k8slens`. If no entry is a symlink, nothing is linked. Say so and stop.
2. From the extension root (this directory), run:

   ```sh
   find node_modules/@k8slens -maxdepth 1 -type l -delete
   npm install
   ```

3. Verify no symlinks remain under `node_modules/@k8slens`, then run `npm run build` to confirm the extension compiles against the published packages.

If `npm install` fails with a 404, a `@k8slens` version in `package.json` is not published yet. Re-run `/lens-link-host-packages` and try again after the host's release is out.

# Obsidian guide

This guide opens your vault in Obsidian on your computer and keeps it in sync with the vault
repository, so you read and edit the notes the service writes. For the install itself, see
[INSTALL.md](INSTALL.md).

The service writes to the vault repository on your Git host. Obsidian reads a folder on your
computer. The Obsidian Git plugin connects the two: it pulls what the service wrote and pushes what
you edit.

## Before you start

- The service is installed and has written at least one note (INSTALL.md, "Save a first note").
- Obsidian is installed on your computer (https://obsidian.md).
- Git is installed on your computer. On Windows, install Git for Windows
  (https://git-scm.com/download/win) with its default options: it includes the credential manager
  that signs you in to your Git host once.

## Clone the vault

Pick the folder that will hold the vault and clone the vault repository there. On Windows, in
PowerShell:

```powershell
cd $HOME\Documents
git clone https://github.com/<owner>/<vault-repository>.git
```

If the repository is private and your computer has no saved sign-in for your Git host, a browser
window opens to sign in. Approve it; the credential manager keeps the sign-in for later pulls and
pushes. Use the clone address of your own vault repository, not the one the service uses (the
service uses an SSH deploy key that stays on the server).

## Open it in Obsidian

In Obsidian choose "Open folder as vault" and select the cloned folder. If Obsidian asks whether you
trust the author of the vault, confirm.

## Install Obsidian Git

Obsidian Git is a community plugin that runs inside Obsidian.

1. Open Settings, then Community plugins, and turn community plugins on.
2. Choose Browse, search for "Git" (by Vinzent03), then Install and Enable.
3. Open the plugin's options and set:
   - Auto commit-and-sync interval (minutes): `5`. Every 5 minutes it commits your edits, pulls
     what the service wrote and pushes.
   - Pull on startup: on.
   - Pull on commit-and-sync and Push on commit-and-sync: on.
   - Merge strategy: Rebase. The service also pulls with rebase, so the history stays linear.
   - Merge strategy on conflicts: None (Git default). The other choices drop one side without
     telling you.

Plugin option names change between versions. If an option is missing, look for the one that pulls
before it pushes.

A note the service wrote reaches Obsidian within one interval, or right away with the command
palette (Ctrl+P on Windows) and "Obsidian Git: Pull".

## Templates

If your vault has a templates folder, open Settings, then Core plugins, turn on Templates, and set
its folder in the Templates options. The vault template has no templates folder; add one if you
want it.

## Why both sides can write

- The service pulls with rebase before every write and pushes right after it, so it builds on your
  latest pushed edits.
- When you and the service change the same note at the same time and Git cannot merge the change,
  the service keeps both versions: yours stays, and its version is saved next to it as a conflict
  copy (docs/adr/0008-vault-safety.md).
- Most service writes create new files, so conflicts are rare.

## What to avoid

- Do not delete or rename notes the service may still update, such as a meeting note before its
  analysis is linked. Move what you no longer want to the archive folder of your config.
- Do not edit the body of a meeting transcript. Its properties can change; its text is the record
  of the meeting.
- Do not change `.2brain/config.yaml` from Obsidian unless you mean to: the service reads it on
  every write, and an invalid config stops writes until it is fixed.

## Phone

Obsidian Git also runs on Obsidian mobile, with limits described in the plugin's own
documentation. A simpler path on the phone is an AI client connected to your brain over MCP: ask it
to search the vault or save an idea.

# TickTick Simple Sync (Obsidian Plugin)

Minimal one-way sync from TickTick to Obsidian.

## What it does

- Imports open TickTick tasks into Obsidian as notes.
- Adds each imported task to the daily note as:

  ```md
  - [[Task Title]]
  ```

- Creates the task note with:
  - frontmatter `date` from `task.startDate`
  - frontmatter `tags` including the TickTick project name
  - body from `task.content`

## Sync behavior

- One-way only: TickTick -> Obsidian.
- Runs once on plugin startup.
- Runs again on a configured interval.
- For each open TickTick task (`status === 0`):
  - if a note with the same name already exists in the vault, it is skipped
  - otherwise, a new note is created and linked in the daily note
- Existing notes are not updated, renamed, or deleted.
- No task creation/updates are sent back to TickTick.

## Settings

- `Client ID` - from your TickTick developer app.
- `Client secret` - from your TickTick developer app.
- `Redirect URL` - must match your app's configured OAuth redirect URL.
- `Open authorization page` - opens TickTick OAuth consent screen.
- `Authorization response` - paste redirected URL (or just `code`).
- `Connect` - exchanges code for access token.
- `Task notes folder` - where imported task notes are created.
  - default: `/` (vault root)
  - example: `/tasks/`
- `Sync interval (minutes)`
  - `0` disables periodic sync

Daily note format is fixed to `YYYY-MM-DD.md`.

## Build

```bash
bun install
bun run check
bun run build
```

Build output:

- `main.js`
- `manifest.json`

## Install in Obsidian

1. Create a plugin folder in your vault, for example:
   `.obsidian/plugins/ticktick-simple-sync/`
2. Copy these files into that folder:
   - `main.js`
   - `manifest.json`
3. In Obsidian, open **Settings -> Community plugins**.
4. Reload plugins (or restart Obsidian), then enable **TickTick Simple Sync**.
5. Open plugin settings and configure OAuth:
   - paste `Client ID`, `Client secret`, `Redirect URL`
   - click **Open authorization page**
   - authorize in browser
   - paste redirected URL into **Authorization response**
   - click **Connect**

## Notes

- OAuth tokens are stored in the plugin's local data file in your vault.
- This plugin is intentionally minimal by design.

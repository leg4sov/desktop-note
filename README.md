# Post-it

A realistic yellow sticky note for the GNOME desktop, with a minimal to-do list and a small note icon in the top bar.

![status](https://img.shields.io/badge/GNOME%20Shell-50-blue) ![platform](https://img.shields.io/badge/Wayland-Fedora%2044-informational)

## Features

- **One sticky note** floating on your desktop, toggled from an icon in the top bar.
- **Minimal to-do list**: press `Enter` to commit a line and start a new one below.
- **Tick to strike, tick again to delete**: the first click on the ✓ strikes the line through, the second removes it.
- **Pin it above your windows**: unpinned, the note sits *below* windows like a desktop widget; pinned, it stays on top.
- **Draggable** by its header, pinned or not, and it never leaves the screen.
- **Auto-save**: lines, strike state, position, pinned and visible state are restored after a reboot.
- **Keyboard friendly**: `↑`/`↓` move between lines, `Backspace` on an empty line deletes it, `Esc` releases focus.
- Enable / disable it from the **Extensions** app like any other extension.

## Requirements

- GNOME Shell **50** (the only version declared in `metadata.json` so far)
- Wayland session (developed and tested on Fedora 44)

## Installation

Clone the repository straight into your extensions directory, using the extension UUID as the folder name:

```bash
git clone https://github.com/leg4sov/desktop-note.git ~/.local/share/gnome-shell/extensions/postit@leg4sov
```

Log out and back in (Wayland cannot restart the shell in place), then enable it:

```bash
gnome-extensions enable postit@leg4sov
```

or use the **Extensions** app.

## Usage

| Action | How |
|---|---|
| Show / hide the note | Click the note icon in the top bar |
| Add a task | Type, then `Enter` |
| Strike a task | Click the ✓ on its left |
| Delete a struck task | Click the ✓ again |
| Move the note | Drag the strip at the top |
| Keep it above windows | Click the pin icon in the header |
| Change line | `↑` / `↓` |
| Delete an empty line | `Backspace` |
| Leave the text field | `Esc` |

## Where your notes are stored

```
~/.local/share/postit-note/notes.json
```

The file lives outside the extension folder, so updating or reinstalling the extension never erases your notes. Writes are debounced (500 ms) and atomic. If the file is corrupted it is moved to `notes.json.bak` and the note starts empty.

## Development

The extension is plain GNOME Shell ESM JavaScript plus a CSS file, with no build step.

```
extension.js     # all the logic
stylesheet.css   # the look
metadata.json    # uuid, name, supported shell versions
PLAN.md          # design decisions and problems solved (in Spanish)
```

Wayland cannot reload the shell, so test in a nested shell (needs the `mutter-devkit` package on Fedora):

```bash
dbus-run-session gnome-shell --devkit --wayland
```

Use an isolated config (`GSETTINGS_BACKEND=keyfile` and a custom `XDG_CONFIG_HOME` with `enabled-extensions=['postit@leg4sov']`) so only this extension loads. Read the logs with:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Known limitations

- Pressing `Enter` on a line in the middle of the list moves focus to the next line instead of inserting a new one.
- The "below windows" layer uses GNOME Shell's internal `_backgroundGroup`, so it may break in a future GNOME release.
- Persistence has been verified in a nested shell; a full logout/login test is still pending.
- Single note, fixed size, no preferences window — on purpose.

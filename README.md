# Chromium Bridge

A small extension, local server and command-line tool that let scripts drive **your real, logged-in
Chromium browser** (Chrome, Edge, Brave...): list tabs, read pages, click, type, take screenshots, and read
Reddit threads and search results from the terminal.

> **A very simple, quickly-made tool that will mostly not be maintained.** Lightly tested, may break when
> Chrome or Reddit change. Issues and PRs are welcome but there's no promise of a reply. Fork it freely.
> It hands control of your browser to a local process: read [Security](#security) first.

## Install

**Windows, one line** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/AverageMo/chromium-bridge/main/install.ps1 | iex
```

It downloads this repo to `%LOCALAPPDATA%\ChromiumBridge` and runs `setup.ps1`, which checks for Node 18+
(offers to install it), optionally starts the server at logon, starts it, and opens `chrome://extensions`.
Piping into `iex` means trusting the script, so read [`install.ps1`](install.ps1) first; it's short.

Then, in the browser (a script can't do this part): turn on **Developer mode**, click **Load unpacked**,
and pick the `extension` folder. The setup window tells you when it connects.

**Any OS, by hand:** run `node server.js`, then load the `extension` folder as above. The badge turns green
and says `on`; check with `node cb.js status`. If it says `no token set`, paste `token.txt` into the
extension popup.

## Use

```
node cb.js new https://example.com     # open a tab and make it current
node cb.js snap                        # numbered elements: [e3] link "More information..."
node cb.js click e3
node cb.js type e7 "hello" --enter
node cb.js text                        # readable page text
node cb.js shot page.png
node cb.js help                        # everything else
```

### Reddit

Reddit's pages are awkward to scrape, so these read its JSON (or old.reddit.com) using your logged-in session:

```
node cb.js research "jellyfin transcoding" --sub selfhosted --threads 3   # search, then read top threads
node cb.js reddit r/selfhosted --sort top --t week
node cb.js reddit "<thread url>" --sort top --max 80
node cb.js reddit u/someuser
```

Keep the volume low and follow Reddit's terms. This is personal-use tooling.

## Notes

- Chrome shows a "started debugging this browser" banner on tabs being controlled. It can't be hidden;
  `node cb.js detach` releases the tab.
- Not on the Chrome Web Store, and unlikely ever to be: the permissions it needs get strict review.

## Security

- The server listens on `127.0.0.1` only and needs a bearer token on every request. Web pages can't call it.
- `token.txt` (and the generated `extension/config.js`) **grant full control of your logged-in tabs**. Never
  share or commit them (they're in `.gitignore`). Delete `token.txt` and restart to rotate it.
- Anything running as your user can read the token. Stop the server when you're not using it.
- No telemetry. The only network calls are to `127.0.0.1` and, for the Reddit commands, reddit.com.

MIT licence, see [LICENSE](LICENSE). Provided as is.

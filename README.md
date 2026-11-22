# Chrome Bridge

A tiny Chrome extension plus a local server and command-line tool that let scripts drive **your real,
logged-in Chrome**: list tabs, read pages, click, type, take screenshots, read console/network, and read
Reddit threads and search results from the terminal.

> **Heads up: this is a very simple, quickly-made tool and it will mostly not be maintained.**
> It works for the author's use, has had light testing, and may break when Chrome or Reddit change.
> Issues and PRs are welcome but there's no promise of a response or a fix. Fork it and bend it to your needs.
> Read the [security notes](#security) before using it: it hands control of your browser to a local process.

No dependencies beyond Node 18+.

```
your script -> node cb.js ... -> POST /cmd -> server.js <- long-poll /poll <- extension -> chrome.debugger / chrome.scripting -> tabs
```

Input goes through the Chrome DevTools Protocol, so clicks and typing are trusted events (they work on
React/Vue pages, custom dropdowns, etc.), screenshots are real, and console/network output is captured.

## Install

### Windows (easiest)

1. Download or clone this repo and double-click **`setup.bat`**.
2. It checks for Node.js (and offers to install it with winget), optionally sets the server to start when
   you log in, starts the server, opens `chrome://extensions` and copies the extension folder path to your
   clipboard.
3. In Chrome, turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder. Chrome
   doesn't let scripts do this step for you. The setup window waits and tells you when the extension connects.

`setup.bat` is a thin wrapper around [`setup.ps1`](setup.ps1); read it if you want to see exactly what it does.
Pass `-SkipAutostart`, `-NoBrowser` or `-NoWait` to skip those parts.

### Windows without installing Node (packaged release)

The release zip (if one is attached to this repo's Releases page) contains `cb.exe`, which is just the
server and CLI from this repo bundled with Node into one file. Unzip it somewhere permanent, double-click
`setup.bat`, and follow the same steps. Use `cb.exe tabs`, `cb.exe snap`, etc. wherever this README says
`node cb.js ...`. `cb.exe server` runs the server.

It's unsigned, so SmartScreen may warn, and you can't read an exe the way you can read the source. If that
bothers you, skip it: run from source, or build it yourself with `node build-exe.js` (Windows, Node 20+;
it fetches `postject` from npm and writes `dist/chrome-bridge-win-x64.zip`).

### Manual (any OS)

1. Start the server and leave it running:
   ```
   node server.js
   ```
   The first run creates `token.txt` and writes `extension/config.js` so the extension can find the server.
   On Windows, `powershell -File start-bridge.ps1` starts it hidden (and does nothing if it is already up).
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the
   `extension` folder. (Load it *after* step 1, or click the extension's reload icon afterwards.)
3. The toolbar badge turns green and says `on`. Check from a terminal: `node cb.js status`.

If the badge says `no token set`, open the extension popup and paste the contents of `token.txt`.

### Optional: start the server at logon (Windows)

```
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1
```

## Use

```
node cb.js new https://example.com     # opens its own tab and makes it current
node cb.js snap                        # numbered elements: [e3] link "More information..." href=...
node cb.js click e3
node cb.js type e7 "hello" --enter
node cb.js text                        # readable page text
node cb.js shot page.png               # screenshot (--full for the whole page)
node cb.js console ; node cb.js network api
node cb.js eval "document.title"
node cb.js help                        # everything else
```

Refs (`e1`, `e2`, ...) are valid until the next `snap`; take a new snapshot after the page changes.
CSS selectors work anywhere a ref does.

### Reddit

Reddit's pages are heavy and shadow-DOM-based, so the `reddit` commands read Reddit's own JSON endpoints, or
the old.reddit.com HTML where the JSON is blocked, using your logged-in session. No tab needs to be open.

```
node cb.js research "jellyfin transcoding" --sub selfhosted --threads 3   # search, then read the top threads
node cb.js reddit r/selfhosted --sort top --t week --limit 15
node cb.js reddit "https://www.reddit.com/r/selfhosted/comments/abc123/some_title/" --sort top --max 80 --depth 3
node cb.js reddit search "jellyfin transcoding" --sub selfhosted --sort top --t year
node cb.js reddit u/someuser
node cb.js reddit r/selfhosted --after t3_abc123      # next page (printed at the bottom of a listing)
node cb.js reddit r/selfhosted --json                 # raw normalised data
```

Threads print as an indented comment tree; collapsed "load more" branches are counted but not expanded
(raise `--max`, or sort by `top`). If Reddit rate-limits (429), wait a minute. This is personal-use tooling:
you are responsible for following Reddit's terms and rate limits. Keep the volume low.

## Notes and limits

- While the debugger is attached to a tab Chrome shows "Chrome Bridge started debugging this browser".
  That is Chrome's own banner and can't be hidden. `node cb.js detach` releases the tab.
- Commands act on the last tab the bridge opened/activated/navigated, so the tab you are reading isn't hijacked.
  Use `tabs` to see ids and `--tab <id>` to target one.
- `snap` doesn't see inside iframes. Open shadow DOM is covered.
- `chrome://` pages, the Web Store and other extensions' pages can't be debugged by Chrome.
- A `shot` of a background tab can stall; `node cb.js activate <id>` first.
- Dialogs (alert/confirm/prompt) block the page; handle them with `node cb.js dialog`.
- `node cb.js raw extreload` reloads the extension from disk after you edit it.
- The service worker is kept alive by the long-poll plus a 30 s alarm. If Chrome suspends it, the next alarm
  reconnects within about a minute.
- Not on the Chrome Web Store, and unlikely ever to be: the debugger and all-sites permissions are what it
  does, and the store reviews those very strictly.

## Security

- The server binds to `127.0.0.1` only, checks the `Host` header (DNS-rebinding guard), rejects any request
  whose `Origin` is a web page, and requires a bearer token on every endpoint.
- The token grants **full control of every tab in that Chrome profile, including logged-in sessions**.
  `token.txt` and the generated `extension/config.js` both contain it. Treat them like a password: never commit,
  share, or sync them (they are in `.gitignore`). Delete `token.txt` and restart the server to rotate it.
- Anything running as your user on the machine can read `token.txt` and use the bridge. Stop the server (or
  disable the extension) when you aren't using it.
- No telemetry, no network calls except to `127.0.0.1` and, for the Reddit commands, to reddit.com.

## License

MIT, see [LICENSE](LICENSE). Provided as is, without warranty.

# Chromium Bridge

Lets a script or program use your own web browser, already logged in, the way you would: open pages, read
them, click, type, take screenshots, and read Reddit threads. It works with Chrome, Edge, Brave and other
Chromium browsers.

It also works well with AI assistants such as Claude: tell one to run these commands and it can browse and
research on the web using your logins.

> This is a simple, quickly-made tool and it will mostly not be maintained. It's lightly tested and may
> break when Chrome or Reddit change. Feel free to fork it. Please read [Is it safe?](#is-it-safe) first.

## Install (Windows)

1. Open **PowerShell** and paste this:

   ```powershell
   irm https://raw.githubusercontent.com/AverageMo/chromium-bridge/main/install.ps1 | iex
   ```

   It downloads the tool, installs Node.js if you need it (it asks first), and opens your browser's
   extensions page. You can read [install.ps1](install.ps1) first if you like. It's short.

2. On the extensions page, turn on **Developer mode** (top right), click **Load unpacked**, and choose the
   `extension` folder it shows you.

3. Done. The setup window says "connected" when it works.

On Mac or Linux: install Node.js, run `node server.js`, then do step 2.

## Using it

Commands are typed in a terminal from the install folder:

```
node cb.js new https://example.com     open a page
node cb.js text                        read the page
node cb.js shot page.png               take a screenshot
node cb.js research "your question" --sub selfhosted     search Reddit and read the top threads
node cb.js help                        see everything else
```

Reddit searches use your own logged-in session. Keep it light and follow Reddit's rules.

## Using it with Claude Code

There's a ready-made Claude Code skill. Copy the `skill\chromium-bridge` folder from the install folder
into `~/.claude/skills/` (on Windows, `C:\Users\<your name>\.claude\skills\`) and Claude will know how to
use the tool whenever you ask it to research or browse. In PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force "$env:LOCALAPPDATA\ChromiumBridge\skill\chromium-bridge" "$HOME\.claude\skills\"
```

Or, without the skill, paste something like this into the chat (or into your `CLAUDE.md` so it remembers):

```
To browse the web with my real, logged-in browser, use the Chromium Bridge tool. First run
powershell -ExecutionPolicy Bypass -File "C:\Users\<your name>\AppData\Local\ChromiumBridge\start-bridge.ps1"
(it does nothing if already running). Then use it like this, from any folder:
node "C:\Users\<your name>\AppData\Local\ChromiumBridge\cb.js" help
For research: node "C:\Users\<your name>\AppData\Local\ChromiumBridge\cb.js" research "<question>" --sub <subreddit>
```

Then ask it things like "research the best Black Friday Usenet deals". Other assistants that can run commands
work the same way. Your browser has to be open with the extension loaded.

## Is it safe?

It gives whatever runs on your computer full control of your browser, including sites you're logged in to,
so only use it if you're comfortable with that.

- It only listens on your own computer, and nothing from the internet can reach it.
- It needs a secret key (`token.txt`) to work. Never share that file. Anything on your PC that can read it
  can control your browser, so stop the tool when you're not using it.
- It sends nothing anywhere, except to Reddit when you use the Reddit commands.
- Your browser shows a "started debugging this browser" bar on pages it controls. That's normal.

MIT licence, provided as is. See [LICENSE](LICENSE).

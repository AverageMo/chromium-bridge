#!/usr/bin/env node
'use strict';
// Chrome Bridge CLI. Run `node cb.js help` for usage.
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CB_PORT) || 9333;
let TOKEN = process.env.CB_TOKEN || '';
if (!TOKEN) { try { TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim(); } catch { /* none */ } }

const HELP = `Chrome Bridge CLI   (node cb.js <command> ...)

Global flags: --tab <id>   act on a specific tab (default: last tab used, else the active tab)
              --timeout <ms>

Tabs
  tabs                         list all tabs
  new [url]                    open a new tab (becomes the current tab)
  go <url>                     navigate the current tab
  back | forward | reload
  activate <tabId>             bring a tab to the front and make it current
  use <tabId>                  make a tab current without focusing it
  close [tabId]

Reading
  snap [--limit n]             numbered list of clickable/typeable elements (refs like e12)
  text [selector]              visible page text
  shot <file.png> [--full] [--jpeg]
  console [--clear]            console output / exceptions since the tab was first used
  network [filter] [--clear]   requests since the tab was first used
  body <requestId>             response body of a request from "network"

Acting
  click <ref|selector|x y> [--double] [--right]
  hover <ref|selector|x y>
  type <ref|selector> <text> [--clear] [--enter]     (no ref: types into the focused element)
  key <Enter|Tab|Escape|ctrl+a|shift+Tab ...>        space-separated for several
  scroll <down|up|top|bottom|pixels>
  select <ref|selector> <option text or value>
  upload <selector> <file> [file...]
  dialog [--dismiss] [--text t] | dialog --status
  wait [ms] | wait --selector <css> | wait --text <string>   (--timeout ms)
  eval <js>                    run JavaScript in the page and print the result

Reddit  (uses your logged-in Chrome session; no tab needed)
  research "<question or keywords>" [--sub name] [--threads 3] [--max 25] [--depth 2] [--t year]
                                           search, then read the top threads with their best comments
  reddit r/<sub> [--sort hot|new|top|rising|controversial] [--t day|week|month|year|all] [--limit n] [--after t3_xxx]
  reddit u/<user>                          a user's recent posts and comments
  reddit <thread url or /r/x/comments/id/...> [--sort top|best|new|controversial|old] [--depth n] [--max n]
  reddit search "<query>" [--sub <name>] [--sort relevance|new|top] [--t year]
  reddit                                   your front page

Other
  status                      is the extension connected?
  raw <method> [json params]   send any command
  cdp <Domain.method> [json]   raw Chrome DevTools Protocol call
  detach                       release the debugger on the tab (removes the yellow banner)
  token                        print the token (for pasting into the extension popup)
`;

function parseArgs(argv) {
  const pos = [], flags = {};
  const valueFlags = new Set(['tab', 'timeout', 'limit', 'selector', 'text', 'ms', 'sort', 't', 'depth', 'max', 'after', 'sub', 'threads']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const k = a.slice(2);
      if (valueFlags.has(k)) flags[k] = argv[++i]; else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function call(method, params = {}, timeout) {
  if (!TOKEN) throw new Error('no token: start server.js once so it creates token.txt');
  const r = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, timeout }),
  }).catch(e => { throw new Error(`cannot reach server on port ${PORT}: ${e.cause ? e.cause.code : e.message} (run: node server.js)`); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.result;
}

function age(utc) {
  const s = Math.max(0, Date.now() / 1000 - utc);
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 60) return Math.round(s / 86400) + 'd';
  return Math.round(s / 86400 / 30.4) + 'mo';
}

function renderReddit(r) {
  const L = [];
  if (r.kind === 'thread') {
    const p = r.post;
    L.push(`# ${p.title}`);
    L.push(`${p.subreddit} · u/${p.author} · ${p.score} pts (${Math.round((p.upvoteRatio || 0) * 100)}%) · ${p.comments} comments · ${age(p.created)} ago${p.flair ? ' · [' + p.flair + ']' : ''}${p.nsfw ? ' · NSFW' : ''}${p.locked ? ' · locked' : ''}${p.removed ? ' · removed:' + p.removed : ''}`);
    if (p.url) L.push(`link: ${p.url}`);
    if (p.gallery) L.push(`(gallery of ${p.gallery} images)`);
    if (p.selftext) L.push('', p.selftext);
    L.push('', `--- ${r.comments.length} comments shown${r.moreHidden ? `, ~${r.moreHidden} more collapsed ("load more")` : ''}${r.truncated ? ', cut at --max' : ''} ---`);
    for (const c of r.comments) {
      const pad = '  '.repeat(c.depth);
      const tags = [c.op ? 'OP' : '', c.stickied ? 'pinned' : '', c.distinguished || '', c.edited ? 'edited' : ''].filter(Boolean).join(',');
      L.push('', `${pad}u/${c.author}${tags ? ' [' + tags + ']' : ''} · ${c.score} · ${age(c.created)}`);
      for (const line of String(c.body).split('\n')) L.push(`${pad}${line}`);
    }
    return L.join('\n');
  }
  r.items.forEach((it, i) => {
    if (it.type === 'post') {
      L.push(`${String(i + 1).padStart(2)}. ${it.stickied ? '📌 ' : ''}${it.title}${it.flair ? ' [' + it.flair + ']' : ''}${it.nsfw ? ' [NSFW]' : ''}`);
      L.push(`    ${it.subreddit} · u/${it.author} · ${it.score} pts · ${it.comments} comments · ${age(it.created)} ago · ${it.isSelf ? 'text' : it.domain}`);
      L.push(`    ${it.permalink}`);
      if (it.selftext) L.push(`    ${it.selftext.replace(/\s+/g, ' ').slice(0, 240)}${it.selftext.length > 240 ? '…' : ''}`);
    } else if (it.type === 'comment') {
      L.push(`${String(i + 1).padStart(2)}. [comment] ${it.subreddit} · on "${(it.postTitle || '').slice(0, 70)}" · ${it.score} pts · ${age(it.created)} ago`);
      L.push(`    ${it.body.replace(/\s+/g, ' ').slice(0, 300)}`);
      L.push(`    ${it.permalink}`);
    } else if (it.type === 'subreddit') {
      L.push(`${String(i + 1).padStart(2)}. ${it.name} · ${it.subscribers} members · ${it.description}`);
    }
  });
  if (!r.items.length) L.push('(no results)');
  if (r.after) L.push('', `next page: --after ${r.after}`);
  return L.join('\n');
}

const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const num = s => (s !== undefined && s !== '' && !isNaN(Number(s)));

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);
  if (cmd === 'token') return console.log(TOKEN);

  const base = {};
  if (flags.tab) base.tabId = Number(flags.tab);
  const t = flags.timeout ? Number(flags.timeout) : undefined;
  const target = args => {
    // ref/selector/x y from positional args
    const first = args[0];
    if (first === undefined) throw new Error('need a ref, selector, or x y');
    if (num(first) && num(args[1])) return { x: Number(first), y: Number(args[1]) };
    if (/^e\d+$/.test(first)) return { ref: first };
    return { selector: first };
  };

  switch (cmd) {
    case 'status': {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { Authorization: 'Bearer ' + TOKEN } })
        .catch(() => { throw new Error('server not running (node server.js)'); });
      return out(await r.json());
    }
    case 'tabs': {
      const tabs = await call('tabs', base, t);
      return console.log(tabs.map(x => `${x.current ? '>' : x.active ? '*' : ' '} ${String(x.id).padEnd(6)} ${(x.title || '').slice(0, 50).padEnd(50)} ${x.url}`).join('\n'));
    }
    case 'new': return out(await call('new', { ...base, url: pos[0] }, t));
    case 'go': return out(await call('go', { ...base, url: pos[0] }, t));
    case 'back': case 'forward': case 'reload': return out(await call(cmd, base, t));
    case 'activate': case 'use': return out(await call(cmd, { tabId: Number(pos[0]) }, t));
    case 'close': return out(await call('close', pos[0] ? { tabId: Number(pos[0]) } : base, t));
    case 'snap': {
      const r = await call('snap', { ...base, limit: flags.limit ? Number(flags.limit) : undefined }, t);
      return console.log(`tab ${r.tabId}  ${r.title}\n${r.url}\nviewport ${r.viewport.w}x${r.viewport.h}, scrollY ${r.viewport.scrollY}/${r.viewport.pageH}  (${r.note})\n\n${r.snapshot}`);
    }
    case 'text': {
      const r = await call('text', { ...base, selector: pos[0] }, t);
      return console.log(`${r.title}\n${r.url}${r.truncated ? '\n(truncated)' : ''}\n\n${r.text}`);
    }
    case 'shot': {
      const file = pos[0] || 'shot.png';
      const r = await call('screenshot', { ...base, full: !!flags.full, format: flags.jpeg ? 'jpeg' : 'png' }, t);
      fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
      return console.log(path.resolve(file));
    }
    case 'console': {
      const r = await call('console', { ...base, clear: !!flags.clear, limit: flags.limit ? Number(flags.limit) : undefined }, t);
      return console.log(r.length ? r.map(x => `[${x.level}] ${x.text}`).join('\n') : '(empty)');
    }
    case 'network': {
      const r = await call('network', { ...base, filter: pos[0], clear: !!flags.clear, limit: flags.limit ? Number(flags.limit) : undefined }, t);
      return console.log(r.length ? r.map(x => `${x.id}  ${x.method} ${x.status || (x.error ? 'ERR' : '...')} ${x.url}`).join('\n') : '(empty)');
    }
    case 'body': {
      const r = await call('body', { ...base, requestId: pos[0] }, t);
      return console.log(r.base64Encoded ? `(base64, ${r.body.length} chars)\n${r.body.slice(0, 2000)}` : r.body);
    }
    case 'click': return out(await call('click', { ...base, ...target(pos), double: !!flags.double, button: flags.right ? 'right' : 'left' }, t));
    case 'hover': return out(await call('hover', { ...base, ...target(pos) }, t));
    case 'type': {
      let p = { ...base, clear: !!flags.clear, enter: !!flags.enter };
      if (pos.length >= 2) { p = { ...p, ...target([pos[0]]), text: pos.slice(1).join(' ') }; }
      else p.text = pos[0] || '';
      return out(await call('type', p, t));
    }
    case 'key': return out(await call('key', { ...base, key: pos.join(' ') }, t));
    case 'scroll': {
      const d = pos[0] || 'down';
      const p = { ...base };
      if (d === 'top' || d === 'bottom') p.to = d;
      else if (num(d)) p.dy = Number(d);
      else p.dy = d === 'up' ? -600 : 600;
      return out(await call('scroll', p, t));
    }
    case 'select': return out(await call('select', { ...base, ...target([pos[0]]), value: pos.slice(1).join(' ') }, t));
    case 'upload': return out(await call('upload', { ...base, selector: pos[0], files: pos.slice(1).map(f => path.resolve(f)) }, t));
    case 'dialog':
      return out(await call('dialog', { ...base, status: !!flags.status, accept: !flags.dismiss, text: flags.text }, t));
    case 'wait': {
      const p = { ...base, selector: flags.selector, text: flags.text, timeout: t };
      if (pos[0] && num(pos[0])) p.ms = Number(pos[0]);
      return out(await call('wait', p, (t || 15000) + 5000));
    }
    case 'research': {
      // search, then read the top threads (best comments first) in one go
      const query = pos.join(' ');
      if (!query) throw new Error('usage: research "<query>" [--sub name] [--threads 3] [--max 25] [--depth 2] [--t year] [--sort relevance|top|new]');
      const nThreads = Number(flags.threads) || 3;
      const found = await call('reddit', { search: query, sub: flags.sub, sort: flags.sort || 'relevance', t: flags.t, limit: Math.max(nThreads * 2, 10) }, t);
      const hits = found.items.filter(x => x.type === 'post');
      console.log(`# Search: "${query}"${flags.sub ? ' in r/' + String(flags.sub).replace(/^r\//, '') : ''} — ${hits.length} results\n`);
      console.log(renderReddit({ ...found, items: hits.slice(0, 10), after: null }));
      const pick = hits.filter(x => x.comments > 0).slice(0, nThreads);
      for (const h of pick) {
        console.log(`\n\n${'='.repeat(80)}\n`);
        try {
          const th = await call('reddit', { target: h.permalink, sort: 'top', depth: Number(flags.depth) || 2, maxComments: Number(flags.max) || 25 }, t);
          console.log(`<${h.permalink}>\n`);
          console.log(renderReddit(th));
        } catch (e) { console.log(`(could not read ${h.permalink}: ${e.message})`); }
      }
      return;
    }
    case 'reddit': {
      const p = { sort: flags.sort, t: flags.t, after: flags.after, depth: flags.depth, limit: flags.limit ? Number(flags.limit) : undefined, maxComments: flags.max ? Number(flags.max) : undefined };
      if (pos[0] === 'search') { p.search = pos.slice(1).join(' '); p.sub = flags.sub; }
      else p.target = pos[0] || '';
      const r = await call('reddit', p, t);
      return flags.json ? out(r) : console.log(renderReddit(r));
    }
    case 'eval': return out(await call('eval', { ...base, js: pos.join(' ') }, t));
    case 'detach': return out(await call('detach', base, t));
    case 'raw': return out(await call(pos[0], { ...base, ...(pos[1] ? JSON.parse(pos[1]) : {}) }, t));
    case 'cdp': return out(await call('cdp', { ...base, cdpMethod: pos[0], cdpParams: pos[1] ? JSON.parse(pos[1]) : {} }, t));
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      process.exit(2);
  }
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });

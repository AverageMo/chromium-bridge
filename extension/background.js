'use strict';
// Chrome Bridge service worker.
// Long-polls the local bridge server for commands, runs them against real tabs
// (chrome.debugger for trusted input / screenshots / CDP, chrome.scripting for DOM reads),
// and posts results back.

try { importScripts('config.js'); } catch { /* no generated config; use the popup */ }
const CFG = self.CB_DEFAULTS || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

const attached = new Set();
const bufs = new Map();     // tabId -> {console: [], network: Map}
const dialogs = new Map();  // tabId -> pending dialog info
const MAX_LOG = 500;

// ---------------------------------------------------------------- connection loop

let polling = false;
let abortCurrent = null;

async function setStatus(status) {
  await chrome.storage.local.set({ status });
  const ok = status === 'connected';
  chrome.action.setBadgeText({ text: ok ? 'on' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#0a7d2c' : '#b3261e' });
}

async function loop() {
  if (polling) return;
  polling = true;
  let backoff = 1000;
  for (;;) {
    const st = await chrome.storage.local.get(['port', 'token']);
    const port = st.port || CFG.port || 9333;
    const token = st.token || CFG.token || '';
    if (!token) { await setStatus('no token set'); await sleep(3000); continue; }
    const ac = new AbortController();
    abortCurrent = () => ac.abort();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/poll`, {
        headers: { Authorization: 'Bearer ' + token },
        signal: ac.signal,
      });
      if (r.status === 401) { await setStatus('wrong token'); await sleep(4000); continue; }
      await setStatus('connected');
      backoff = 1000;
      if (r.status === 200) {
        const cmd = await r.json();
        run(cmd, port, token); // not awaited: keep polling while it works
      }
    } catch (e) {
      if (e.name !== 'AbortError') { await setStatus('server not reachable'); await sleep(backoff); backoff = Math.min(backoff * 2, 10000); }
    }
  }
}

async function run(cmd, port, token) {
  let body;
  try {
    const fn = commands[cmd.method];
    if (!fn) throw new Error('unknown method: ' + cmd.method);
    body = { id: cmd.id, result: await fn(cmd.params || {}) };
  } catch (e) {
    body = { id: cmd.id, error: String((e && e.message) || e) };
  }
  try {
    await fetch(`http://127.0.0.1:${port}/result`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* server gone; command will time out on its side */ }
}

chrome.runtime.onMessage.addListener(m => { if (m && m.type === 'kick') { abortCurrent && abortCurrent(); loop(); } });
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
loop();

// ---------------------------------------------------------------- debugger plumbing

function buf(tabId) {
  let b = bufs.get(tabId);
  if (!b) { b = { console: [], network: new Map() }; bufs.set(tabId, b); }
  return b;
}
const pushLog = (arr, item) => { arr.push(item); if (arr.length > MAX_LOG) arr.shift(); };

chrome.debugger.onDetach.addListener(src => { if (src.tabId != null) { attached.delete(src.tabId); dialogs.delete(src.tabId); } });
chrome.tabs.onRemoved.addListener(id => { attached.delete(id); bufs.delete(id); dialogs.delete(id); });

chrome.debugger.onEvent.addListener((src, method, p) => {
  const tabId = src.tabId;
  if (tabId == null) return;
  const b = buf(tabId);
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushLog(b.console, { t: Date.now(), level: p.type, text: p.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ') });
      break;
    case 'Runtime.exceptionThrown':
      pushLog(b.console, { t: Date.now(), level: 'exception', text: (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text });
      break;
    case 'Network.requestWillBeSent':
      b.network.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type });
      if (b.network.size > MAX_LOG) b.network.delete(b.network.keys().next().value);
      break;
    case 'Network.responseReceived': {
      const r = b.network.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
      break;
    }
    case 'Network.loadingFailed': {
      const r = b.network.get(p.requestId);
      if (r) r.error = p.errorText;
      break;
    }
    case 'Page.javascriptDialogOpening':
      dialogs.set(tabId, { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt });
      break;
    case 'Page.javascriptDialogClosed':
      dialogs.delete(tabId);
      break;
  }
});

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // After a service-worker restart we are still attached; that is fine.
    if (!/already attached/i.test(String(e.message))) throw e;
  }
  attached.add(tabId);
  await cdp(tabId, 'Runtime.enable');
  await cdp(tabId, 'Network.enable');
  await cdp(tabId, 'Page.enable');
}

async function getCurrent() {
  const { current } = await chrome.storage.session.get('current');
  return current;
}
const setCurrent = tabId => chrome.storage.session.set({ current: tabId });

// Tab to act on: explicit tabId, else the last tab we created/activated/navigated, else the active tab.
async function tabOf(p) {
  if (p.tabId != null) return Number(p.tabId);
  const cur = await getCurrent();
  if (cur != null) { try { await chrome.tabs.get(cur); return cur; } catch { /* closed */ } }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('no active tab; open one with the "new" command');
  return t.id;
}

async function dbg(p) {
  const tabId = await tabOf(p);
  await attach(tabId);
  if (dialogs.has(tabId)) throw new Error('a JavaScript dialog is open: ' + JSON.stringify(dialogs.get(tabId)) + ' — use the "dialog" command');
  return tabId;
}

async function inPage(tabId, func, args = [], world = 'ISOLATED') {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return r && r.result;
}

function waitLoad(tabId, timeout = 30000) {
  return new Promise(resolve => {
    let sawLoading = false;
    const finish = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(t); clearTimeout(early); resolve(); };
    const l = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const t = setTimeout(finish, timeout);
    // Same-document navigations never go "loading"; don't hang for them.
    const early = setTimeout(async () => {
      if (sawLoading) return;
      try { if ((await chrome.tabs.get(tabId)).status === 'complete') finish(); } catch { finish(); }
    }, 2500);
    chrome.tabs.onUpdated.addListener(l);
  });
}

// ---------------------------------------------------------------- functions injected into pages (isolated world)

function snapshotFn(opts) {
  const W = window;
  W.__cc = { map: new Map(), n: 0 };
  const limit = opts.limit || 400;
  const sel = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=searchbox]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const roots = [document];
  const els = [];
  const seen = new Set();
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll(sel)) { if (!seen.has(el)) { seen.add(el); els.push(el); } }
    for (const host of roots[i].querySelectorAll('*')) { if (host.shadowRoot) roots.push(host.shadowRoot); }
  }

  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const roleOf = el => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'select';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SUMMARY') return 'summary';
    if (t === 'LABEL') return 'label';
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      return 'input:' + ty;
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const labelOf = el => {
    let s = el.getAttribute('aria-label') || '';
    if (!s && el.labels && el.labels.length) s = el.labels[0].innerText;
    if (!s && el.getAttribute('aria-labelledby')) {
      s = el.getAttribute('aria-labelledby').split(/\s+/).map(id => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
    }
    if (!s && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') s = el.innerText || el.textContent;
    if (!s && el.tagName === 'INPUT') s = (el.type === 'submit' || el.type === 'button') ? el.value : '';
    if (!s) s = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    if (!s) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) s = img.alt; }
    if (!s) s = el.getAttribute('name') || '';
    return clip(s, 80);
  };

  const lines = [];
  let count = 0, hidden = 0;
  for (const el of els) {
    if (!visible(el)) { hidden++; continue; }
    if (count >= limit) { lines.push(`… truncated at ${limit} elements`); break; }
    const ref = 'e' + (++W.__cc.n);
    W.__cc.map.set(ref, el);
    const r = el.getBoundingClientRect();
    const off = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    const bits = [];
    const role = roleOf(el);
    const label = labelOf(el);
    if (el.tagName === 'A' && el.href) bits.push('href=' + clip(el.href, 100));
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
      else if (type !== 'password' && el.value) bits.push('value=' + JSON.stringify(clip(el.value, 60)));
      else if (type === 'password') bits.push(el.value ? 'value=(set)' : 'value=(empty)');
      if (el.placeholder && label !== clip(el.placeholder, 80)) bits.push('placeholder=' + JSON.stringify(clip(el.placeholder, 40)));
    }
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      bits.push('selected=' + JSON.stringify(o ? clip(o.text, 40) : ''));
      bits.push('options=' + JSON.stringify([...el.options].slice(0, 12).map(x => clip(x.text, 30))));
    }
    if (el.disabled) bits.push('disabled');
    if (el.getAttribute('aria-expanded')) bits.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-checked')) bits.push('checked=' + el.getAttribute('aria-checked'));
    if (off) bits.push('offscreen');
    lines.push(`[${ref}] ${role} ${JSON.stringify(label)}${bits.length ? ' ' + bits.join(' ') : ''}`);
    count++;
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), pageH: document.documentElement.scrollHeight },
    note: hidden ? `${hidden} hidden matches skipped; iframes are not included` : 'iframes are not included',
    snapshot: lines.join('\n'),
  };
}

function prepFn(ref, selector) {
  const el = ref ? (window.__cc && window.__cc.map.get(ref)) : document.querySelector(selector);
  if (!el || !el.isConnected) return { error: ref ? `unknown or stale ref ${ref}; run "snap" again` : `no element matches ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
}

function focusFn(ref, selector, clear) {
  const el = ref ? (window.__cc && window.__cc.map.get(ref)) : document.querySelector(selector);
  if (!el || !el.isConnected) return { error: ref ? `unknown or stale ref ${ref}; run "snap" again` : `no element matches ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();
  if (clear) {
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
    else if (el.isContentEditable) document.execCommand('selectAll');
  }
  return { ok: true, tag: el.tagName.toLowerCase() };
}

function textFn(selector, max) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: 'no element matches ' + selector };
  let t = root.innerText || '';
  const truncated = t.length > max;
  if (truncated) t = t.slice(0, max);
  return { url: location.href, title: document.title, truncated, text: t };
}

// ---------------------------------------------------------------- input helpers

const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab', ''], Escape: [27, 'Escape', ''], Backspace: [8, 'Backspace', ''],
  Delete: [46, 'Delete', ''], ArrowUp: [38, 'ArrowUp', ''], ArrowDown: [40, 'ArrowDown', ''],
  ArrowLeft: [37, 'ArrowLeft', ''], ArrowRight: [39, 'ArrowRight', ''], Home: [36, 'Home', ''], End: [35, 'End', ''],
  PageUp: [33, 'PageUp', ''], PageDown: [34, 'PageDown', ''], Space: [32, 'Space', ' '],
};
const EDIT_CMDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

async function pressKey(tabId, spec) {
  const parts = spec === '+' ? ['+'] : spec.split('+');
  let key = parts.pop();
  let mods = 0;
  for (const m of parts) {
    const k = m.toLowerCase();
    if (k === 'alt') mods |= 1;
    else if (k === 'ctrl' || k === 'control') mods |= 2;
    else if (k === 'meta' || k === 'cmd' || k === 'win') mods |= 4;
    else if (k === 'shift') mods |= 8;
    else throw new Error('unknown modifier ' + m);
  }
  if (key === ' ') key = 'Space';
  const name = Object.keys(KEYS).find(k => k.toLowerCase() === key.toLowerCase());
  let vk, code, text, keyName = key;
  if (name) { [vk, code, text] = KEYS[name]; keyName = name === 'Space' ? ' ' : name; }
  else if (key.length === 1) {
    vk = key.toUpperCase().charCodeAt(0);
    code = /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : '';
    text = key;
  } else throw new Error('unknown key ' + key);
  if (mods & 7) text = '';
  const commands = (mods & 2) && EDIT_CMDS[key.toLowerCase()] ? [EDIT_CMDS[key.toLowerCase()]] : undefined;
  const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, commands });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function mouse(tabId, type, x, y, extra = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
}

async function clickAt(tabId, x, y, { button = 'left', count = 1 } = {}) {
  await mouse(tabId, 'mouseMoved', x, y);
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, 'mousePressed', x, y, { button, clickCount: i, buttons: button === 'left' ? 1 : 2 });
    await mouse(tabId, 'mouseReleased', x, y, { button, clickCount: i, buttons: 0 });
  }
}

async function locate(tabId, p) {
  if (p.x != null && p.y != null && !p.ref && !p.selector) return { x: Number(p.x), y: Number(p.y) };
  if (!p.ref && !p.selector) throw new Error('need ref, selector, or x+y');
  const r = await inPage(tabId, prepFn, [p.ref || null, p.selector || null]);
  if (!r || r.error) throw new Error((r && r.error) || 'could not locate element');
  await sleep(80); // let smooth scroll / layout settle
  const r2 = await inPage(tabId, prepFn, [p.ref || null, p.selector || null]);
  return r2 && !r2.error ? r2 : r;
}

// ---------------------------------------------------------------- reddit (JSON endpoints, uses your logged-in session)

function redditUrl(p) {
  const enc = encodeURIComponent;
  let t = String(p.target || '').trim();
  const q = new URLSearchParams({ raw_json: '1' });
  if (p.limit) q.set('limit', String(p.limit));
  if (p.after) q.set('after', p.after);
  if (p.t) q.set('t', p.t);

  let path;
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    path = u.pathname;
    if (!p.sort && u.searchParams.get('sort')) q.set('sort', u.searchParams.get('sort'));
  } else if (/^\/?r\/[^/]+/i.test(t) || /^\/?(u|user)\/[^/]+/i.test(t)) {
    path = '/' + t.replace(/^\//, '');
  } else if (/^[A-Za-z0-9_]{2,21}$/.test(t)) {
    path = '/r/' + t; // bare subreddit name
  } else if (t === '' || t === 'home' || t === 'front') {
    path = '/';
  } else {
    throw new Error('cannot understand reddit target: ' + t);
  }
  path = path.replace(/\/+$/, '').replace(/\.json$/, '').replace(/^\/u\//i, '/user/');
  const isThread = /\/comments\//i.test(path);
  const isUser = /^\/user\//i.test(path);
  // Reddit 403s /hot.json, /new.json and /rising.json for browsers but allows /r/x.json (= hot),
  // /r/x/top.json and /r/x/controversial.json. new/rising are read from old.reddit.com HTML instead
  // (see redditCommand).
  if (p.sort && (isThread || isUser)) q.set('sort', p.sort);
  else if (p.sort && /^(top|controversial)$/.test(p.sort) && !/\/(hot|new|top|rising|controversial|best)$/i.test(path)) path += '/' + p.sort;
  if (isThread && p.depth) q.set('depth', String(p.depth));
  if (isThread && !q.has('limit')) q.set('limit', '500');
  return `https://www.reddit.com${path || '/'}.json?${q}`; // front page is /.json
}

async function redditFetchJson(url) {
  // 1) straight from the service worker, with the browser's reddit cookies
  let r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } }).catch(() => null);
  if (r && r.ok) return r.json();
  if (r && r.status === 429) throw new Error('reddit rate limit (429); wait a minute and retry');
  // 2) fall back to running the fetch inside a real old.reddit.com page (same-origin, looks like normal browsing)
  const u = new URL(url);
  const res = await withOldTab(tabId => inPage(tabId, async path => {
    const x = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!x.ok) return { status: x.status };
    return { json: await x.json() };
  }, [u.pathname + u.search], 'MAIN'));
  if (!res || !res.json) throw new Error(`reddit returned HTTP ${res ? res.status : '?'} (${r ? r.status : 'network error'} from the extension). Log in to reddit in this Chrome, or check the URL.`);
  return res.json;
}

// Run fn(tabId) inside an old.reddit.com page. Requests must come from a real HTML page: from a
// robots.txt tab Reddit answers 403. Reuses an open old.reddit tab, otherwise opens a background one.
async function withOldTab(fn) {
  const tabs = await chrome.tabs.query({ url: 'https://old.reddit.com/*' });
  let tab = tabs[0], created = false;
  if (!tab) { tab = await chrome.tabs.create({ url: 'https://old.reddit.com/', active: false }); created = true; await waitLoad(tab.id, 20000); }
  try { return await fn(tab.id); } finally { if (created) chrome.tabs.remove(tab.id).catch(() => {}); }
}

const clipText = (s, n) => { s = (s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function normPost(d) {
  return {
    id: d.id, fullname: d.name, title: d.title, subreddit: d.subreddit_name_prefixed || ('r/' + d.subreddit),
    author: d.author, score: d.score, upvoteRatio: d.upvote_ratio, comments: d.num_comments,
    created: d.created_utc, flair: d.link_flair_text || null, nsfw: !!d.over_18, stickied: !!d.stickied,
    locked: !!d.locked, domain: d.domain, url: d.is_self ? null : d.url_overridden_by_dest || d.url,
    permalink: 'https://www.reddit.com' + d.permalink, isSelf: !!d.is_self,
    selftext: d.selftext || '', crosspostOf: d.crosspost_parent_list && d.crosspost_parent_list[0] ? d.crosspost_parent_list[0].subreddit_name_prefixed : null,
    gallery: d.is_gallery ? Object.keys(d.media_metadata || {}).length : 0,
    removed: d.removed_by_category || null,
  };
}

function flattenComments(children, out, maxComments, stats) {
  for (const c of children || []) {
    if (out.length >= maxComments) { stats.cut = true; return; }
    if (c.kind === 't1') {
      const d = c.data;
      out.push({ id: d.id, depth: d.depth, author: d.author, score: d.score, created: d.created_utc, body: d.body, op: !!d.is_submitter, stickied: !!d.stickied, distinguished: d.distinguished || null, edited: !!d.edited });
      if (d.replies && d.replies.data) flattenComments(d.replies.data.children, out, maxComments, stats);
    } else if (c.kind === 'more') {
      stats.more += c.data.count || 0;
    }
  }
}

// Reddit's search.json is blocked for browsers, so read the server-rendered old.reddit.com search page instead.
function oldSearchFn(path) {
  return fetch(path, { credentials: 'include' }).then(async r => {
    if (!r.ok) return { status: r.status };
    const d = new DOMParser().parseFromString(await r.text(), 'text/html');
    const num = s => { const m = (s || '').replace(/,/g, '').match(/\d+/); return m ? Number(m[0]) : 0; };
    const items = [...d.querySelectorAll('.search-result-link')].map(e => {
      const a = e.querySelector('a.search-title');
      const t = e.querySelector('.search-time time');
      const href = a ? a.getAttribute('href') : '';
      const m = href.match(/\/comments\/([^/]+)/);
      return {
        type: 'post', id: m ? m[1] : '', title: a ? a.textContent.trim() : '',
        subreddit: (e.querySelector('.search-subreddit-link') || {}).textContent || '',
        author: ((e.querySelector('.search-author a.author') || e.querySelector('.search-author') || {}).textContent || '').replace(/^by\s+/, '').trim(),
        score: num((e.querySelector('.search-score') || {}).textContent),
        comments: num((e.querySelector('.search-comments') || {}).textContent),
        created: t ? Date.parse(t.getAttribute('datetime')) / 1000 : 0,
        flair: (e.querySelector('.linkflairlabel') || {}).textContent || null,
        permalink: href.replace('old.reddit.com', 'www.reddit.com'),
        isSelf: true, domain: '', selftext: ((e.querySelector('.search-result-body') || {}).textContent || '').trim(),
      };
    });
    const next = d.querySelector('.nav-buttons a[rel~=next]');
    let after = null;
    if (next) { try { after = new URL(next.href).searchParams.get('after'); } catch { /* none */ } }
    return { items, after };
  });
}

async function redditSearch(p) {
  const q = new URLSearchParams({ q: p.search });
  const sub = p.sub ? p.sub.replace(/^\/?r\//i, '') : '';
  if (sub) q.set('restrict_sr', 'on');
  q.set('sort', p.sort || 'relevance');
  if (p.t) q.set('t', p.t);
  if (p.after) q.set('after', p.after);
  if (p.limit) q.set('limit', String(Math.min(100, Number(p.limit))));
  const path = `${sub ? '/r/' + encodeURIComponent(sub) : ''}/search?${q}`;
  const res = await withOldTab(tabId => inPage(tabId, oldSearchFn, [path], 'MAIN'));
  if (!res || res.status) throw new Error(`reddit search returned HTTP ${res ? res.status : '?'}`);
  return { kind: 'listing', items: res.items, after: res.after, source: 'old.reddit.com' + path };
}

// Subreddit/home/user listings from old.reddit.com HTML (used for new/rising and when the JSON endpoint 403s).
function oldListFn(path) {
  return fetch(path, { credentials: 'include' }).then(async r => {
    if (!r.ok) return { status: r.status };
    const d = new DOMParser().parseFromString(await r.text(), 'text/html');
    const items = [...d.querySelectorAll('div.thing.link')].map(e => {
      const a = e.querySelector('a.title');
      const domain = e.getAttribute('data-domain') || '';
      return {
        type: 'post', id: (e.getAttribute('data-fullname') || '').replace(/^t3_/, ''), fullname: e.getAttribute('data-fullname'),
        title: a ? a.textContent.trim() : '', subreddit: 'r/' + (e.getAttribute('data-subreddit') || ''),
        author: e.getAttribute('data-author') || '[deleted]', score: Number(e.getAttribute('data-score')) || 0,
        comments: Number(e.getAttribute('data-comments-count')) || 0, created: Number(e.getAttribute('data-timestamp')) / 1000,
        flair: (e.querySelector('.linkflairlabel') || {}).textContent || null,
        nsfw: e.getAttribute('data-nsfw') === 'true', stickied: e.classList.contains('stickied'),
        domain, isSelf: domain.startsWith('self.'),
        permalink: 'https://www.reddit.com' + e.getAttribute('data-permalink'),
        url: domain.startsWith('self.') ? null : e.getAttribute('data-url'), selftext: '',
      };
    });
    const next = d.querySelector('.nav-buttons .next-button a');
    let after = null;
    if (next) { try { after = new URL(next.href).searchParams.get('after'); } catch { /* none */ } }
    return { items, after };
  });
}

async function redditOldListing(p, jsonUrl) {
  const u = new URL(jsonUrl);
  let path = u.pathname.replace(/\.json$/, '').replace(/\/+$/, '');
  if (p.sort && /^(hot|new|top|rising|controversial)$/.test(p.sort) && !/\/(hot|new|top|rising|controversial|best)$/i.test(path)) path += '/' + p.sort;
  const q = new URLSearchParams();
  for (const k of ['limit', 'after', 't']) if (u.searchParams.get(k)) q.set(k, u.searchParams.get(k));
  const full = `${path || ''}/${q.toString() ? '?' + q : ''}`;
  const res = await withOldTab(tabId => inPage(tabId, oldListFn, [full], 'MAIN'));
  if (!res || res.status) throw new Error(`reddit returned HTTP ${res ? res.status : '?'} for ${full}`);
  return { kind: 'listing', items: res.items, after: res.after, source: 'old.reddit.com' + full };
}

async function redditCommand(p) {
  if (p.search) return redditSearch(p);
  const url = redditUrl(p);
  const isThread = /\/comments\//i.test(url);
  let json = null;
  if (isThread || !(p.sort === 'new' || p.sort === 'rising' || /\/(new|rising)\.json/.test(url))) {
    try { json = await redditFetchJson(url); }
    catch (e) { if (isThread || /rate limit/.test(e.message)) throw e; /* listing blocked: use old.reddit HTML below */ }
  }
  if (!json) return redditOldListing(p, url);
  if (Array.isArray(json) && json.length === 2) { // comments page
    const post = normPost(json[0].data.children[0].data);
    const comments = [], stats = { more: 0, cut: false };
    flattenComments(json[1].data.children, comments, Number(p.maxComments) || 200, stats);
    return { kind: 'thread', post, comments, moreHidden: stats.more, truncated: stats.cut, source: url };
  }
  if (json.kind === 'Listing') {
    const items = json.data.children.map(c => {
      if (c.kind === 't3') return { type: 'post', ...normPost(c.data) };
      if (c.kind === 't1') { const d = c.data; return { type: 'comment', id: d.id, author: d.author, score: d.score, created: d.created_utc, subreddit: d.subreddit_name_prefixed, postTitle: d.link_title, body: d.body, permalink: 'https://www.reddit.com' + d.permalink }; }
      if (c.kind === 't5') { const d = c.data; return { type: 'subreddit', name: d.display_name_prefixed, subscribers: d.subscribers, description: clipText(d.public_description, 200) }; }
      return { type: c.kind };
    });
    return { kind: 'listing', items, after: json.data.after, source: url };
  }
  throw new Error('unexpected reddit response shape');
}

// ---------------------------------------------------------------- commands

const commands = {
  reddit: redditCommand,
  // Reload this extension from disk (picks up edited files). Reply first, then restart.
  async extreload() { setTimeout(() => chrome.runtime.reload(), 300); return 'reloading'; },

  async ping() { return 'pong'; },

  // ---- tabs
  async tabs() {
    const cur = await getCurrent();
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, current: t.id === cur, title: t.title, url: t.url, audible: !!t.audible }));
  },
  async new(p) {
    const t = await chrome.tabs.create({ url: p.url || 'about:blank', active: p.active !== false });
    await setCurrent(t.id);
    if (p.url && p.wait !== false) await waitLoad(t.id);
    return { tabId: t.id };
  },
  async close(p) {
    const tabId = await tabOf(p);
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },
  async activate(p) {
    const tabId = Number(p.tabId);
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    await setCurrent(tabId);
    return { tabId };
  },
  async use(p) { await setCurrent(Number(p.tabId)); return { current: Number(p.tabId) }; },

  async go(p) {
    if (!p.url) throw new Error('url required');
    const tabId = await tabOf(p);
    await setCurrent(tabId);
    const w = p.wait === false ? null : waitLoad(tabId);
    await chrome.tabs.update(tabId, { url: p.url });
    if (w) await w;
    const t = await chrome.tabs.get(tabId);
    return { tabId, url: t.url, title: t.title };
  },
  async back(p) { const tabId = await tabOf(p); const w = waitLoad(tabId, 10000); await chrome.tabs.goBack(tabId); await w; return { tabId }; },
  async forward(p) { const tabId = await tabOf(p); const w = waitLoad(tabId, 10000); await chrome.tabs.goForward(tabId); await w; return { tabId }; },
  async reload(p) { const tabId = await tabOf(p); const w = waitLoad(tabId); await chrome.tabs.reload(tabId); await w; return { tabId }; },

  // ---- reading
  async snap(p) {
    const tabId = await tabOf(p);
    const r = await inPage(tabId, snapshotFn, [{ limit: p.limit }]);
    return { tabId, ...r };
  },
  async text(p) {
    const tabId = await tabOf(p);
    const r = await inPage(tabId, textFn, [p.selector || null, p.max || 200000]);
    if (r.error) throw new Error(r.error);
    return { tabId, ...r };
  },
  async eval(p) {
    const tabId = await dbg(p);
    const r = await cdp(tabId, 'Runtime.evaluate', {
      expression: p.js, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value !== undefined ? r.result.value : (r.result.description || r.result.type);
  },
  async screenshot(p) {
    const tabId = await dbg(p);
    const params = { format: p.format === 'jpeg' ? 'jpeg' : 'png', captureBeyondViewport: !!p.full, fromSurface: true };
    if (params.format === 'jpeg') params.quality = p.quality || 80;
    const r = await cdp(tabId, 'Page.captureScreenshot', params);
    return { tabId, format: params.format, base64: r.data };
  },
  async console(p) {
    const tabId = await dbg(p);
    const b = buf(tabId);
    const out = b.console.slice(-(p.limit || 100));
    if (p.clear) b.console.length = 0;
    return out;
  },
  async network(p) {
    const tabId = await dbg(p);
    const b = buf(tabId);
    let items = [...b.network.values()];
    if (p.filter) items = items.filter(i => i.url.includes(p.filter));
    if (p.clear) b.network.clear();
    return items.slice(-(p.limit || 100));
  },
  async body(p) {
    const tabId = await dbg(p);
    const r = await cdp(tabId, 'Network.getResponseBody', { requestId: p.requestId });
    return r;
  },

  // ---- acting (trusted input events via CDP)
  async click(p) {
    const tabId = await dbg(p);
    const pos = await locate(tabId, p);
    await clickAt(tabId, pos.x, pos.y, { button: p.button || 'left', count: p.double ? 2 : 1 });
    return { clicked: { x: pos.x, y: pos.y } };
  },
  async hover(p) {
    const tabId = await dbg(p);
    const pos = await locate(tabId, p);
    await mouse(tabId, 'mouseMoved', pos.x, pos.y);
    return { hovered: { x: pos.x, y: pos.y } };
  },
  async type(p) {
    const tabId = await dbg(p);
    if (p.ref || p.selector) {
      const f = await inPage(tabId, focusFn, [p.ref || null, p.selector || null, !!p.clear]);
      if (f.error) throw new Error(f.error);
    } else if (p.clear) {
      await pressKey(tabId, 'ctrl+a');
    }
    if (p.text) await cdp(tabId, 'Input.insertText', { text: String(p.text) });
    if (p.enter) await pressKey(tabId, 'Enter');
    return { typed: String(p.text || '').length };
  },
  async key(p) {
    const tabId = await dbg(p);
    for (const k of String(p.key).split(/\s+/).filter(Boolean)) await pressKey(tabId, k);
    return { pressed: p.key };
  },
  async scroll(p) {
    const tabId = await dbg(p);
    const js = p.to === 'top' ? 'window.scrollTo(0,0)'
      : p.to === 'bottom' ? 'window.scrollTo(0,document.documentElement.scrollHeight)'
      : `window.scrollBy(${Number(p.dx) || 0},${Number(p.dy) || 0})`;
    await cdp(tabId, 'Runtime.evaluate', { expression: js });
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: 'Math.round(scrollY)', returnByValue: true });
    return { scrollY: r.result.value };
  },
  async select(p) {
    // choose an <option> by visible text or value
    const tabId = await dbg(p);
    const r = await inPage(tabId, (ref, selector, want) => {
      const el = ref ? (window.__cc && window.__cc.map.get(ref)) : document.querySelector(selector);
      if (!el || el.tagName !== 'SELECT') return { error: 'not a <select>' };
      const o = [...el.options].find(x => x.text.trim() === want || x.value === want);
      if (!o) return { error: 'no option ' + want };
      el.value = o.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: o.text };
    }, [p.ref || null, p.selector || null, String(p.value)]);
    if (r.error) throw new Error(r.error);
    return r;
  },
  async upload(p) {
    const tabId = await dbg(p);
    const ev = await cdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(p.selector)})` });
    if (!ev.result.objectId) throw new Error('no element matches ' + p.selector);
    await cdp(tabId, 'DOM.setFileInputFiles', { objectId: ev.result.objectId, files: p.files });
    return { uploaded: p.files.length };
  },
  async dialog(p) {
    const tabId = await tabOf(p);
    await attach(tabId);
    const d = dialogs.get(tabId);
    if (p.status) return d || null;
    if (!d) throw new Error('no dialog open');
    await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: p.accept !== false, promptText: p.text });
    return { handled: d };
  },
  async wait(p) {
    const tabId = await dbg(p);
    const deadline = Date.now() + (p.timeout || 15000);
    if (!p.selector && !p.text) { await sleep(p.ms || 1000); return { waited: p.ms || 1000 }; }
    const expr = p.selector
      ? `!!document.querySelector(${JSON.stringify(p.selector)})`
      : `document.body && document.body.innerText.includes(${JSON.stringify(p.text)})`;
    while (Date.now() < deadline) {
      const r = await cdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result.value) return { found: true };
      await sleep(250);
    }
    throw new Error('timed out waiting for ' + (p.selector || p.text));
  },

  // ---- escape hatches
  async cdp(p) {
    const tabId = await dbg(p);
    return await cdp(tabId, p.cdpMethod, p.cdpParams || {});
  },
  async detach(p) {
    const tabId = await tabOf(p);
    if (attached.has(tabId)) { await chrome.debugger.detach({ tabId }); attached.delete(tabId); }
    return { detached: tabId };
  },
};

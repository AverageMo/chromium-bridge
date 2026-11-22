const $ = id => document.getElementById(id);

async function render() {
  const { port = 9333, token = '', status = 'starting', allowActions = false } = await chrome.storage.local.get(['port', 'token', 'status', 'allowActions']);
  $('port').value = port;
  $('token').placeholder = token ? '(saved — paste to replace)' : 'paste contents of token.txt';
  $('status').textContent = status;
  $('status').className = status === 'connected' ? 'ok' : 'bad';
  $('allow').checked = allowActions === true;
  $('modebox').className = allowActions === true ? 'on' : '';
  $('modenote').textContent = allowActions === true
    ? 'ON: scripts can click, type and run code in your pages, as you, in every site you are logged in to (posting, buying, deleting...). Turn this off when you are done.'
    : 'Off (read-only): scripts can read pages and Reddit but cannot click, type or run code in your pages.';
}

$('save').onclick = async () => {
  const patch = { port: Number($('port').value) || 9333 };
  const t = $('token').value.trim();
  if (t) patch.token = t;
  await chrome.storage.local.set(patch);
  $('token').value = '';
  chrome.runtime.sendMessage({ type: 'kick' }).catch(() => {});
  setTimeout(render, 600);
};

$('allow').onchange = async () => {
  if ($('allow').checked && !confirm('Let scripts click, type and run code in your logged-in pages? They could post, buy or delete things as you.')) {
    $('allow').checked = false;
    return;
  }
  await chrome.storage.local.set({ allowActions: $('allow').checked });
};

chrome.storage.onChanged.addListener(render);
render();

const $ = id => document.getElementById(id);

async function render() {
  const { port = 9333, token = '', status = 'starting' } = await chrome.storage.local.get(['port', 'token', 'status']);
  $('port').value = port;
  $('token').placeholder = token ? '(saved — paste to replace)' : 'paste contents of token.txt';
  $('status').textContent = status;
  $('status').className = status === 'connected' ? 'ok' : 'bad';
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

chrome.storage.onChanged.addListener(render);
render();

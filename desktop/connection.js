const bridge = window.ogbDesktop
const zh = navigator.language.toLowerCase().startsWith('zh')
const text = zh ? {
  title: '\u8fde\u63a5\u529e\u516c\u5ba4', status: '\u5df2\u9009\u8fdc\u7a0b\u529e\u516c\u5ba4\uff0c\u8bf7\u767b\u5f55\u540e\u7ee7\u7eed\u3002',
  url: '\u529e\u516c\u5ba4\u7f51\u5740', token: '\u8bbf\u95ee\u4ee4\u724c', hint: '\u586b\u5199\u5f53\u524d\u8bbf\u95ee\u4ee4\u724c\uff0c\u4ec5\u7528\u4e8e\u672c\u6b21\u767b\u5f55\u3002',
  connect: '\u8fde\u63a5', local: '\u6253\u5f00\u672c\u5730\u529e\u516c\u5ba4', connecting: '\u8fde\u63a5\u4e2d\u2026',
} : {
  title: 'Connect to office', status: 'Remote office selected. Sign in to continue.', url: 'Office URL', token: 'Access token',
  hint: 'Enter the current office access token. It is used for this sign-in only.', connect: 'Connect', local: 'Open local office', connecting: 'Connecting…',
}
const el = (id) => document.getElementById(id)
for (const [key, id] of [['title', 'title'], ['status', 'status'], ['url', 'url-label'], ['token', 'token-label'], ['hint', 'hint'], ['connect', 'connect'], ['local', 'local']]) el(id).textContent = text[key]
function showError(message) { el('error').textContent = message; el('error').hidden = !message }
function busy(value) { el('connect').disabled = value; el('local').disabled = value; el('connect').textContent = value ? text.connecting : text.connect }
bridge.getConnection().then((state) => {
  el('url').value = state.remoteUrl || ''
  if (state.error) showError(state.error)
}).catch((err) => showError(err.message))
el('form').addEventListener('submit', (event) => {
  event.preventDefault()
  busy(true); showError('')
  const url = el('url').value
  const token = el('token').value
  bridge.connectRemote(url, token).catch((err) => showError(err.message)).finally(() => { el('token').value = ''; busy(false) })
})
el('local').addEventListener('click', () => {
  busy(true); showError('')
  bridge.disconnectRemote().catch((err) => showError(err.message)).finally(() => busy(false))
})

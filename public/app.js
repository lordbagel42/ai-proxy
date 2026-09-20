const $ = (id) => document.getElementById(id);
let profile;
let chatgptState;
let chatgptPollTimer;
let chatgptCountdownTimer;
let chatgptController;
let chatgptVersion = 0;
const invitationStorageKey = 'friends.invitation';
let invitationToken = '';
let invitationStorageAvailable = true;
function isInvitationPage() { return /^\/invite\/?$/.test(location.pathname); }
if (isInvitationPage()) {
  const incoming = location.hash.slice(1);
  if (incoming) {
    invitationToken = incoming;
    try { sessionStorage.setItem(invitationStorageKey, incoming); } catch { invitationStorageAvailable = false; }
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { invitationToken = sessionStorage.getItem(invitationStorageKey) || ''; } catch { invitationStorageAvailable = false; }
  }
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `Request failed (${response.status})`), { status: response.status });
  return data;
}
async function refreshModels() {
  try { const catalog = await api('/api/models'); if (profile) profile.modelCatalogError = ''; $('models').textContent = catalog.data.map((m) => m.id).join(', ') || 'No models available.'; }
  catch (error) { if (profile) profile.modelCatalogError = error.message; $('models').textContent = error.message; }
  if (chatgptState && !chatgptState.pending) renderChatgpt(chatgptState);
}
async function busy(button, work) {
  button.disabled = true; notice('');
  try { await work(); } catch (error) { notice(error.message); } finally { button.disabled = false; }
}
async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); const old = button.textContent; button.textContent = 'Copied ✓'; setTimeout(() => button.textContent = old, 1800); }
  catch { notice('Clipboard access is unavailable. Select and copy the text instead.'); }
}
function stopChatgptUpdates() {
  chatgptVersion++;
  clearTimeout(chatgptPollTimer); clearInterval(chatgptCountdownTimer);
  chatgptController?.abort(); chatgptController = undefined;
}
function chatgptMessage(message) {
  $('chatgpt-message').textContent = message; $('chatgpt-message').hidden = !message;
}
function updateChatgptCountdown() {
  if (!chatgptState?.pending) return false;
  const seconds = Math.max(0, Math.ceil((chatgptState.pending.expiresAt - Date.now()) / 1000));
  if (!seconds) {
    renderChatgpt({ ...chatgptState, pending: null });
    chatgptMessage('This sign-in expired. Generate a new sign-in link or device code.');
    return false;
  }
  const browser = chatgptState.pending.kind === 'browser';
  $(browser ? 'chatgpt-browser-countdown' : 'chatgpt-countdown').textContent = `${browser ? 'Sign-in link' : 'Code'} expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return true;
}
function scheduleChatgptUpdates() {
  if (!profile?.isOwner || document.hidden || !chatgptState?.pending || !updateChatgptCountdown()) return;
  const interval = Math.max(1, chatgptState.pending.intervalSeconds) * 1000;
  chatgptCountdownTimer = setInterval(updateChatgptCountdown, 1000);
  if (chatgptState.pending.kind !== 'browser') chatgptPollTimer = setTimeout(() => void updateChatgpt('/api/admin/codex/poll', 'POST'), interval);
}
function renderChatgpt(state) {
  stopChatgptUpdates();
  const previous = chatgptState?.pending;
  chatgptState = state;
  $('chatgpt').hidden = !profile?.isOwner;
  if (!profile?.isOwner) return;
  const pending = state.pending;
  const browser = pending?.kind === 'browser';
  if (!browser || previous?.authorizationUrl !== pending.authorizationUrl) $('chatgpt-callback').value = '';
  const unavailable = state.connected && !state.needsReconnect && Boolean(profile.modelCatalogError);
  $('chatgpt-status').textContent = unavailable ? 'Upstream unavailable' : state.needsReconnect ? 'Sign-in needed' : state.connected ? 'Connected' : 'Not connected';
  $('chatgpt-status').classList.toggle('is-connected', state.connected && !state.needsReconnect && !unavailable);
  $('chatgpt-description').textContent = pending
    ? 'Finish signing in to connect your ChatGPT account.'
    : unavailable ? `ChatGPT is signed in. ${profile.modelCatalogError}`
    : state.needsReconnect ? 'Sign in again to keep your circle connected.'
    : state.connected ? 'Your circle can use your available Codex models with their own keys.'
    : 'Connect your ChatGPT account to enable your Codex models for your circle.';
  $('chatgpt-connect').textContent = pending ? 'Generate a new sign-in link ↗' : 'Generate sign-in link ↗';
  $('chatgpt-connect').hidden = false;
  for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect']) $(id).disabled = false;
  $('chatgpt-disconnect').hidden = !state.connected;
  $('chatgpt-pending').hidden = !pending || browser;
  $('chatgpt-browser').hidden = !browser;
  if (browser) {
    const url = new URL(pending.authorizationUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('The server returned an unexpected ChatGPT sign-in link.');
    $('chatgpt-browser-link').href = url.href;
  } else $('chatgpt-browser-link').removeAttribute('href');
  $('chatgpt-code').textContent = pending?.userCode || '';
  chatgptMessage('');
  scheduleChatgptUpdates();
}
async function updateChatgpt(path = '/api/admin/codex', method = 'GET', body) {
  stopChatgptUpdates();
  if (!profile?.isOwner || document.hidden) return;
  const version = chatgptVersion;
  chatgptController = new AbortController();
  for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect']) $(id).disabled = true;
  chatgptMessage('');
  try {
    const result = await api(path, method, body, chatgptController.signal);
    if (version !== chatgptVersion) return;
    renderChatgpt(result || { connected: false, expiresAt: null, needsReconnect: false, pending: null });
    if (method !== 'GET' && !result?.pending) void refreshModels();
    if (method === 'DELETE') chatgptMessage('ChatGPT disconnected. You can connect again whenever you’re ready.');
  } catch (error) {
    if (version !== chatgptVersion || error.name === 'AbortError') return;
    for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect']) $(id).disabled = false;
    chatgptMessage(error.status === 401 ? 'Your session ended. Sign in again to manage this connection.' : error.message);
    if (error.status !== 401 && error.status !== 403) scheduleChatgptUpdates();
  }
}
function showInvitation(session, accessError) {
  stopChatgptUpdates();
  $('invitation').hidden = false; $('login').hidden = true; $('dashboard').hidden = true;
  const validToken = /^inv_[a-f0-9]{64}$/.test(invitationToken);
  const hasAccess = session?.hasAccess;
  $('signout').hidden = !session; $('admin-link').hidden = !session?.isOwner || !hasAccess;
  $('invitation-session').hidden = !session;
  $('invitation-name').textContent = session?.user.name || '';
  $('invitation-email').textContent = session?.user.email || '';
  $('invitation-signin').hidden = Boolean(session) || !validToken;
  $('invitation-accept').hidden = !session || hasAccess || !validToken;
  $('invitation-portal').hidden = !hasAccess;
  $('invitation-switch').hidden = !session;
  $('invitation-error').textContent = accessError || '';
  $('invitation-error').hidden = !accessError;
  $('invitation-description').textContent = hasAccess ? 'You’re already part of this circle. Your keys and tools are ready in your personal portal.'
    : !validToken ? 'Open the private invitation link from the owner to join this circle.'
    : session ? 'Your invitation is ready. Accept it to join the circle and create your own access keys.'
    : 'You’ve been invited to join a small circle. Sign in with Hack Club, then accept your invitation.';
  $('invitation-hint').textContent = invitationStorageAvailable ? 'One invitation. Your own keys. Room to make.' : 'After signing in, reopen your original invitation link to continue. Your browser could not save it for this sign-in.';
}
async function refreshInvitation() {
  try { showInvitation(await api('/api/session')); }
  catch (error) { if (error.status === 401) showInvitation(null); else { showInvitation(null); notice(error.message); } }
  finally { $('loading').hidden = true; }
}
async function refresh() {
  if (isInvitationPage()) { await refreshInvitation(); return; }
  try {
    profile = await api('/api/me');
    $('login').hidden = true; $('invitation').hidden = true; $('dashboard').hidden = false; $('signout').hidden = false; $('admin-link').hidden = !profile.isOwner;
    window.FriendsAnalytics?.mount();
    $('user-name').textContent = profile.user.name; $('user-email').textContent = profile.user.email;
    $('usage').textContent = new Intl.NumberFormat().format(profile.usage.requestsToday);
    $('models').textContent = profile.modelCatalogError || profile.models.map((m) => m.id).join(', ') || 'No models available.';
    $('base-url').textContent = profile.baseUrl;
    $('cli-example').textContent = `npm install @lordbagel42/ai-proxy@0.1.0\n\nnpx ai-proxy login \\\n  --url ${new URL(profile.baseUrl).origin}\n\nnpx ai-proxy codex`;
    $('key-count').textContent = `${profile.keys.length} ACTIVE`;
    $('keys').replaceChildren();
    if (!profile.keys.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No keys yet. Create one above, or connect your CLI.'; $('keys').append(empty); }
    for (const key of profile.keys) {
      const row = document.createElement('div'); row.className = 'key-row';
      const details = document.createElement('div'); const name = document.createElement('strong'); name.textContent = key.name;
      const meta = document.createElement('p'); meta.textContent = `${key.key_prefix}… · expires ${new Date(key.expires_at).toLocaleDateString()}`;
      details.append(name, meta);
      const revoke = document.createElement('button'); revoke.className = 'quiet'; revoke.textContent = 'Revoke'; revoke.setAttribute('aria-label', `Revoke ${key.name}`);
      revoke.addEventListener('click', () => busy(revoke, async () => { await api(`/api/keys/${encodeURIComponent(key.id)}`, 'DELETE'); await refresh(); notice('Key revoked.'); }));
      row.append(details, revoke); $('keys').append(row);
    }
    if (location.pathname === '/connect') {
      $('connect').hidden = false;
      if (!$('user-code').value) $('user-code').value = new URLSearchParams(location.search).get('code') || '';
    }
    $('chatgpt').hidden = !profile.isOwner;
    if (profile.isOwner) {
      if (!chatgptState) { $('chatgpt-status').textContent = 'Checking connection…'; $('chatgpt-connect').disabled = true; }
      await updateChatgpt();
    } else { stopChatgptUpdates(); chatgptState = undefined; }
  } catch (error) {
    stopChatgptUpdates(); chatgptState = undefined; profile = undefined;
    $('dashboard').hidden = true; $('login').hidden = false; $('signout').hidden = true; $('chatgpt').hidden = true; $('admin-link').hidden = true;
    if (error.status === 403) {
      try { showInvitation(await api('/api/session'), error.message); }
      catch { notice(error.message); }
    } else if (error.status !== 401) notice(error.message);
  } finally { $('loading').hidden = true; }
}
async function signIn(button) { return busy(button, async () => {
  const result = await api('/api/auth/sign-in/social', 'POST', { provider: 'hackclub', callbackURL: location.pathname + location.search, errorCallbackURL: isInvitationPage() ? '/invite' : '/' });
  if (!result.url) throw new Error('Hack Club did not return a sign-in URL.');
  location.assign(result.url);
}); }
$('signin').addEventListener('click', () => void signIn($('signin')));
$('invitation-signin').addEventListener('click', () => void signIn($('invitation-signin')));
$('invitation-accept').addEventListener('click', () => void busy($('invitation-accept'), async () => {
  $('invitation-error').hidden = true;
  try {
    await api('/api/invites/accept', 'POST', { token: invitationToken });
    invitationToken = ''; try { sessionStorage.removeItem(invitationStorageKey); } catch {}
    history.replaceState(null, '', '/'); await refresh(); notice('You’re in. Welcome to the circle. Create your first key below.');
  } catch (error) { $('invitation-error').textContent = error.message; $('invitation-error').hidden = false; }
}));
$('invitation-switch').addEventListener('click', () => void busy($('invitation-switch'), async () => {
  await api('/api/auth/sign-out', 'POST', {}); await refresh();
}));
$('signout').addEventListener('click', () => busy($('signout'), async () => {
  stopChatgptUpdates();
  try { await api('/api/auth/sign-out', 'POST', {}); location.assign(isInvitationPage() ? '/invite' : '/'); }
  catch (error) { void updateChatgpt(); throw error; }
}));
$('chatgpt-connect').addEventListener('click', () => void updateChatgpt('/api/admin/codex/browser/start', 'POST'));
$('chatgpt-device').addEventListener('click', () => void updateChatgpt('/api/admin/codex/start', 'POST'));
$('chatgpt-browser-form').addEventListener('submit', (event) => {
  event.preventDefault(); const callbackUrl = $('chatgpt-callback').value.trim(); $('chatgpt-callback').value = '';
  void updateChatgpt('/api/admin/codex/browser/complete', 'POST', { callbackUrl });
});
$('chatgpt-disconnect').addEventListener('click', () => void updateChatgpt('/api/admin/codex', 'DELETE'));
$('chatgpt-copy').addEventListener('click', () => copy($('chatgpt-code').textContent, $('chatgpt-copy')));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopChatgptUpdates();
  else if (profile?.isOwner) void updateChatgpt();
});
window.addEventListener('pagehide', () => { stopChatgptUpdates(); $('chatgpt-callback').value = ''; });
$('key-form').addEventListener('submit', (event) => {
  event.preventDefault(); const button = event.submitter;
  void busy(button, async () => {
    const result = await api('/api/keys', 'POST', { name: $('key-name').value });
    $('key-value').textContent = result.key; $('new-key').hidden = false; $('key-name').value = ''; await refresh();
  });
});
$('copy-key').addEventListener('click', () => copy($('key-value').textContent, $('copy-key')));
$('copy-url').addEventListener('click', () => copy(profile.baseUrl, $('copy-url')));
$('dismiss-key').addEventListener('click', () => { $('key-value').textContent = ''; $('new-key').hidden = true; });
$('approve-form').addEventListener('submit', (event) => {
  event.preventDefault(); void busy(event.submitter, async () => {
    await api('/api/cli/approve', 'POST', { user_code: $('user-code').value });
    $('connect').hidden = true; history.replaceState(null, '', '/'); await refresh(); notice('Terminal connected. You can return to your CLI.');
  });
});
if (new URLSearchParams(location.search).has('error')) notice('Sign-in didn’t finish. Try again with your Hack Club account.');
void refresh();

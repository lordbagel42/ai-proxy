const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat();
const state = { profile: null, data: null, memberId: null, inviteFilter: 'pending', connection: null, busyConfirm: false, busyInvite: false };
let connectionVersion = 0;
let connectionController;
let connectionPoll;
let connectionCountdown;
let confirmWork;
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function message(id, text, error = false) { $(id).textContent = text; $(id).hidden = !text; $(id).classList.toggle('error', error); }
function notice(text, error = false) { message('notice', text, error); }
function date(value) { return value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function initials(value) { return (value || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
function memberName(member) { return member.name || member.label || member.identityId; }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, credentials: 'same-origin', signal, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let result;
  if (response.status !== 204) {
    try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  }
  if (!response.ok) throw Object.assign(new Error(result?.error?.message || result?.message || `Request failed (${response.status}).`), { status: response.status });
  return result;
}
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const before = button.textContent; button.textContent = 'Copied ✓';
    setTimeout(() => { button.textContent = before; }, 1800);
  } catch { notice('Clipboard access is unavailable. Select the link or code and copy it manually.', true); }
}
function badge(status, owner = false) { return node('span', `badge ${owner ? 'owner' : status}`, owner ? 'Owner' : status.charAt(0).toUpperCase() + status.slice(1)); }
function view(name, updateLocation = true) {
  const selected = ['overview', 'members', 'invitations', 'connection'].includes(name) ? name : 'overview';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${selected}`;
  for (const link of document.querySelectorAll('.sidebar [data-view]')) {
    if (link.dataset.view === selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('breadcrumb-current').textContent = selected.charAt(0).toUpperCase() + selected.slice(1);
  document.title = `${$('breadcrumb-current').textContent} / Friends`;
  if (updateLocation) history.replaceState(null, '', `/admin#${selected}`);
}
function showGate(title, description, kind) {
  stopConnection();
  $('gate').hidden = false; $('admin-content').hidden = true;
  $('gate-title').textContent = title; $('gate-description').textContent = description;
  $('admin-signin').hidden = kind !== 'signin'; $('gate-back').hidden = kind !== 'access'; $('retry-load').hidden = kind !== 'retry';
}
function personCell(member) {
  const person = node('div', 'table-person');
  const avatar = node('span', 'avatar', initials(memberName(member)));
  const details = node('div'); const name = node('strong', '', memberName(member));
  if (member.isOwner) name.append(node('span', 'role-label', 'YOU'));
  details.append(name, node('small', '', member.email || member.identityId));
  person.append(avatar, details); return person;
}
function renderMembers() {
  const query = $('member-search').value.trim().toLowerCase();
  const filter = $('member-filter').value;
  const members = state.data.members.filter((member) => (filter === 'all' || member.status === filter) && [member.name, member.label, member.email, member.identityId].some((value) => value?.toLowerCase().includes(query)));
  $('members-table').replaceChildren();
  for (const member of members) {
    const row = node('tr');
    const person = node('td'); person.append(personCell(member));
    const status = node('td'); status.append(badge(member.status, member.isOwner));
    const usage = node('td', 'usage-cell', number.format(member.requestsToday));
    const keys = node('td', '', number.format(member.activeKeys));
    const actions = node('td'); const manage = node('button', 'text-link', 'Manage ↗'); manage.dataset.memberId = member.identityId; manage.setAttribute('aria-label', `Manage ${memberName(member)}`); actions.append(manage);
    row.append(person, status, usage, keys, actions); $('members-table').append(row);
  }
  $('members-empty').hidden = members.length > 0;
  $('members-result-count').textContent = `${number.format(members.length)} of ${number.format(state.data.members.length)} members`;
}
function inviteStatus(invite) { return invite.status === 'pending' && invite.expiresAt <= Date.now() ? 'expired' : invite.status; }
function renderInvites() {
  const invites = state.data.invites.filter((invite) => state.inviteFilter === 'pending' ? inviteStatus(invite) === 'pending' : inviteStatus(invite) !== 'pending');
  $('invites-table').replaceChildren();
  for (const invite of [...invites].sort((a, b) => b.createdAt - a.createdAt)) {
    const row = node('tr'); const label = node('td');
    label.append(node('strong', 'invite-label', invite.label));
    if (invite.acceptedBy) label.append(node('small', 'invite-meta', `Accepted by ${invite.acceptedBy}`));
    else if (invite.targetIdentity) label.append(node('small', 'invite-meta', `For ${invite.targetIdentity}`));
    else label.append(node('small', 'invite-meta', 'Anyone with this private link'));
    const status = node('td'); const current = inviteStatus(invite); status.append(badge(current === 'pending' ? 'active' : current)); if (current === 'pending') status.firstChild.textContent = 'Open';
    const created = node('td', 'date-cell', date(invite.createdAt)); created.title = new Date(invite.createdAt).toLocaleString();
    const expiry = node('td', 'date-cell', date(invite.expiresAt)); expiry.title = new Date(invite.expiresAt).toLocaleString();
    const actions = node('td');
    if (current === 'pending') { const revoke = node('button', 'text-link danger', 'Revoke'); revoke.dataset.inviteId = invite.id; revoke.setAttribute('aria-label', `Revoke ${invite.label}`); actions.append(revoke); }
    row.append(label, status, created, expiry, actions); $('invites-table').append(row);
  }
  $('invites-empty').hidden = invites.length > 0;
  $('invites-empty-title').textContent = state.inviteFilter === 'pending' ? 'There’s room for one more.' : 'A fresh start.';
  $('invites-empty-description').textContent = state.inviteFilter === 'pending' ? 'Create a link and share it with someone you’d like to invite.' : 'Accepted, expired, and revoked invitations will appear here.';
  $('invites-empty').querySelector('button').hidden = state.inviteFilter !== 'pending';
  $('invites-result-count').textContent = `${number.format(invites.length)} ${state.inviteFilter === 'pending' ? 'open' : 'past'} invitation${invites.length === 1 ? '' : 's'}`;
}
function renderOverview() {
  const { summary, members } = state.data;
  $('stat-members').textContent = number.format(summary.activeMembers);
  $('stat-members-detail').textContent = summary.suspendedMembers ? `${number.format(summary.suspendedMembers)} suspended member${summary.suspendedMembers === 1 ? '' : 's'}` : 'Including you, the owner';
  $('stat-requests').textContent = number.format(summary.requestsToday);
  $('stat-keys').textContent = number.format(summary.activeKeys);
  $('stat-invites').textContent = number.format(summary.pendingInvites);
  $('nav-members').textContent = number.format(members.length);
  $('nav-invites').textContent = summary.pendingInvites ? number.format(summary.pendingInvites) : '';
  $('members-preview').replaceChildren();
  for (const member of members.slice(0, 5)) {
    const row = node('div', 'preview-person'); const detail = node('div', 'person-copy');
    detail.append(node('strong', '', memberName(member)), node('small', '', member.email || 'Hasn’t signed in yet'));
    row.append(node('span', 'avatar', initials(memberName(member))), detail, badge(member.status, member.isOwner));
    $('members-preview').append(row);
  }
  if (!members.length) { const empty = node('div', 'empty-state'); empty.append(node('h3', '', 'Your circle starts here.'), node('p', '', 'Invite a friend to make something together.')); $('members-preview').append(empty); }
  $('last-updated').textContent = `UPDATED ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  renderMembers(); renderInvites();
}
async function refreshData() { state.data = await api('/api/admin/overview'); renderOverview(); }
async function refreshAfterChange(success) {
  try { await refreshData(); notice(success); } catch (error) { notice(`${success} Refreshing the dashboard failed: ${error.message}`, true); }
}
function renderModels(models, defaultModel, error) {
  state.modelCatalogError = error || '';
  $('provider-models').replaceChildren();
  for (const model of models) {
    const item = node('code', '', model.id);
    if (model.id === defaultModel) { item.title = 'Default model'; item.append(node('span', 'fine', ' · default')); }
    $('provider-models').append(item);
  }
  if (error || !models.length) $('provider-models').append(node('span', 'fine', error || 'No models available. Connect ChatGPT to load your catalog.'));
  if (state.connection && !state.connection.pending) renderConnection(state.connection);
}
async function refreshModels() {
  try { const catalog = await api('/api/models'); renderModels(catalog.data, catalog.default_model); }
  catch (error) { renderModels([], null, error.message); }
}
async function load() {
  showGate('Opening your circle.', 'Checking your access…');
  try {
    const session = await api('/api/session'); $('signout').hidden = false;
    if (!session.isOwner || !session.hasAccess) { showGate('This space is for the owner.', 'Your personal keys and tools are waiting in the member portal.', 'access'); return; }
    const [profile, data] = await Promise.all([api('/api/me'), api('/api/admin/overview')]);
    state.profile = profile; state.data = data;
    $('owner-name').textContent = profile.user.name; $('owner-avatar').textContent = initials(profile.user.name);
    renderModels(profile.models, profile.defaultModel, profile.modelCatalogError);
    renderOverview(); view(location.hash.slice(1), false);
    $('gate').hidden = true; $('admin-content').hidden = false;
    window.FriendsAnalytics?.mount();
    void updateConnection();
  } catch (error) {
    if (error.status === 401) showGate('Welcome back.', 'Sign in with your Hack Club account to manage your circle.', 'signin');
    else if (error.status === 403) showGate('This space is for the owner.', error.message, 'access');
    else showGate('A little interruption.', error.message, 'retry');
  }
}
function openInvite() {
  if (state.busyInvite) return;
  $('invite-form').reset(); $('invite-form').hidden = false; $('invite-result').hidden = true;
  $('invite-link').value = ''; $('invite-dialog').querySelector('details').open = false; message('invite-error', '');
  $('invite-dialog').showModal(); $('invite-label').focus();
}
function renderMember(member) {
  $('member-dialog-title').textContent = memberName(member); $('member-avatar').textContent = initials(memberName(member));
  $('member-email').textContent = member.email || 'Hasn’t signed in yet'; $('member-identity').textContent = member.identityId;
  $('member-status').textContent = member.isOwner ? 'Owner' : member.status === 'active' ? 'Active' : 'Suspended'; $('member-status').className = `badge ${member.status}`;
  $('member-today').textContent = number.format(member.requestsToday); $('member-key-count').textContent = number.format(member.activeKeys);
  $('member-access-actions').hidden = member.isOwner;
  $('member-access-description').textContent = member.status === 'active' ? 'Suspending access pauses their keys and sessions. Restore access to enable them again.' : 'Access is paused. Restoring this member enables their existing keys and sessions.';
  $('member-toggle').textContent = member.status === 'active' ? 'Suspend access' : 'Restore access';
  $('member-revoke').disabled = member.activeKeys === 0;
}
function openMember(identity) {
  const member = state.data.members.find((item) => item.identityId === identity);
  if (!member) return; state.memberId = identity; renderMember(member); $('member-dialog').showModal();
}
function currentMember() { return state.data?.members.find((member) => member.identityId === state.memberId); }
function confirmAction(title, description, label, action) {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-accept').textContent = label;
  message('confirm-error', ''); confirmWork = action; $('confirm-dialog').showModal(); $('confirm-cancel').focus();
}
function stopConnection() {
  connectionVersion++; clearTimeout(connectionPoll); clearInterval(connectionCountdown); connectionController?.abort(); connectionController = undefined;
}
function countDown() {
  const pending = state.connection?.pending; if (!pending) return false;
  const seconds = Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000));
  if (!seconds) { renderConnection({ ...state.connection, pending: null }); message('chatgpt-message', 'This sign-in expired. Generate a new sign-in link or device code.'); return false; }
  const browser = pending.kind === 'browser';
  $(browser ? 'chatgpt-browser-countdown' : 'chatgpt-countdown').textContent = `${browser ? 'Sign-in link' : 'Code'} expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; return true;
}
function scheduleConnection() {
  if (document.hidden || !state.profile?.isOwner || !state.connection?.pending || !countDown()) return;
  connectionCountdown = setInterval(countDown, 1000);
  if (state.connection.pending.kind !== 'browser') connectionPoll = setTimeout(() => void updateConnection('/api/admin/codex/poll', 'POST'), Math.max(1, state.connection.pending.intervalSeconds) * 1000);
}
function renderConnection(result) {
  stopConnection();
  const previous = state.connection?.pending;
  state.connection = result;
  const browser = result.pending?.kind === 'browser';
  if (!browser || previous?.authorizationUrl !== result.pending.authorizationUrl) $('chatgpt-callback').value = '';
  const connected = result.connected && !result.needsReconnect;
  const unavailable = connected && Boolean(state.modelCatalogError);
  const status = unavailable ? 'Upstream unavailable' : result.needsReconnect ? 'Sign-in needed' : result.connected ? 'Connected' : 'Not connected';
  $('chatgpt-status').textContent = status; $('chatgpt-status').className = `badge ${connected && !unavailable ? 'active' : ''}`;
  $('overview-connection-status').textContent = status; $('overview-connection-status').className = `badge inverted ${connected && !unavailable ? 'active' : ''}`;
  const description = result.pending ? 'Finish signing in to connect your ChatGPT account.' : unavailable ? `ChatGPT is signed in. ${state.modelCatalogError}` : result.needsReconnect ? 'Sign in again to keep your circle connected.' : connected ? 'Your account is connected. Your circle can use their own keys to access Codex.' : 'Connect your ChatGPT account to make Codex available to your circle.';
  $('chatgpt-description').textContent = description; $('connection-summary').textContent = description;
  $('chatgpt-connect').textContent = result.pending ? 'Generate a new sign-in link ↗' : 'Generate sign-in link ↗';
  $('chatgpt-connect').hidden = false; $('chatgpt-disconnect').hidden = !result.connected;
  for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect', 'connection-refresh']) $(id).disabled = false;
  $('chatgpt-pending').hidden = !result.pending || browser; $('chatgpt-code').textContent = result.pending?.userCode || '';
  $('chatgpt-browser').hidden = !browser;
  if (browser) {
    const url = new URL(result.pending.authorizationUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('The server returned an unexpected ChatGPT sign-in link.');
    $('chatgpt-browser-link').href = url.href;
  } else $('chatgpt-browser-link').removeAttribute('href');
  message('chatgpt-message', ''); scheduleConnection();
}
async function updateConnection(path = '/api/admin/codex', method = 'GET', body) {
  stopConnection(); if (document.hidden || !state.profile?.isOwner) return;
  const version = connectionVersion; connectionController = new AbortController();
  for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect', 'connection-refresh']) $(id).disabled = true;
  message('chatgpt-message', '');
  try {
    const result = await api(path, method, body, connectionController.signal);
    if (version !== connectionVersion) return;
    renderConnection(result || { connected: false, pending: null, needsReconnect: false, expiresAt: null });
    if (!result?.pending) void refreshModels();
  } catch (error) {
    if (version !== connectionVersion || error.name === 'AbortError') return;
    for (const id of ['chatgpt-connect', 'chatgpt-device', 'chatgpt-browser-complete', 'chatgpt-disconnect', 'connection-refresh']) $(id).disabled = false;
    message('chatgpt-message', error.message, true);
    if (error.status !== 401 && error.status !== 403) scheduleConnection();
    if (!state.connection) { $('overview-connection-status').textContent = 'Unavailable'; $('chatgpt-status').textContent = 'Unavailable'; $('connection-summary').textContent = 'Connection status could not be loaded. Open connection settings to try again.'; }
  }
}
for (const link of document.querySelectorAll('[data-view]')) link.addEventListener('click', (event) => { event.preventDefault(); view(link.dataset.view); });
window.addEventListener('hashchange', () => view(location.hash.slice(1), false));
for (const button of document.querySelectorAll('[data-create-invite]')) button.addEventListener('click', openInvite);
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => {
  if (button.dataset.closeDialog === 'invite-dialog' && state.busyInvite) return;
  $(button.dataset.closeDialog).close();
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if ((event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) && !(dialog.id === 'confirm-dialog' && state.busyConfirm) && !(dialog.id === 'invite-dialog' && state.busyInvite)) dialog.close();
});
$('invite-dialog').addEventListener('close', () => { $('invite-link').value = ''; });
$('invite-dialog').addEventListener('cancel', (event) => { if (state.busyInvite) event.preventDefault(); });
$('member-dialog').addEventListener('close', () => { state.memberId = null; });
$('member-search').addEventListener('input', renderMembers); $('member-filter').addEventListener('change', renderMembers);
$('members-table').addEventListener('click', (event) => { const button = event.target.closest('[data-member-id]'); if (button) openMember(button.dataset.memberId); });
for (const button of document.querySelectorAll('[data-invite-filter]')) button.addEventListener('click', () => {
  state.inviteFilter = button.dataset.inviteFilter;
  for (const choice of document.querySelectorAll('[data-invite-filter]')) choice.setAttribute('aria-pressed', String(choice === button));
  renderInvites();
});
$('invites-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-invite-id]'); if (!button) return;
  const invite = state.data.invites.find((item) => item.id === button.dataset.inviteId); if (!invite) return;
  confirmAction('Close this invitation?', `The link for “${invite.label}” will stop working. You can create a new invitation whenever you like.`, 'Revoke invitation', async () => {
    await api(`/api/admin/invites/${encodeURIComponent(invite.id)}`, 'DELETE'); await refreshAfterChange('Invitation revoked.');
  });
});
$('invite-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busyInvite) return;
  state.busyInvite = true; const button = $('create-invite-submit'); button.disabled = true; message('invite-error', '');
  for (const close of document.querySelectorAll('[data-close-dialog="invite-dialog"]')) close.disabled = true;
  try {
    const body = { label: $('invite-label').value.trim() };
    if ($('invite-identity').value.trim()) body.targetIdentity = $('invite-identity').value.trim();
    const result = await api('/api/admin/invites', 'POST', body);
    const url = new URL(result.url); if (url.origin !== location.origin || url.pathname !== '/invite') throw new Error('The server returned an unexpected invitation link.');
    $('invite-form').hidden = true; $('invite-result').hidden = false; $('invite-link').value = url.href;
    $('invite-expiry').textContent = `Expires ${new Date(result.invite.expiresAt).toLocaleString()} · one use`;
    $('copy-invite').focus(); await refreshAfterChange('Invitation created. Copy its private link before closing.');
  } catch (error) { message('invite-error', error.message, true); }
  finally {
    state.busyInvite = false; button.disabled = false;
    for (const close of document.querySelectorAll('[data-close-dialog="invite-dialog"]')) close.disabled = false;
  }
});
$('copy-invite').addEventListener('click', () => void copy($('invite-link').value, $('copy-invite')));
$('member-toggle').addEventListener('click', () => {
  const member = currentMember(); if (!member || member.isOwner) return;
  const suspend = member.status === 'active';
  confirmAction(suspend ? 'Pause their access?' : 'Welcome them back?', suspend ? `${memberName(member)} won’t be able to use their keys or portal while suspended. Their existing keys will work again when you restore access.` : `Restore ${memberName(member)}’s access to their portal and existing keys.`, suspend ? 'Suspend access' : 'Restore access', async () => {
    await api(`/api/admin/members/${encodeURIComponent(member.identityId)}`, 'PATCH', { status: suspend ? 'suspended' : 'active' });
    await refreshAfterChange(`${memberName(member)}’s access ${suspend ? 'suspended' : 'restored'}.`);
    const updated = currentMember(); if (updated) renderMember(updated);
  });
});
$('member-revoke').addEventListener('click', () => {
  const member = currentMember(); if (!member) return;
  confirmAction('Revoke every key?', `All ${number.format(member.activeKeys)} active keys for ${memberName(member)} will stop working permanently. They’ll need to create new keys or reconnect their terminal.`, 'Revoke all keys', async () => {
    await api(`/api/admin/members/${encodeURIComponent(member.identityId)}/keys`, 'DELETE');
    await refreshAfterChange(`All keys revoked for ${memberName(member)}.`);
    const updated = currentMember(); if (updated) renderMember(updated);
  });
});
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-dialog').addEventListener('cancel', (event) => { if (state.busyConfirm) event.preventDefault(); });
$('confirm-accept').addEventListener('click', async () => {
  if (!confirmWork || state.busyConfirm) return;
  state.busyConfirm = true; $('confirm-accept').disabled = true; $('confirm-cancel').disabled = true; message('confirm-error', '');
  try { await confirmWork(); $('confirm-dialog').close(); }
  catch (error) { message('confirm-error', error.message, true); }
  finally { state.busyConfirm = false; $('confirm-accept').disabled = false; $('confirm-cancel').disabled = false; }
});
$('chatgpt-connect').addEventListener('click', () => void updateConnection('/api/admin/codex/browser/start', 'POST'));
$('chatgpt-device').addEventListener('click', () => void updateConnection('/api/admin/codex/start', 'POST'));
$('chatgpt-browser-form').addEventListener('submit', (event) => {
  event.preventDefault(); const callbackUrl = $('chatgpt-callback').value.trim(); $('chatgpt-callback').value = '';
  void updateConnection('/api/admin/codex/browser/complete', 'POST', { callbackUrl });
});
$('chatgpt-copy').addEventListener('click', () => void copy($('chatgpt-code').textContent, $('chatgpt-copy')));
$('connection-refresh').addEventListener('click', () => void updateConnection());
$('chatgpt-disconnect').addEventListener('click', () => confirmAction('Disconnect ChatGPT?', 'Your circle’s new Codex requests will stop until you connect an account again. Requests already running may finish.', 'Disconnect account', async () => {
  stopConnection(); await api('/api/admin/codex', 'DELETE'); renderConnection({ connected: false, pending: null, expiresAt: null, needsReconnect: false }); void refreshModels(); notice('ChatGPT disconnected.');
}));
$('admin-signin').addEventListener('click', async () => {
  $('admin-signin').disabled = true;
  try { const result = await api('/api/auth/sign-in/social', 'POST', { provider: 'hackclub', callbackURL: '/admin', errorCallbackURL: '/admin' }); if (!result.url) throw new Error('Hack Club did not return a sign-in URL.'); location.assign(result.url); }
  catch (error) { notice(error.message, true); $('admin-signin').disabled = false; }
});
$('signout').addEventListener('click', async () => {
  stopConnection(); $('signout').disabled = true;
  try { await api('/api/auth/sign-out', 'POST', {}); location.assign('/'); }
  catch (error) { notice(error.message, true); $('signout').disabled = false; void updateConnection(); }
});
$('retry-load').addEventListener('click', () => void load());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopConnection();
  else if (state.profile?.isOwner) { void updateConnection(); void refreshData().catch((error) => notice(error.message, true)); }
});
window.addEventListener('pagehide', () => { stopConnection(); $('chatgpt-callback').value = ''; });
void load();

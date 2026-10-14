'use strict';
const $ = selector => document.querySelector(selector);
let csrf, pageVersion = 0, noticeTimer;
const titles = { overview: 'Your control room', connections: 'Connected accounts', projects: 'Projects & keys', requests: 'Request history', settings: 'Workspace settings', activity: 'Activity & recovery' };
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child != null)); return node;
}
function notify(message) { clearTimeout(noticeTimer); $('#notice').textContent = message; $('#notice').hidden = false; noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 9000); }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) signedOut(); throw new Error(value.error?.message ?? `Request failed (${response.status})`); }
  return value;
}
function action(label, run, style = 'secondary') { return el('button', { type: 'button', class: style, onclick: async event => { const button = event.currentTarget; button.disabled = true; try { await run(); } catch (error) { notify(error.message); } finally { button.disabled = false; } } }, label); }
const pretty = value => el('pre', {}, JSON.stringify(value, null, 2));
const card = (...children) => el('section', { class: 'card' }, ...children);
const heading = text => el('h2', {}, text);
const muted = text => el('p', { class: 'muted' }, text);
const row = (...children) => el('div', { class: 'row' }, ...children);
function modal(title, ...children) { if (!csrf) return; $('#detail-title').textContent = title; $('#detail-content').replaceChildren(...children); if (!$('#detail').open) $('#detail').showModal(); }
function field(label, input) { input.setAttribute('aria-label', label); return el('label', {}, label, input); }
function input(value = '', attrs = {}) { const node = el('input', attrs); node.value = value; return node; }
function editor(value) { const node = el('textarea', { rows: '14', spellcheck: 'false' }); node.value = JSON.stringify(value, null, 2); return node; }
function table(headers, rows) { return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...headers.map(h => el('th', {}, h)))), el('tbody', {}, ...rows.map(cells => el('tr', {}, ...cells.map(c => el('td', {}, c))))))); }
function download(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = el('a', { href: url, download: name }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function signedOut() { csrf = undefined; pageVersion++; $('#shell').hidden = true; $('#login').hidden = false; $('#content').replaceChildren(); $('#detail').close(); $('#detail-content').replaceChildren(); $('#operator-key').focus(); }
async function signIn() { $('#login').hidden = true; $('#shell').hidden = false; await render(); }
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); const key = $('#operator-key').value; $('#operator-key').value = ''; try { const result = await api('/web/session', 'POST', { key }); csrf = result.csrf; await signIn(); } catch (error) { notify(error.message); } });
$('#logout').addEventListener('click', async () => { try { await api('/web/session', 'DELETE'); signedOut(); } catch (error) { notify(error.message); } });
$('#close-detail').addEventListener('click', () => { $('#detail').close(); $('#detail-content').replaceChildren(); });
$('#detail').addEventListener('close', () => $('#detail-content').replaceChildren());
$('#refresh').addEventListener('click', () => render());
window.addEventListener('hashchange', () => { $('#detail').close(); if (csrf) render(); });
async function render() {
  const version = ++pageVersion, page = location.hash.slice(1) in titles ? location.hash.slice(1) : 'overview';
  $('#title').textContent = titles[page]; $('#section-label').textContent = page.toUpperCase();
  document.querySelectorAll('nav a').forEach(link => { if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#content').replaceChildren(muted('Loading workspace…'));
  try { const content = await pages[page](); if (version === pageVersion && csrf) $('#content').replaceChildren(...content); }
  catch (error) { if (version === pageVersion && csrf) $('#content').replaceChildren(card(heading('Unable to load this view'), muted(error.message), action('Try again', render))); notify(error.message); }
}
async function editProject(project, routes) {
  const id = input(project?.id ?? '', { required: '', placeholder: 'my-application', pattern: '[A-Za-z0-9_-]{1,64}' }); if (project) id.disabled = true;
  const route = el('select', { multiple: '', size: String(Math.min(5, Math.max(2, routes.length))) }, ...routes.map(r => { const option = el('option', { value: r.id }, `${r.id} · ${r.profile}`); option.selected = project?.policy.routes.includes(r.id) ?? false; return option; }));
  const concurrency = input(project?.policy.concurrency ?? 4, { type: 'number', min: '1', required: '' });
  const tokens = input(project?.policy.daily_tokens ?? 1000000, { type: 'number', min: '1', required: '' });
  const requests = input(project?.policy.daily_requests ?? 1000, { type: 'number', min: '1', required: '' });
  const advanced = editor(project?.policy ?? { routes: [] });
  const details = el('details', {}, el('summary', {}, 'Advanced policy (JSON)'), muted('Advanced fields are preserved; route selection and limits above override the matching JSON fields.'), field('Policy', advanced));
  const form = el('form', {}, field('Project ID', id), field('Authorized routes (select one or more)', route), el('div', { class: 'grid' }, field('Concurrent requests', concurrency), field('Daily request limit', requests), field('Daily token estimate limit', tokens)), details, el('button', {}, 'Save project'));
  form.addEventListener('submit', async event => { event.preventDefault(); try { await api(`/admin/projects/${encodeURIComponent(id.value)}`, 'PUT', { ...JSON.parse(advanced.value), routes: [...route.selectedOptions].map(o => o.value), concurrency: Number(concurrency.value), daily_requests: Number(requests.value), daily_tokens: Number(tokens.value) }); $('#detail').close(); notify('Project policy saved'); await render(); } catch (error) { notify(error.message); } });
  modal(project ? 'Edit project' : 'Create a project', form);
}
async function editRoute(route, snapshot) {
  const id = input(route?.id ?? '', { required: '', pattern: '[A-Za-z0-9_-]{1,64}', placeholder: 'personal' }); if (route) id.disabled = true;
  const profile = el('select', {}, ...[['codex', 'Codex account'], ['chatgpt', 'ChatGPT plan · public Responses'], ['api_key', 'Provider API key']].map(([value, name]) => el('option', { value }, name))); profile.value = route?.profile ?? 'codex';
  const base = input(route?.base_url ?? 'http://backend:8317/v1', { required: '', type: 'url' });
  const models = input(route?.models.join(', ') ?? '', { required: '', placeholder: 'Model IDs, separated by commas' });
  const key = input(route?.key_env ?? 'ROUTER4U_BACKEND_KEY', { required: '' });
  const management = input(route?.management_key_env ?? 'ROUTER4U_BACKEND_MANAGEMENT_KEY');
  const protocols = el('select', {}, el('option', { value: 'responses' }, 'Responses'), el('option', { value: 'responses,chat' }, 'Responses and Chat Completions')); protocols.value = route?.protocols.join(',') ?? 'responses';
  const form = el('form', {}, muted('Connect to an existing backend. Provider credentials stay in CLIProxyAPI; the fields below reference environment variables already configured on Router4u.'), field('Route ID', id), field('Authentication profile', profile), field('Backend base URL', base), field('Allowed model IDs', models), field('Client protocols', protocols), field('Backend key environment variable', key), field('Management key environment variable', management), el('button', {}, 'Save route'));
  form.addEventListener('submit', async event => { event.preventDefault(); try {
    const { revision, ...config } = snapshot.config;
    const next = { ...route, id: id.value, profile: profile.value, base_url: base.value, models: models.value.split(',').map(s => s.trim()).filter(Boolean), protocols: protocols.value.split(','), key_env: key.value };
    if (management.value.trim()) next.management_key_env = management.value.trim(); else delete next.management_key_env;
    config.routes = route ? config.routes.map(r => r.id === route.id ? next : r) : [...config.routes, next];
    await api('/admin/config', 'PUT', { revision: snapshot.revision, config }); $('#detail').close(); notify('Route saved'); await render();
  } catch (error) { notify(error.message); } });
  modal(route ? 'Edit route' : 'Add a backend route', form);
}
const pages = {
  async overview() {
    const [metrics, projects, config, status, alerts] = await Promise.all(['/admin/metrics', '/admin/projects', '/admin/config', '/admin/web-status', '/admin/alerts'].map(path => api(path)));
    const stats = [['Requests', metrics.requests], ['Settled tokens', metrics.settled_tokens], ['Active requests', metrics.active ?? 0], ['Projects', projects.length]];
    return [el('div', { class: 'grid stats' }, ...stats.map(([label, value]) => card(el('span', { class: 'muted' }, label), el('div', { class: 'stat' }, Number(value).toLocaleString())))),
      card(row(heading('Admissions'), el('span', { class: 'badge' }, status.paused ? 'Paused' : 'Accepting requests')), muted('Pause new work while you maintain accounts. Existing work continues until completed or cancelled.'), action(status.paused ? 'Resume admissions' : 'Pause admissions', async () => { await api('/admin/pause', 'POST', { paused: !status.paused }); await render(); })),
      card(heading('Make yourself at home'), el('div', { class: 'steps' }, ...[['connections', 'Connect an account', `${config.config.routes.length} configured routes. Inspect authentication and available models.`], ['projects', 'Give your application a key', 'Choose its routes and limits, then copy a project key.'], ['requests', 'Follow your first request', 'See what completed, what was recorded, and what remains uncertain.']].map(([page, title, text]) => el('div', { class: 'step' }, el('div', {}, el('a', { href: `#${page}` }, title), muted(text)))))),
      card(heading('Needs attention'), alerts.length ? table(['Alert', 'Details'], alerts.map(item => [item.kind, JSON.stringify(item)])) : muted('No local operational alerts. Provider reachability has not been verified.')),
      muted('Usage is request-only. Unknown provider consumption is retained separately; local token estimates are not provider quota.')];
  },
  async connections() {
    const [snapshot, accounts] = await Promise.all([api('/admin/config'), api('/admin/accounts')]);
    const { config } = snapshot;
    return [el('div', { class: 'warning' }, 'Personal use only. Connect only accounts you own and use them yourself. You are responsible for complying with each provider’s terms and plan restrictions. Technical support does not grant permission to share account access.'),
      card(heading('Upstream connections'), muted('CLIProxyAPI owns sign-in, credential storage, and token refresh. Routes select an existing backend connection.'), action('Add route', () => editRoute(null, snapshot), 'primary')),
      el('div', { class: 'grid' }, ...config.routes.map(route => card(row(heading(route.id), el('span', { class: 'badge' }, route.profile)), muted(route.models.join(' · ')), row(
        action('Edit route', () => editRoute(route, snapshot)),
        action('Inspect', async () => modal(`${route.id} · Connection`, pretty(await api(`/admin/backends/${route.id}/inspect`)))),
        action('Models', async () => modal(`${route.id} · Models`, pretty(await api(`/admin/backends/${route.id}/models`)))),
        action('Credentials', async () => modal(`${route.id} · Credentials`, pretty(await api(`/admin/backends/${route.id}/credentials`)))),
        ...(route.management_key_env ? [action('Connect Codex', async () => {
          const result = await api(`/admin/backends/${route.id}/login`, 'POST', {});
          const callback = input('', { placeholder: 'http://localhost:1455/auth/callback?…' });
          const authURL = result.url ?? result.auth_url; let link;
          try { const parsed = new URL(authURL); if (parsed.protocol === 'https:') link = el('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' }, 'Open provider sign-in ↗'); } catch {}
          modal('Connect your Codex account', muted('Complete sign-in in a new tab. If the localhost callback does not load, paste the full callback URL below. Do not share it.'), link ?? muted('No valid HTTPS authorization URL was returned.'), field('Callback URL', callback), row(action('Submit callback', async () => { const value = callback.value; callback.value = ''; const response = await api(`/admin/backends/${route.id}/callback`, 'POST', { redirect_url: value }); notify(response.status ?? 'Callback submitted'); }), action('Check status', async () => notify(JSON.stringify(await api(`/admin/backends/${route.id}/status?state=${encodeURIComponent(result.state ?? '')}`))))));
        })] : [])
      ), route.profile === 'chatgpt' ? muted('ChatGPT plan → public Responses API. The pinned backend exposes SIWC binding as a CLI command. Router4u currently requires stopping that backend during binding; this is an integration constraint, not an OAuth requirement. Existing bindings work here.') : null))),
      card(heading('Account registry'), accounts.length ? table(['Account', 'Route', 'State', 'Actions'], accounts.map(account => [account.id, account.route_id, account.status ?? 'Not inspected', row(...['inspect', 'refresh', 'disable', 'enable', 'remove'].map(operation => action(operation, async () => { if (operation === 'remove' && !confirm(`Remove credential for ${account.id}?`)) return; modal(`${account.id} · ${operation}`, pretty(await api(`/admin/accounts/${account.id}/${operation}`, operation === 'inspect' ? 'GET' : 'POST', operation === 'inspect' ? undefined : {}))); })))])) : muted('No accounts registered for exclusive attribution. Add account metadata and an exclusive route in Settings. Credential changes require paused admissions and no active or uncertain work.'))];
  },
  async projects() {
    const [projects, { config }, keys] = await Promise.all([api('/admin/projects'), api('/admin/config'), api('/admin/principals')]);
    return [card(row(heading('Application access'), action('Create project', () => editProject(null, config.routes), 'primary')), muted(`Client base URL: ${location.origin}/v1. Project keys authorize only their configured routes.`)),
      ...projects.map(project => card(row(heading(project.id), el('span', { class: 'badge' }, project.policy.enabled ? 'Enabled' : 'Disabled')), muted(`${project.policy.routes.join(', ')} · ${project.policy.concurrency} concurrent · ${project.policy.daily_requests.toLocaleString()} requests/day`), row(action('Edit policy', () => editProject(project, config.routes)), action('Effective policy', async () => modal(project.id, pretty(await api(`/admin/projects/${project.id}/effective-policy`)))), action('Usage', async () => modal(`${project.id} · Usage`, pretty(await api(`/admin/usage/${project.id}`)))), action('Issue project key', async () => { const result = await api(`/admin/projects/${project.id}/keys`, 'POST', {}); modal('Copy your project key', muted('Shown only once. Store this key securely in your application environment. Exchange export is excluded from default scopes.'), pretty(result)); })),
        table(['Key ID', 'State', ''], keys.filter(key => key.project_id === project.id).map(key => [key.id, key.enabled ? 'Active' : 'Revoked', key.enabled ? action('Revoke', async () => { if (!confirm('Revoke this project key? Applications using it will lose access.')) return; await api(`/admin/principals/${key.id}`, 'DELETE'); await render(); }, 'danger') : '—']))))];
  },
  async requests() {
    const projects = await api('/admin/projects');
    const select = el('select', {}, el('option', { value: '' }, 'Select a project'), ...projects.map(p => el('option', { value: p.id }, p.id)));
    const output = el('div'); let cursor = null;
    async function load(append = false) {
      if (!select.value) { output.replaceChildren(); return; }
      const result = await api(`/admin/projects/${select.value}/history?limit=50${append && cursor ? `&cursor=${cursor}` : ''}`);
      const records = result.items ?? result.requests ?? result;
      const view = table(['Request', 'Model', 'Execution', 'Usage', ''], records.map(record => [record.id, record.model ?? record.requested_model ?? '—', record.execution, record.usage?.total ?? record.tokens ?? 'Unknown', action('Details', async () => {
        const value = await api(`/admin/requests/${record.id}`);
        modal('Request details', row(action('Cancel request', async () => notify(JSON.stringify(await api(`/admin/requests/${record.id}/cancel`, 'POST', {})))), action('Export exchange', async () => { if (!confirm('Download the original exchange? It may contain sensitive prompts and responses.')) return; download(`${record.id}.json`, await api(`/admin/requests/${record.id}/exchange`)); })), pretty(value));
      })]));
      if (!append) output.replaceChildren(); output.append(view); cursor = result.next_cursor;
      more.hidden = !cursor; if (!records.length && !append) output.append(muted('No requests for this project yet.'));
    }
    const more = action('Load more', () => load(true)); more.hidden = true;
    select.addEventListener('change', () => load().catch(error => notify(error.message)));
    return [card(heading('Explore recorded work'), field('Project', select), output, more)];
  },
  async settings() {
    const snapshot = await api('/admin/config'), status = await api('/admin/web-status');
    const { revision, ...config } = snapshot.config;
    const value = editor(config);
    async function save(dryRun) { const result = await api('/admin/config', 'PUT', { revision: snapshot.revision, config: JSON.parse(value.value), dry_run: dryRun }); notify(dryRun ? 'Configuration is valid' : 'Configuration saved and applied'); if (!dryRun) await render(); return result; }
    return [card(heading('Service configuration'), muted(`Active source: ${status.configuration_source}. Browser changes are stored in the data volume and survive restarts. Backend keys remain environment references; never paste tokens here.`),
      el('div', { class: 'warning' }, 'Routes connect to existing CLIProxyAPI instances. Adding a route does not create a backend container or provision environment secrets. Host, port, data directory, operator-key environment name, and maintenance interval require a restart.'),
      field('Configuration JSON', value), row(action('Validate', () => save(true)), action('Save & apply', () => save(false), 'primary'), action('Download configuration', () => download('router4u.json', JSON.parse(value.value))), action('Reload installation file', async () => { if (!confirm('Replace browser configuration with the installation file?')) return; await api('/admin/config/reload', 'POST', {}); await render(); }))),
      card(heading('Storage maintenance'), muted('Retention only removes captures eligible under the saved project policies. Request metadata and ledger remain.'), action('Run retention', async () => modal('Retention result', pretty(await api('/admin/retention/run', 'POST', {})))))];
  },
  async activity() {
    const [audit, occupancy] = await Promise.all([api('/admin/audit'), api('/admin/occupancy')]);
    return [card(heading('Uncertain occupancy'), muted('Release capacity only after checking the upstream outcome. Releasing occupancy does not invent token usage.'), occupancy.length ? table(['Request', 'Details', ''], occupancy.map(item => [item.id, item.occupancy ?? 'uncertain', action('Release capacity', async () => { const reason = prompt('Why is it safe to release this request’s capacity?'); if (!reason) return; await api(`/admin/requests/${item.id}/release-occupancy`, 'POST', { reason }); await render(); })])) : muted('No uncertain occupancy.')),
      card(heading('Audit trail'), muted('First 200 events; use the API sequence cursor for a complete export.'), table(['Sequence', 'Action', 'Actor', 'Target'], audit.map(item => [String(item.sequence), item.operation, item.actor, item.target ?? '—'])))];
  },
};
api('/web/session').then(result => { if (result.authenticated) { csrf = result.csrf; return signIn(); } signedOut(); }).catch(error => { signedOut(); notify(error.message); });

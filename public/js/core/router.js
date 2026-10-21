/*
 * core/router.js — the sidebar and which screen is showing.
 * The menu shows only what the signed in user can use: their units, the
 * signing inbox for signers, My Submissions, My Signature, and Settings
 * for administrators. Badges show what is waiting.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  let _nav, _content, _opts = {}, _current = null, _units = null, _badgeTimer = null;
  const badges = {};

  function deps(extra) {
    const A = window.App;
    return { ui: A.ui, api: A.api, auth: A.auth, permissions: A.permissions, workflow: A.workflow, router: A.router, user: A.auth.current(), offline: _opts.offline, ...extra };
  }

  async function units(force) {
    if (_units && !force) return _units;
    try { _units = (await window.App.api.get('/catalogue/units')).units; }
    catch (e) { _units = _units || []; }
    return _units;
  }
  function unitName(key) { const u = (_units || []).find(x => x.key === key); return u ? u.name : key; }

  function navItem(label, onclick, attrs, badgeKey) {
    const { ui } = deps();
    const badge = badgeKey ? ui.el('span', { class: 'nav-badge', hidden: 'hidden' }, '') : null;
    if (badgeKey) badges[badgeKey] = badge;
    return ui.el('button', { class: 'nav-item', onclick, ...attrs }, [ui.el('span', null, label), badge]);
  }

  async function buildNav() {
    const { ui, permissions, user } = deps();
    ui.clear(_nav);
    const list = await units(true);
    const group = (title) => _nav.appendChild(ui.el('div', { class: 'nav-group' }, title));

    _nav.appendChild(navItem('🏠  Home', loadDashboard, { 'data-nav': 'home' }, 'notifications'));
    if ((user.signerRoles || []).includes('chief_judge')) _nav.appendChild(navItem('⚖  Awaiting Assignment', () => loadModule('assign'), { 'data-nav': 'assign' }, 'assign'));
    if (permissions.isSigner(user)) _nav.appendChild(navItem('✍  Awaiting My Signature', () => loadModule('inbox'), { 'data-nav': 'inbox' }, 'inbox'));
    if (permissions.isAdmin(user) || permissions.can('finalize', user)) {
      _nav.appendChild(navItem('📤  My Submissions', () => loadModule('submissions'), { 'data-nav': 'submissions' }, 'approved'));
    }

    _nav.appendChild(navItem('📁  Case File', () => loadModule('cases'), { 'data-nav': 'cases' }));
    // The court's register books; with more than one court, a choice of court first.
    const courts = list.filter(u => u.type === 'registry');
    if (courts.length) _nav.appendChild(navItem('📒  Case Register', () => loadModule('caseRegister', courts.length === 1 ? { unit: courts[0] } : {}), { 'data-nav': 'caseRegister' }, 'newcases'));
    if (courts.length) _nav.appendChild(navItem('📅  Court Diary', () => loadModule('diary', courts.length === 1 ? { unit: courts[0] } : {}), { 'data-nav': 'diary' }));

    if (permissions.isAdmin(user) || (permissions.can('reports', user) && user.unitKeys.length)) {
      _nav.appendChild(navItem('📊  Reports', () => loadModule('reports'), { 'data-nav': 'reports' }));
    }
    if (permissions.isAdmin(user) || (user.signerRoles || []).includes('chief_judge')) {
      _nav.appendChild(navItem('📈  Court Statistics', () => loadModule('statistics'), { 'data-nav': 'statistics' }));
    }

    if (list.length) group('Units');
    list.forEach(u => _nav.appendChild(navItem(u.name, () => loadUnit(u), { 'data-unit': u.key }, u.type === 'process' ? 'process' : null)));

    group('Account');
    _nav.appendChild(navItem('🔑  My Account', () => loadModule('account'), { 'data-nav': 'account' }));
    _nav.appendChild(navItem('❓  Help', () => window.open('/guide', '_blank', 'noopener'), { 'data-nav': 'help' }));
    if (permissions.isSigner(user)) _nav.appendChild(navItem('🖊  My Signature', () => loadModule('signature'), { 'data-nav': 'signature' }));
    if (permissions.isAdmin(user)) _nav.appendChild(navItem('⚙  Settings', () => loadModule('settings'), { 'data-nav': 'settings' }));

    refreshBadges();
    clearInterval(_badgeTimer);
    _badgeTimer = setInterval(refreshBadges, 60000);
  }

  function setBadge(key, n) {
    const b = badges[key];
    if (!b) return;
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.removeAttribute('hidden'); }
    else b.setAttribute('hidden', 'hidden');
  }

  async function refreshBadges() {
    const { api } = deps();
    try {
      const [stats, notes] = await Promise.all([api.get('/records/stats'), api.get('/notifications?unread=1')]);
      setBadge('inbox', stats.inbox);
      setBadge('approved', stats.approvedUnprinted);
      setBadge('notifications', notes.unread);
      // Cases for the Chief Judge to assign, and filings for the Process Registrar to register.
      let cases = { awaitingAssignment: 0, toRegister: 0, newCases: 0 };
      if (badges.assign || badges.process || badges.newcases) { try { cases = await api.get('/process/counts'); } catch (e) { /* keep zero */ } }
      setBadge('assign', cases.awaitingAssignment);
      setBadge('process', cases.toRegister);
      setBadge('newcases', cases.newCases);
      // Phones: the menu button shows whether anything waits inside the menu.
      const menu = document.getElementById('menu-badge');
      const waiting = stats.inbox + stats.approvedUnprinted + notes.unread + cases.awaitingAssignment + cases.toRegister + (cases.newCases || 0);
      if (menu) { menu.textContent = waiting > 99 ? '99+' : String(waiting); menu.hidden = !waiting; }
    } catch (e) { /* offline: keep the last numbers */ }
  }

  function setActive(sel) {
    _nav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('is-active'));
    const node = sel && _nav.querySelector(sel);
    if (node) node.classList.add('is-active');
  }

  async function show(fn) {
    _current = fn;
    window.App.ui.clear(_content);
    _content.scrollTop = 0;
    try { await fn(); }
    catch (e) {
      console.error(e);
      _content.appendChild(window.App.ui.empty(e.offline ? 'This page is not available offline yet.' : 'Could not load this page: ' + e.message));
    }
  }

  function loadDashboard() {
    setActive('[data-nav="home"]');
    return show(() => window.App.dashboard.render(_content, deps()));
  }

  function loadUnit(unit, initialFormKey) {
    const mod = window.App.modules[unit.type];
    if (!mod) { window.App.ui.toast('Module not found: ' + unit.type, 'error'); return; }
    setActive(`[data-unit="${unit.key}"]`);
    return show(() => mod.render(_content, deps({ unit, initialFormKey })));
  }

  function loadUnitWithForm(unit, formKey) { return loadUnit(unit, formKey); }

  function loadModule(name, extra) {
    const mod = window.App.modules[name];
    if (!mod) { window.App.ui.toast('Module not found: ' + name, 'error'); return; }
    setActive(`[data-nav="${name}"]`);
    return show(() => mod.render(_content, deps(extra)));
  }

  function refresh() { refreshBadges(); if (_current) show(_current); }

  function mount(navEl, contentEl, opts) {
    _nav = navEl; _content = contentEl; _opts = opts || {};
    window.App.workflow.meta().catch(() => {});
    window.App.workflow.onChange(refreshBadges);
    buildNav().then(loadDashboard);
  }

  window.App.router = { mount, buildNav, loadUnit, loadUnitWithForm, loadModule, loadDashboard, refresh, refreshBadges, units, unitName };
})();

/*
 * core/router.js — navigation & module loading
 * Units (the 9 courts, appeals, execution) each have a `type` that maps to
 * a registered module. The router shows only the units a user may access,
 * and hands the chosen unit's config to that module's render().
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};   // modules register here

  let _nav, _content;

  function deps() {
    return { ui: window.App.ui, auth: window.App.auth, permissions: window.App.permissions, db: window.App.db };
  }

  async function buildNav() {
    const { ui, auth, permissions, db } = deps();
    const user = auth.current();
    const units = await db.getAll('units');
    ui.clear(_nav);

    // Home — always first
    _nav.appendChild(ui.el('button', {
      class: 'nav-item', 'data-nav': 'home', onclick: loadDashboard
    }, '\uD83C\uDFE0  Home'));

    // Unit links the user can access
    const accessible = units.filter(u => permissions.canAccessUnit(u.key, user));
    accessible.forEach(u => {
      _nav.appendChild(ui.el('button', {
        class: 'nav-item', 'data-unit': u.key, onclick: () => loadUnit(u)
      }, u.name));
    });

    // Settings is admin-only
    if (permissions.isAdmin(user)) {
      _nav.appendChild(ui.el('button', {
        class: 'nav-item nav-item--settings',
        onclick: () => loadModule('settings', null)
      }, '\u2699  Settings'));
    }

    // Land on dashboard
    loadDashboard();
  }

  function loadDashboard() {
    const { ui, auth, permissions, db } = deps();
    _nav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('is-active'));
    const homeBtn = _nav.querySelector('[data-nav="home"]');
    if (homeBtn) homeBtn.classList.add('is-active');
    ui.clear(_content);
    if (window.App.dashboard) {
      window.App.dashboard.render(_content, { unit: null, user: auth.current(), ui, db, permissions, auth });
    }
  }

  function setActive(node) {
    _nav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('is-active'));
    if (node) node.classList.add('is-active');
  }

  async function loadUnit(unit) {
    const mod = window.App.modules[unit.type];
    if (!mod) { window.App.ui.toast('Module not found: ' + unit.type, 'error'); return; }
    setActive(_nav.querySelector(`[data-unit="${unit.key}"]`));
    await render(mod, unit);
  }

  async function loadUnitWithForm(unit, formKey) {
    const mod = window.App.modules[unit.type];
    if (!mod) return;
    setActive(_nav.querySelector(`[data-unit="${unit.key}"]`));
    const { ui, auth, permissions, db } = deps();
    ui.clear(_content);
    await mod.render(_content, { unit, user: auth.current(), ui, db, permissions, auth, initialFormKey: formKey });
  }

  async function loadModule(name, unit) {
    const mod = window.App.modules[name];
    if (!mod) { window.App.ui.toast('Module not found: ' + name, 'error'); return; }
    setActive(null);
    await render(mod, unit);
  }

  async function render(mod, unit) {
    const { ui, auth, permissions, db } = deps();
    ui.clear(_content);
    await mod.render(_content, { unit, user: auth.current(), ui, db, permissions, auth });
  }

  function mount(navEl, contentEl) {
    _nav = navEl; _content = contentEl;
    buildNav();
  }

  window.App.router = { mount, buildNav, loadUnit, loadUnitWithForm, loadModule, loadDashboard };
})();

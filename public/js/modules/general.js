/*
 * modules/general.js — "Other Unit" (Probate, Accounts, Open Registry ...).
 * It has no forms of its own yet; it uses the forms the administrator picks
 * for it under Settings → Form Access. A unit that later gets its own forms
 * and workflow gets its own module, like registry.js.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.general = {
    id: 'general',
    forms: {},
    render(container, ctx) {
      window.App.recordEngine.render(container, ctx, {
        subtitle: 'Forms chosen for this unit by the administrator',
        forms: {}
      });
    }
  };
})();

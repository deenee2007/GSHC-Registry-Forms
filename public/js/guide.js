// guide.js: print the whole guide, or one role's page only.
document.querySelectorAll('[data-print]').forEach(btn => btn.addEventListener('click', () => {
  const which = btn.getAttribute('data-print');
  document.querySelectorAll('.g-page').forEach(p => p.classList.toggle('g-skip', which !== 'all' && p.id !== which));
  window.print();
}));
window.addEventListener('afterprint', () => document.querySelectorAll('.g-skip').forEach(p => p.classList.remove('g-skip')));

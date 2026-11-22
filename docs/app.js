'use strict';
// Small, calm details only — the page works fully without JS.
(function () {
  const links = document.querySelectorAll('a[href^="#"]');
  links.forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length < 2) return;
    const el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
})();

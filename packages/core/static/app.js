// Tiny progressive-enhancement script shared by every product. No dependencies.
(function () {
  'use strict';

  // Currency toggle on pricing cards.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-cur-btn]');
    if (btn) document.documentElement.setAttribute('data-cur', btn.getAttribute('data-cur-btn'));

    // Copy text from an element: <button data-copy="#id">
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var src = document.querySelector(copy.getAttribute('data-copy'));
      if (src && navigator.clipboard) {
        navigator.clipboard.writeText(src.value !== undefined && src.value !== '' ? src.value : src.textContent.trim());
        var old = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = old; }, 1400);
      }
    }
  });

  // Confirm dangerous actions: <form data-confirm="Are you sure?">
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Load a chosen file into a textarea (CSV import without multipart uploads):
  // <input type=file data-load-into="#csv">
  document.addEventListener('change', function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('input[type=file][data-load-into]')) return;
    var target = document.querySelector(input.getAttribute('data-load-into'));
    var file = input.files && input.files[0];
    if (!target || !file) return;
    if (file.size > 4 * 1024 * 1024) {
      alert('That file is larger than 4 MB. Please split it into smaller files.');
      input.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { target.value = String(reader.result); };
    reader.readAsText(file);
  });

  // Repeating rows: <div data-repeater> <template data-repeater-template>…</template>
  // <button type=button data-repeater-add> … rows carry [data-repeater-row] and a
  // <button type=button data-repeater-remove>.
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-repeater-add]');
    if (add) {
      var root = add.closest('[data-repeater]');
      var tpl = root.querySelector('template[data-repeater-template]');
      root.querySelector('[data-repeater-rows]').appendChild(tpl.content.cloneNode(true));
      root.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var rm = e.target.closest('[data-repeater-remove]');
    if (rm) {
      var row = rm.closest('[data-repeater-row]');
      var host = row.closest('[data-repeater]');
      if (host.querySelectorAll('[data-repeater-row]').length > 1) row.remove();
      host.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Auto-continue to an external checkout after a short pause.
  var auto = document.querySelector('a[data-autoclick]');
  if (auto) setTimeout(function () { window.location.href = auto.href; }, 600);
})();

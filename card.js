/* Hughes Living Staging — what gets printed for a house.

   Page 1: the sign that sits on the kitchen counter, with the house's QR code.
   After it: one hang tag per piece, each with its number, price and a QR code
   that opens the house page scrolled to that piece.

   For anyone signed in: it reads the same data as their houses screen, so a
   house can be printed before it is marked Staged, and a customer can only
   print their own. */

(function () {
  'use strict';

  var API = window.HLS_API;
  var esc = window.HLS.esc, money = window.HLS.money, houseUrl = window.HLS.houseUrl;
  var out = document.getElementById('out'), bar = document.getElementById('barMsg');
  var code = (new URLSearchParams(location.search).get('h') || '').trim().toUpperCase();

  function qr(text) {
    var q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  function draw(d) {
    var h = d.houses.filter(function (x) { return x.code === code; })[0];
    if (!h) { bar.textContent = 'No house with that code.'; return; }
    var url = houseUrl(h.code);
    var items = d.items.filter(function (i) { return i.house_id === h.id && i.status !== 'retired' && i.status !== 'sold'; });
    var local = /localhost|127\.0\.0\.1/.test(url);

    out.innerHTML =
      '<section class="sheetpage sign">' +
        '<div class="sign__mark">Hughes Living <em>Staging</em></div>' +
        '<h1 class="sign__h">Everything in this home is <em>for sale.</em></h1>' +
        '<div class="sign__mid"><div class="sign__qr">' + qr(url) + '</div>' +
          '<div class="sign__how"><strong>Scan for the list and prices.</strong>' +
          'Point your phone camera at the code. Every piece wears a numbered tag that matches the list. Tap the one you want and we will call you.</div></div>' +
        '<div class="sign__foot"><span>' + esc(h.address) + (h.city ? ', ' + esc(h.city) : '') + '</span><span>' + esc(url.replace(/^https?:\/\//, '')) + '</span></div>' +
      '</section>' +
      (items.length ? '<section class="sheetpage tags">' + items.map(function (i) {
        return '<div class="ptag"><span class="ptag__mark">Hughes Living Staging</span>' +
          '<div><div class="ptag__no">No. ' + i.tag_no + '</div><div class="ptag__t">' + esc(i.title) + '</div>' +
          '<div class="ptag__p">' + money(i.price_cents, 'Ask') + '</div></div>' +
          '<div>' + qr(houseUrl(h.code, i.tag_no)) + '</div></div>';
      }).join('') + '</section>' : '');

    bar.innerHTML = local
      ? '<span class="warn">These codes point at this computer (sample mode), so they only work here.</span> Print from the live site for real cards.'
      : 'The sign, then ' + items.length + ' hang tag' + (items.length === 1 ? '' : 's') + ' to cut out. Codes open <strong>' + esc(url) + '</strong>' +
        (h.status === 'staged' ? '.' : '. <span class="warn">Buyers see the list only once this house is marked Staged.</span>');
    document.getElementById('printBtn').hidden = false;
  }

  document.getElementById('printBtn').addEventListener('click', function () { window.print(); });

  API.session().then(function (s) {
    if (!s.signedIn || !s.kind) { bar.textContent = 'Sign in first, then open this again.'; return; }
    return API.office().then(draw);
  }).catch(function (e) { bar.textContent = e.message || 'Could not load this house.'; });
})();

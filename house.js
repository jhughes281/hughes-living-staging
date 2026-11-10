/* Hughes Living Staging — the page a house's QR code opens.

   Reads one thing: api.publicHouse(code). That answer never contains cost,
   office notes or the client, so nothing here can leak them. */

(function () {
  'use strict';

  var API = window.HLS_API, CFG = window.HLS_CONFIG;
  var esc = window.HLS.esc, money = window.HLS.money, safeUrl = window.HLS.safeUrl;
  var main = document.getElementById('main');
  var sheet = document.getElementById('sheet');
  var code = (new URLSearchParams(location.search).get('h') || '').trim();
  var H = null;

  document.getElementById('storeLink').href = CFG.storeUrl;

  var slug = function (s) { return 'r-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
  var foot = function () {
    var reach = [CFG.contactPhone && '<a href="tel:' + esc(CFG.contactPhone.replace(/[^\d+]/g, '')) + '">' + esc(CFG.contactPhone) + '</a>',
                 CFG.contactEmail && '<a href="mailto:' + esc(CFG.contactEmail) + '">' + esc(CFG.contactEmail) + '</a>'].filter(Boolean).join(' · ');
    return '<footer class="foot"><p class="foot__mark">Hughes Living <em>Staging</em></p>' +
      '<p><a href="gallery.html">See the gallery of looks</a></p>' +
      '<p>Furniture from <a href="' + esc(CFG.storeUrl) + '">Hughes Living Co.</a> and ' +
      '<a href="' + esc(CFG.auctionUrl) + '">Hughes Living Auctions</a>, set up in homes for sale.</p>' +
      (reach ? '<p>' + reach + '</p>' : '') + '</footer>';
  };

  function shut(title, body) {
    main.innerHTML = '<div class="shut"><span class="eyebrow">Staged by Hughes Living</span>' +
      '<h1 class="hero__h">' + title + '</h1><p class="hero__lede">' + body + '</p>' +
      '<p style="margin-top:1.4rem"><a class="btn" href="' + esc(CFG.storeUrl) + '">Shop hugheslivingco.com</a></p></div>' + foot();
  }

  function entry(i) {
    var sold = i.status === 'sold', hold = i.status === 'hold';
    var img = safeUrl(i.photo_url), more = safeUrl(i.source_url);
    return '<article class="entry' + (sold ? ' entry--sold' : '') + '" id="t' + i.tag_no + '">' +
      (img ? '<img class="entry__img" src="' + esc(img) + '" alt="' + esc(i.title) + '" loading="lazy">'
           : '<span class="entry__img thumb--none" aria-hidden="true"></span>') +
      '<div><span class="tagno">No. ' + i.tag_no + '</span>' +
        '<h3 class="entry__t">' + esc(i.title) + '</h3>' +
        (i.details ? '<p class="entry__d">' + esc(i.details) + '</p>' : '') +
        '<div class="entry__foot">' +
          (sold ? '<span class="stamp">Sold</span>'
                : '<span class="entry__price">' + money(i.price_cents, 'Ask for price') + '</span>' +
                  (hold ? '<span class="stamp stamp--hold">On hold</span>' : '') +
                  '<button class="btn' + (hold ? ' btn--ghost' : '') + '" type="button" data-want="' + i.tag_no + '">' + (hold ? 'Ask about it' : 'Buy this piece') + '</button>') +
        '</div>' +
        (!sold && more && i.source === 'store' ? '<a class="entry__more" href="' + esc(more) + '" target="_blank" rel="noopener">See it on hugheslivingco.com&nbsp;&#8599;</a>' : '') +
      '</div></article>';
  }

  function render(h) {
    H = h;
    if (!h.found) return shut('We could not find <em>this home.</em>', 'The code on this link does not match a staged home. Try scanning the card again.');
    if (!h.open) return shut('This staging has <em>ended.</em>',
      'The furniture at ' + esc(h.address) + ' is no longer on display here. Much of it is still for sale at Hughes Living Co.');

    var rooms = {}, order = [];
    h.items.forEach(function (i) { if (!rooms[i.room]) { rooms[i.room] = []; order.push(i.room); } rooms[i.room].push(i); });
    var open = h.items.filter(function (i) { return i.status !== 'sold'; }).length;
    // the look = every piece still available; on-hold and sold pieces are not in it
    var look = h.items.filter(function (i) { return i.status === 'available'; });
    var lookTotal = look.reduce(function (t, i) { return t + (i.price_cents || 0); }, 0);
    var unpriced = look.some(function (i) { return i.price_cents == null; });

    main.innerHTML =
      '<header class="hero"><span class="eyebrow">Staged by Hughes Living</span>' +
        '<h1 class="hero__h">Everything in this home is <em>for sale.</em></h1>' +
        '<p class="hero__addr">' + esc(h.address) + (h.city ? ', ' + esc(h.city) : '') + ' · ' + open + ' piece' + (open === 1 ? '' : 's') + ' available</p>' +
        '<p class="hero__lede">Each piece wears a numbered tag. Find its number below and buy that piece, or take the whole look. We will call you to confirm, take payment and arrange delivery.</p>' +
        (h.note ? '<p class="hero__note">' + esc(h.note) + '</p>' : '') +
        (safeUrl(h.cover_url) ? '<img class="hero__cover" src="' + esc(safeUrl(h.cover_url)) + '" alt="The staged home at ' + esc(h.address) + '">' : '') +
      '</header>' +
      (look.length > 1 ? '<section class="look" aria-labelledby="lookH"><div><span class="eyebrow">Buy the look</span>' +
        '<h2 class="look__h" id="lookH">Every piece staged here, <em>together.</em></h2>' +
        '<p class="look__sum"><strong>' + money(lookTotal, '$0') + '</strong> for all ' + look.length + ' available pieces' +
          (unpriced ? ', plus the ones still to be priced' : '') + (open > look.length ? '. Pieces on hold are not included' : '') + '.</p></div>' +
        '<button class="btn look__btn" type="button" data-look>Buy the look</button></section>' : '') +
      (order.length > 1 ? '<ul class="jump" aria-label="Rooms">' + order.map(function (r) {
        return '<li><a href="#' + slug(r) + '">' + esc(r) + '</a></li>';
      }).join('') + '</ul>' : '') +
      (order.length ? order.map(function (r) {
        return '<section class="broom" id="' + slug(r) + '"><h2 class="broom__h">' + esc(r) + ' <span>' + rooms[r].length + ' piece' + (rooms[r].length === 1 ? '' : 's') + '</span></h2>' +
          rooms[r].map(entry).join('') + '</section>';
      }).join('') : '<p class="empty" style="margin-top:1.5rem">The furniture list for this home is being set up. Check back shortly.</p>') +
      '<section class="ask"><h2>Something else?</h2><p>Ask about a single room, delivery, or anything else in the house.</p>' +
        '<button class="btn btn--ghost" type="button" data-want="">Send us a question</button></section>' + foot();

    // a tag's own QR code lands on its piece
    if (location.hash && document.getElementById(location.hash.slice(1))) {
      document.getElementById(location.hash.slice(1)).scrollIntoView();
    }
  }

  function openWant(tagNo, wholeLook) {
    var i = tagNo ? H.items.filter(function (x) { return x.tag_no === tagNo; })[0] : null;
    var look = wholeLook ? H.items.filter(function (x) { return x.status === 'available'; }) : null;
    var kind = look ? 'look' : i ? 'piece' : 'question';
    var hold = i && i.status === 'hold';
    sheet.innerHTML = '<form class="sheet__in" id="wantForm" novalidate>' +
      '<div class="sheet__top"><div><span class="eyebrow">' + (look ? 'Buy the look · ' + look.length + ' pieces'
          : i ? 'No. ' + i.tag_no + ' · ' + money(i.price_cents, 'Ask for price') : 'A question') + '</span>' +
        '<h2 id="sheetTitle">' + (look ? money(look.reduce(function (t, x) { return t + (x.price_cents || 0); }, 0), '$0') + ' for everything available'
          : esc(i ? i.title : 'Ask about this home')) + '</h2></div>' +
        '<button class="x" type="button" id="wantClose" aria-label="Close">&times;</button></div>' +
      (look ? '<ul class="looklist">' + look.map(function (x) {
          return '<li><span class="tagno">No. ' + x.tag_no + '</span><span>' + esc(x.title) + '</span><span class="num">' + money(x.price_cents, 'Ask') + '</span></li>';
        }).join('') + '</ul>' : '') +
      '<div class="field"><label for="wName">Your name</label><input id="wName" name="name" autocomplete="name" maxlength="80" required></div>' +
      '<div class="field"><label for="wPhone">Phone</label><input id="wPhone" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="30"></div>' +
      '<div class="field"><label for="wEmail">Email</label><input id="wEmail" name="email" type="email" autocomplete="email" maxlength="120">' +
        '<p class="hint">A phone number or an email, whichever you prefer.</p></div>' +
      '<div class="field"><label for="wNote">Anything we should know</label><textarea id="wNote" name="note" rows="2" maxlength="500"></textarea></div>' +
      '<p class="sheet__err" role="alert"></p>' +
      '<button class="btn btn--block" type="submit">' + (look ? 'Buy the look' : hold ? 'Ask about it' : i ? 'Buy this piece' : 'Send') + '</button>' +
      '<p class="fine">' + (kind === 'question' || hold ? 'We will get back to you.'
        : 'Nothing is charged here. This places your order with Hughes Living; we call you to confirm it and take payment, and ' +
          (look ? 'the pieces are' : 'the piece is') + ' yours once that is done.') + '</p></form>';
    sheet._tag = i ? i.tag_no : null;
    sheet._kind = hold ? 'question' : kind;
    sheet.showModal();
    document.getElementById('wName').focus();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-want]');
    if (e.target.closest('[data-look]')) openWant(null, true);
    else if (b) openWant(Number(b.getAttribute('data-want')) || null);
    else if (e.target.id === 'wantClose' || e.target.id === 'wantDone' || e.target === sheet) sheet.close();
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'wantForm') return;
    e.preventDefault();
    var f = e.target, err = f.querySelector('.sheet__err'), btn = f.querySelector('[type=submit]');
    var name = f.name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
    if (!name) { err.textContent = 'Please give your name.'; f.name.focus(); return; }
    if (!phone && !email) { err.textContent = 'Leave a phone number or an email so we can reach you.'; f.phone.focus(); return; }
    btn.disabled = true; err.textContent = '';
    var kind = sheet._kind;
    API.sendRequest(code, sheet._tag, name, phone, email, f.note.value.trim(), kind).then(function () {
      sheet.innerHTML = '<div class="sheet__in thanks"><span class="eyebrow">Sent</span><h2 id="sheetTitle">Thank you, ' + esc(name.split(' ')[0]) + '.</h2>' +
        '<p>' + (kind === 'look' ? 'Your order for the look is in.' : kind === 'piece' ? 'Your order is in.' : 'We have your question.') +
        ' We will be in touch at ' + esc(phone || email) + (kind === 'question' ? '.' : ' to confirm it and take payment.') + '</p>' +
        '<button class="btn" type="button" id="wantDone">Keep looking</button></div>';
    }).catch(function (x) { err.textContent = x.message || 'That did not send. Please try again.'; btn.disabled = false; });
  });

  if (!code) render({ found: false });
  else API.publicHouse(code).then(render).catch(function () {
    shut('This page could not <em>load.</em>', 'Check your connection and scan the card again.');
  });
})();

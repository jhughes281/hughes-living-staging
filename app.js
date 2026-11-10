/* Hughes Living Staging — the office, and the customer side of it.

   Three kinds of people sign in here:
     owner     Hughes Living staff: everything, including cost and Money
     self      someone staging their own house
     designer  an interior designer staging for clients
   Customers see only their own houses and never a cost. That is decided by
   the data layer (api.js / the database), not by this file: a customer's rows
   arrive already filtered, and this file only chooses which controls to draw.

   Screens over one small dataset: Houses, Furniture, Requests, Money, Accounts.
   Everything is loaded in one call (api.office) and re-read after every save,
   so what is on screen is always what the database holds. All arithmetic
   (days out, floor value, profit per house) is done here from those rows. */

(function () {
  'use strict';

  var API = window.HLS_API, CFG = window.HLS_CONFIG;
  var esc = window.HLS.esc, money = window.HLS.money, safeUrl = window.HLS.safeUrl;

  var D = { houses: [], items: [], requests: [], moves: [], accounts: [], catalog_count: 0 };
  var ME = { signedIn: false, kind: null, staff: false };     // who is signed in
  var KIND = { owner: 'Hughes Living staff', self: 'Staging it myself', designer: 'Interior designer' };
  var F = { q: '', where: 'all', status: 'live' };          // furniture filters
  var view = document.getElementById('view');
  var sheet = document.getElementById('sheet');
  var toastEl = document.getElementById('toast');

  var ROOMS = ['Living room', 'Dining room', 'Kitchen', 'Primary bedroom', 'Bedroom 2', 'Bedroom 3', 'Office', 'Entry', 'Patio'];
  var STATUS = { available: 'Available', hold: 'On hold', sold: 'Sold', retired: 'Retired' };
  var HSTATUS = { planned: 'Planned', staged: 'Staged', destaged: 'Destaged' };
  var RSTATUS = { 'new': 'New', contacted: 'Contacted', sold: 'Sold', closed: 'Closed' };
  var SOURCE = { store: 'Hughes Living Co.', auction: 'Auction lot', other: 'Other' };
  var DAY = 86400000;

  /* ---------- lookups and sums ---------- */
  var house = function (id) { return D.houses.filter(function (h) { return h.id === id; })[0]; };
  var account = function (id) { return (D.accounts || []).filter(function (a) { return String(a.id) === String(id); })[0]; };
  var stagedBy = function (h) {
    var a = h.account_id != null && account(h.account_id);
    return a ? (a.studio || a.name) + ' (' + KIND[a.kind].toLowerCase() + ')' : 'Hughes Living';
  };
  var item = function (id) { return D.items.filter(function (i) { return i.id === id; })[0]; };
  var inHouse = function (hid) { return D.items.filter(function (i) { return i.house_id === hid && i.status !== 'retired'; }); };
  var sum = function (rows, key) { return rows.reduce(function (t, r) { return t + (r[key] || 0); }, 0); };
  var today = function () { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  var fmtDate = function (s) {
    if (!s) return '';
    var d = new Date(s.length === 10 ? s + 'T12:00:00' : s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function daysOut(i) {
    var m = D.moves.filter(function (x) { return x.item_id === i.id && !x.removed_at; })[0];
    return m ? Math.max(0, Math.floor((Date.now() - new Date(m.placed_at)) / DAY)) : null;
  }
  function stats(h) {
    var here = inHouse(h.id);
    var live = here.filter(function (i) { return i.status !== 'sold'; });
    var sold = D.items.filter(function (i) { return i.status === 'sold' && i.sold_house_id === h.id; });
    var sales = sum(sold, 'sold_cents'), cogs = sum(sold, 'cost_cents');
    var end = h.status === 'destaged' && h.destage_on ? new Date(h.destage_on + 'T12:00:00') : new Date();
    return {
      pieces: here.length, floor: sum(live, 'price_cents'), floorCost: sum(live, 'cost_cents'),
      soldN: sold.length, sales: sales, cogs: cogs, profit: (h.fee_cents || 0) + sales - cogs,
      days: h.staged_on ? Math.max(0, Math.floor((end - new Date(h.staged_on + 'T12:00:00')) / DAY)) : null,
      newReq: D.requests.filter(function (r) { return r.house_id === h.id && r.status === 'new'; }).length
    };
  }

  /* ---------- feedback ---------- */
  var toastTimer;
  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = 'toast is-on' + (bad ? ' is-bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, bad ? 6000 : 2600);
  }
  /* Run a write, say what happened, re-read everything. */
  function run(promise, done) {
    return promise.then(function (r) {
      return reload().then(function () { if (done) toast(done); return r; });
    }).catch(function (e) { toast(e.message || 'That did not save.', true); throw e; });
  }
  function reload() {
    return API.office().then(function (d) { d.accounts = d.accounts || []; D = d; route(); });
  }

  /* ---------- small builders ---------- */
  function opts(map, cur) {
    return Object.keys(map).map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(map[k]) + '</option>';
    }).join('');
  }
  function thumb(i, cls) {
    var u = safeUrl(i.photo_url);
    return u ? '<img class="' + (cls || 'thumb') + '" src="' + esc(u) + '" alt="" loading="lazy">'
             : '<span class="' + (cls || 'thumb') + ' thumb--none" aria-hidden="true"></span>';
  }
  function chip(kind, label) { return '<span class="chip chip--' + esc(kind) + '">' + esc(label) + '</span>'; }
  function field(label, name, val, o) {
    o = o || {};
    var id = 'f_' + name, common = ' id="' + id + '" name="' + name + '"' + (o.req ? ' required' : '');
    var input = o.area
      ? '<textarea' + common + ' rows="' + (o.rows || 2) + '">' + esc(val) + '</textarea>'
      : o.select
        ? '<select' + common + '>' + o.select + '</select>'
        : '<input' + common + ' type="' + (o.type || 'text') + '" value="' + esc(val) + '"' +
          (o.list ? ' list="' + o.list + '"' : '') + (o.mode ? ' inputmode="' + o.mode + '"' : '') +
          (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + '>';
    return '<div class="field' + (o.cls ? ' ' + o.cls : '') + '"><label for="' + id + '">' + esc(label) + '</label>' + input +
           (o.hint ? '<p class="hint">' + esc(o.hint) + '</p>' : '') + '</div>';
  }
  var dollars = function (cents) { return cents == null ? '' : (cents / 100).toFixed(2).replace(/\.00$/, ''); };
  var cents = function (v) {
    v = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    return v === '' || isNaN(Number(v)) ? null : Math.round(Number(v) * 100);
  };
  function formData(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) o[el.name] = el.value; });
    return o;
  }

  /* ================================================================ houses */
  function renderHouses() {
    var rows = D.houses.map(function (h) {
      var s = stats(h);
      var under = ME.staff ? [h.city, 'staged by ' + stagedBy(h)] : [h.city, h.client_name];
      return '<a class="hrow" href="#house/' + h.id + '">' +
        '<span class="hrow__addr">' + thumb({ photo_url: h.cover_url }, 'hrow__img') +
          '<span><strong>' + esc(h.address) + '</strong>' +
          '<small>' + esc(under.filter(Boolean).join(' · ')) + '</small></span></span>' +
        '<span class="hrow__st">' + chip(h.status, HSTATUS[h.status]) +
          (s.newReq ? ' <span class="chip chip--new">' + s.newReq + ' new request' + (s.newReq > 1 ? 's' : '') + '</span>' : '') + '</span>' +
        '<span class="num" data-l="Pieces">' + s.pieces + '</span>' +
        '<span class="num" data-l="On the floor">' + money(s.floor, '$0') + '</span>' +
        '<span class="num" data-l="Sold">' + money(s.sales, '$0') + '</span>' +
        '<span class="num" data-l="Days">' + (s.days == null ? '–' : s.days) + '</span>' +
      '</a>';
    }).join('');

    var title = ME.staff ? 'Where the furniture <em>is</em>'
      : ME.kind === 'designer' ? 'Your clients&rsquo; <em>houses</em>' : 'Your <em>house</em>';
    var none = ME.staff ? 'No houses yet. Add the first one, then place furniture in it from the Furniture tab or the house page.'
      : 'Add the house you are staging. Then choose Hughes Living furniture for it, room by room.';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Houses</p><h1 class="title">' + title + '</h1></div>' +
      '<button class="btn" type="button" data-act="new-house">Add a house</button></div>' +
      (D.houses.length
        ? '<div class="hlist"><div class="hrow hrow--head" aria-hidden="true"><span>House</span><span>Status</span>' +
          '<span class="num">Pieces</span><span class="num">On the floor</span><span class="num">Sold</span><span class="num">Days</span></div>' + rows + '</div>'
        : '<p class="empty">' + none + '</p>');
  }

  function renderHouse(id) {
    var h = house(id);
    if (!h) { location.hash = '#houses'; return; }
    var s = stats(h), here = inHouse(h.id);
    var rooms = {};
    here.forEach(function (i) { (rooms[i.room || 'No room set'] = rooms[i.room || 'No room set'] || []).push(i); });

    var roomHtml = Object.keys(rooms).sort().map(function (r) {
      return '<section class="room"><h2 class="room__name">' + esc(r) + ' <span>' + rooms[r].length + '</span></h2>' +
        rooms[r].map(function (i) {
          var sold = i.status === 'sold';
          return '<div class="piece" data-id="' + i.id + '">' + thumb(i) +
            '<div class="piece__main"><span class="tagno">No. ' + i.tag_no + '</span>' +
              (ME.staff ? '<button class="piece__title linkbtn" type="button" data-act="edit-item" data-id="' + i.id + '">' + esc(i.title) + '</button>'
                        : '<span class="piece__title">' + esc(i.title) + '</span>') +
              '<span class="piece__meta">' + esc(SOURCE[i.source]) + (daysOut(i) != null ? ' · ' + daysOut(i) + ' days here' : '') + '</span></div>' +
            '<span class="piece__price">' + (sold ? 'Sold ' + money(i.sold_cents, '') : money(i.price_cents, 'No price')) + '</span>' +
            (ME.staff
              ? '<label class="vh" for="st' + i.id + '">Status of ' + esc(i.title) + '</label>' +
                '<select class="mini" id="st' + i.id + '" data-act="item-status" data-id="' + i.id + '">' + opts(STATUS, i.status) + '</select>' +
                '<button class="linkbtn" type="button" data-act="send-back" data-id="' + i.id + '">' + (sold ? 'Picked up' : 'Back to warehouse') + '</button>'
              : chip(i.status, STATUS[i.status]) +
                (sold ? '' : '<button class="linkbtn" type="button" data-act="send-back" data-id="' + i.id + '">Send back</button>')) +
          '</div>';
        }).join('') + '</section>';
    }).join('');

    var spare = D.items.filter(function (i) { return i.house_id == null && (i.status === 'available' || i.status === 'hold'); });
    var placeHtml = spare.length
      ? '<form class="place" id="placeForm"><div class="place__list">' + spare.map(function (i) {
          return '<label class="place__row"><input type="checkbox" name="pick" value="' + i.id + '">' + thumb(i, 'thumb thumb--sm') +
            '<span><span class="tagno">No. ' + i.tag_no + '</span> ' + esc(i.title) + '</span><span class="num">' + money(i.price_cents, '') + '</span></label>';
        }).join('') + '</div>' +
        '<div class="place__go">' + field('Room', 'room', '', { list: 'rooms', ph: 'Living room' }) +
        '<button class="btn" type="submit">Place in this house</button></div></form>'
      : '<p class="empty">' + (ME.staff ? 'Nothing in the warehouse to place. Add pieces on the <a href="#furniture">Furniture</a> tab.'
                                        : 'Nothing is free in the Hughes Living warehouse right now.') + '</p>';

    var reqs = D.requests.filter(function (r) { return r.house_id === h.id; });
    var publicUrl = 'house.html?h=' + encodeURIComponent(h.code);
    var who = ME.staff ? [h.client_name, h.client_phone, h.client_email].filter(Boolean).join(' · ') || 'No client on file'
                       : (ME.kind === 'designer' ? [h.client_name, h.client_phone, h.client_email].filter(Boolean).join(' · ') || 'No client on file' : '');

    view.innerHTML =
      '<p class="crumb"><a href="#houses">&larr; All houses</a></p>' +
      '<div class="head head--house"><div><p class="eyebrow">' + esc(h.city || 'House') + ' · code ' + esc(h.code) + '</p>' +
        '<h1 class="title">' + esc(h.address) + '</h1>' +
        (who ? '<p class="sub">' + esc(who) + '</p>' : '') +
        (ME.staff ? '<p class="sub">Staged by ' + esc(stagedBy(h)) + '</p>' : '') + '</div>' +
        '<div class="head__acts">' +
          '<a class="btn" href="card.html?h=' + encodeURIComponent(h.code) + '" target="_blank" rel="noopener">QR card &amp; tags</a>' +
          '<a class="btn btn--ghost" href="' + publicUrl + '" target="_blank" rel="noopener">Buyer page</a>' +
          '<button class="btn btn--ghost" type="button" data-act="edit-house" data-id="' + h.id + '">Edit</button></div></div>' +

      '<div class="seg" role="group" aria-label="House status">' + Object.keys(HSTATUS).map(function (k) {
        return '<button type="button" data-act="house-status" data-id="' + h.id + '" data-v="' + k + '" aria-pressed="' + (h.status === k) + '">' + HSTATUS[k] + '</button>';
      }).join('') + '</div>' +
      '<p class="seg__note">' + ({ planned: 'The buyer page is closed until this house is marked Staged.',
        staged: 'The QR code is live: buyers see every piece below with its price.',
        destaged: 'The buyer page now says the staging has ended.' })[h.status] + '</p>' +

      '<dl class="facts">' +
        '<div><dt>Pieces here</dt><dd>' + s.pieces + '</dd></div>' +
        '<div><dt>On the floor</dt><dd>' + money(s.floor, '$0') + '</dd></div>' +
        '<div><dt>Sold from here</dt><dd>' + money(s.sales, '$0') + ' <small>' + s.soldN + ' pc</small></dd></div>' +
        '<div><dt>Staging fee</dt><dd>' + (h.fee_cents ? money(h.fee_cents) : (ME.staff ? '$0' : '<small>Not set yet</small>')) + '</dd></div>' +
        (ME.staff ? '<div><dt>Profit so far</dt><dd>' + money(s.profit, '$0') + '</dd></div>' : '') +
        '<div><dt>Staged</dt><dd>' + (s.days != null ? s.days + ' <small>days, since ' + fmtDate(h.staged_on).replace(/, \d{4}$/, '') + '</small>' : 'Not yet') + '</dd></div>' +
      '</dl>' +
      (ME.staff && h.notes ? '<p class="note"><strong>Office note</strong> ' + esc(h.notes) + '</p>' : '') +
      (safeUrl(h.cover_url) ? '<img class="cover" src="' + esc(safeUrl(h.cover_url)) + '" alt="Cover photo of ' + esc(h.address) + '" loading="lazy">' : '') +

      '<div class="cols"><div>' +
        '<h2 class="h2">In this house</h2>' +
        (roomHtml || '<p class="empty">No furniture placed here yet.</p>') +
      '</div><aside>' +
        '<h2 class="h2">' + (ME.staff ? 'Place furniture from the warehouse' : 'Choose Hughes Living furniture') + '</h2>' + placeHtml +
        '<h2 class="h2">Requests from this house</h2>' +
        (reqs.length ? reqs.map(reqCard).join('') : '<p class="empty">None yet.</p>') +
      '</aside></div>' +
      '<datalist id="rooms">' + ROOMS.map(function (r) { return '<option value="' + r + '">'; }).join('') + '</datalist>';
  }

  /* ============================================================= furniture */
  function renderFurniture() {
    var q = F.q.toLowerCase();
    var rows = D.items.filter(function (i) {
      if (F.status === 'live' ? (i.status === 'sold' || i.status === 'retired') : (F.status !== 'all' && i.status !== F.status)) return false;
      if (F.where === 'warehouse' ? i.house_id != null : (F.where !== 'all' && String(i.house_id) !== F.where)) return false;
      return !q || (i.title + ' ' + i.tag_no + ' ' + (i.category || '') + ' ' + (i.source_ref || '')).toLowerCase().indexOf(q) !== -1;
    });
    var whereOpts = '<option value="all">Everywhere</option><option value="warehouse"' + (F.where === 'warehouse' ? ' selected' : '') + '>' +
      (ME.staff ? 'Warehouse' : 'Free to place') + '</option>' +
      D.houses.map(function (h) { return '<option value="' + h.id + '"' + (F.where === String(h.id) ? ' selected' : '') + '>' + esc(h.address) + '</option>'; }).join('');

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Furniture</p><h1 class="title">' +
        (ME.staff ? 'Every piece, and where it <em>went</em>' : 'Furniture you can stage <em>with</em>') + '</h1>' +
        (ME.staff ? '' : '<p class="sub">Pieces free in the Hughes Living warehouse, and the ones already in your houses. Place them from a house&rsquo;s page.</p>') + '</div>' +
        (ME.staff ? '<div class="head__acts"><button class="btn" type="button" data-act="new-item">Add a piece</button>' +
        '<button class="btn btn--ghost" type="button" data-act="from-store">From the store</button>' +
        '<button class="btn btn--ghost" type="button" data-act="from-lot">From an auction lot</button></div>' : '') + '</div>' +
      '<div class="filters">' +
        '<div class="field"><label for="fq">Search</label><input id="fq" type="search" value="' + esc(F.q) + '" placeholder="Name, tag number, category"></div>' +
        '<div class="field"><label for="fw">Where</label><select id="fw">' + whereOpts + '</select></div>' +
        '<div class="field"><label for="fs">Status</label><select id="fs"><option value="live"' + (F.status === 'live' ? ' selected' : '') + '>Not sold</option>' +
          '<option value="all"' + (F.status === 'all' ? ' selected' : '') + '>All</option>' + opts(STATUS, F.status) + '</select></div>' +
      '</div>' +
      '<p class="count">' + rows.length + ' of ' + D.items.length + ' pieces · ' + money(sum(rows, 'price_cents'), '$0') + ' at price' +
        (ME.staff ? ' · ' + money(sum(rows, 'cost_cents'), '$0') + ' at cost' : '') + '</p>' +
      (rows.length ? '<div class="tablewrap"><table class="grid"><thead><tr><th>Tag</th><th>Piece</th><th>Where</th>' +
        (ME.staff ? '<th class="c-src">From</th><th class="num c-cost">Cost</th>' : '') +
        '<th class="num">Price</th><th>Status</th><th class="num c-days">Days out</th></tr></thead><tbody>' +
        rows.map(function (i) {
          var h = i.house_id != null && house(i.house_id);
          var name = thumb(i, 'thumb thumb--sm') + '<span>' + esc(i.title) + (i.category ? '<small>' + esc(i.category) + '</small>' : '') + '</span>';
          return '<tr><td class="tagno">' + i.tag_no + '</td>' +
            '<td>' + (ME.staff ? '<button class="cellbtn" type="button" data-act="edit-item" data-id="' + i.id + '">' + name + '</button>'
                              : '<span class="cellbtn cellbtn--plain">' + name + '</span>') + '</td>' +
            '<td>' + (h ? '<a href="#house/' + h.id + '">' + esc(h.address) + '</a><small>' + esc(i.room || '') + '</small>' : (ME.staff ? 'Warehouse' : 'Free to place')) + '</td>' +
            (ME.staff ? '<td class="c-src">' + esc(SOURCE[i.source]) + '</td><td class="num c-cost">' + money(i.cost_cents, '–') + '</td>' : '') +
            '<td class="num">' + (i.status === 'sold' ? money(i.sold_cents, '–') : money(i.price_cents, '–')) + '</td>' +
            '<td>' + chip(i.status, STATUS[i.status]) + '</td>' +
            '<td class="num c-days">' + (daysOut(i) == null ? '–' : daysOut(i)) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="empty">' + (D.items.length ? 'Nothing matches those filters.'
            : (ME.staff ? 'No furniture yet. Add a piece, or pull one in from the store or an auction lot.' : 'Nothing is free in the warehouse right now.')) + '</p>');
  }

  /* ============================================================== requests */
  function reqCard(r) {
    var h = house(r.house_id), i = r.item_id != null && item(r.item_id);
    var piece = i ? 'No. ' + i.tag_no + ' ' + esc(r.item_title) : esc(r.item_title);
    return '<article class="req' + (r.status === 'new' ? ' req--new' : '') + '">' +
      '<header><strong>' + esc(r.name) + '</strong><time>' + fmtDate(r.created_at) + '</time></header>' +
      '<p class="req__what">' + (r.kind === 'look'
          ? '<strong class="req__look">Buying the look</strong> ' + r.piece_count + ' piece' + (r.piece_count === 1 ? '' : 's') + ', ' + money(r.total_cents, '$0') + ' when they asked'
          : r.item_title ? (r.kind === 'question' ? 'Asking about ' : 'Buying ') + (i && ME.staff ? '<button class="linkbtn" type="button" data-act="edit-item" data-id="' + i.id + '">' + piece + '</button>' : piece)
          : 'A question') + (h ? ' <span>at ' + esc(h.address) + '</span>' : '') + '</p>' +
      (r.note ? '<p class="req__note">&ldquo;' + esc(r.note) + '&rdquo;</p>' : '') +
      (ME.staff
        ? '<p class="req__reach">' +
            (r.phone ? '<a href="tel:' + esc(r.phone.replace(/[^\d+]/g, '')) + '">' + esc(r.phone) + '</a>' : '') +
            (r.phone && r.email ? ' · ' : '') +
            (r.email ? '<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>' : '') + '</p>' +
          '<label class="vh" for="rq' + r.id + '">Status of request from ' + esc(r.name) + '</label>' +
          '<select class="mini" id="rq' + r.id + '" data-act="req-status" data-id="' + r.id + '">' + opts(RSTATUS, r.status) + '</select>'
        : '<p class="req__reach">' + chip(r.status === 'new' ? 'new' : 'hold', RSTATUS[r.status]) + ' Hughes Living is following up with this buyer.</p>') +
    '</article>';
  }
  function renderRequests() {
    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Orders &amp; questions</p><h1 class="title">Who scanned, and what they <em>want</em></h1></div></div>' +
      (D.requests.length ? '<div class="reqs">' + D.requests.map(reqCard).join('') + '</div>'
        : '<p class="empty">Nothing yet. When a buyer taps &ldquo;Buy this piece&rdquo; or &ldquo;Buy the look&rdquo; on a house page, it lands here.</p>');
  }

  /* ================================================================= money */
  function renderMoney() {
    var t = { fee: 0, sales: 0, cogs: 0, profit: 0, n: 0 };
    var rows = D.houses.map(function (h) {
      var s = stats(h);
      t.fee += h.fee_cents || 0; t.sales += s.sales; t.cogs += s.cogs; t.profit += s.profit; t.n += s.soldN;
      return '<tr><td><a href="#house/' + h.id + '">' + esc(h.address) + '</a><small>' + HSTATUS[h.status] + '</small></td>' +
        '<td class="num">' + money(h.fee_cents, '$0') + '</td><td class="num">' + s.soldN + '</td>' +
        '<td class="num">' + money(s.sales, '$0') + '</td><td class="num">' + money(s.cogs, '$0') + '</td>' +
        '<td class="num"><strong>' + money(s.profit, '$0') + '</strong></td></tr>';
    }).join('');
    var loose = D.items.filter(function (i) { return i.status === 'sold' && i.sold_house_id == null; });
    if (loose.length) {
      var ls = sum(loose, 'sold_cents'), lc = sum(loose, 'cost_cents');
      t.sales += ls; t.cogs += lc; t.profit += ls - lc; t.n += loose.length;
      rows += '<tr><td>Sold from the warehouse</td><td class="num">–</td><td class="num">' + loose.length + '</td>' +
        '<td class="num">' + money(ls, '$0') + '</td><td class="num">' + money(lc, '$0') + '</td><td class="num"><strong>' + money(ls - lc, '$0') + '</strong></td></tr>';
    }
    var out = D.items.filter(function (i) { return i.house_id != null && i.status !== 'sold' && i.status !== 'retired'; });
    var noCost = D.items.filter(function (i) { return i.status === 'sold' && i.cost_cents == null; }).length;

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Money</p><h1 class="title">What each house <em>made</em></h1></div></div>' +
      '<div class="tablewrap"><table class="grid grid--money"><thead><tr><th>House</th><th class="num">Staging fee</th><th class="num">Pieces sold</th>' +
        '<th class="num">Sales</th><th class="num">Cost of those pieces</th><th class="num">Profit</th></tr></thead><tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td>Total</td><td class="num">' + money(t.fee, '$0') + '</td><td class="num">' + t.n + '</td><td class="num">' + money(t.sales, '$0') +
        '</td><td class="num">' + money(t.cogs, '$0') + '</td><td class="num"><strong>' + money(t.profit, '$0') + '</strong></td></tr></tfoot></table></div>' +
      '<p class="fine">Profit = staging fee + sales &minus; what the sold pieces cost. It leaves out the truck, labor, storage and sales tax.' +
        (noCost ? ' <strong>' + noCost + ' sold piece' + (noCost > 1 ? 's have' : ' has') + ' no cost entered</strong>, so profit is overstated until that is filled in.' : '') + '</p>' +
      '<dl class="facts"><div><dt>Out in houses now</dt><dd>' + out.length + ' <small>pieces</small></dd></div>' +
        '<div><dt>Their price tags</dt><dd>' + money(sum(out, 'price_cents'), '$0') + '</dd></div>' +
        '<div><dt>What they cost</dt><dd>' + money(sum(out, 'cost_cents'), '$0') + '</dd></div></dl>';
  }

  /* ============================================================== accounts */
  function renderAccounts() {
    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Accounts</p><h1 class="title">Who stages with your <em>furniture</em></h1></div></div>' +
      (D.accounts.length ? '<div class="tablewrap"><table class="grid"><thead><tr><th>Name</th><th>Kind</th><th>Reach them</th>' +
        '<th class="num">Houses</th><th class="num">Pieces out</th><th>Since</th></tr></thead><tbody>' +
        D.accounts.map(function (a) {
          var hs = D.houses.filter(function (h) { return String(h.account_id) === String(a.id); });
          var out = hs.reduce(function (t, h) { return t + inHouse(h.id).filter(function (i) { return i.status !== 'sold'; }).length; }, 0);
          return '<tr><td><strong>' + esc(a.name) + '</strong>' + (a.studio ? '<small>' + esc(a.studio) + '</small>' : '') + '</td>' +
            '<td>' + chip(a.kind === 'designer' ? 'hold' : 'available', KIND[a.kind]) + '</td>' +
            '<td>' + (a.email ? '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>' : '') + (a.phone ? '<small>' + esc(a.phone) + '</small>' : '') + '</td>' +
            '<td class="num">' + hs.length + '</td><td class="num">' + out + '</td><td>' + fmtDate(a.created_at) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="empty">No customer accounts yet. Homeowners and interior designers create their own from the sign-in page.</p>') +
      '<p class="fine">To hand a house to an account, open the house, choose Edit, and set &ldquo;Staged by&rdquo;.</p>';
  }

  /* ================================================================ sheets */
  function openSheet(html) {
    sheet.innerHTML = html;
    if (!sheet.open) sheet.showModal();
    var first = sheet.querySelector('input:not([type=hidden]),select,textarea');
    if (first) first.focus();
  }
  function sheetTop(kicker, title) {
    return '<div class="sheet__top"><div><span class="eyebrow">' + esc(kicker) + '</span><h2 id="sheetTitle">' + esc(title) + '</h2></div>' +
      '<button class="x" type="button" data-act="close" aria-label="Close">&times;</button></div>';
  }

  function openHouse(h) {
    h = h || { status: 'planned' };
    var client = ME.kind === 'self' ? '' :                    // someone staging their own house is the client
      field('Client (agent, seller or builder)', 'client_name', h.client_name) +
      '<div class="pair">' + field('Client phone', 'client_phone', h.client_phone, { type: 'tel' }) + field('Client email', 'client_email', h.client_email, { type: 'email' }) + '</div>';
    var by = '<option value="">Hughes Living</option>' + D.accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (String(h.account_id) === String(a.id) ? ' selected' : '') + '>' +
        esc((a.studio || a.name) + ' · ' + KIND[a.kind]) + '</option>';
    }).join('');

    openSheet('<form class="sheet__in" id="houseForm" novalidate>' + sheetTop(h.id ? 'Edit house' : 'New house', h.address || 'Add a house') +
      '<input type="hidden" name="id" value="' + esc(h.id) + '">' +
      field('Street address', 'address', h.address, { req: true }) +
      '<div class="pair">' + field('City', 'city', h.city) + field('ZIP', 'zip', h.zip, { mode: 'numeric' }) + '</div>' +
      client +
      field('Listing link', 'listing_url', h.listing_url, { type: 'url', ph: 'https://' }) +
      (ME.staff
        ? '<div class="pair">' + field('Status', 'status', '', { select: opts(HSTATUS, h.status) }) + field('Staging fee ($)', 'fee', dollars(h.fee_cents), { mode: 'decimal' }) + '</div>' +
          field('Staged by', 'account_id', '', { select: by, hint: 'The account that sees and manages this house.' })
        : field('Status', 'status', '', { select: opts(HSTATUS, h.status) })) +
      '<div class="pair">' + field('Staged on', 'staged_on', h.staged_on, { type: 'date' }) + field('Comes out on', 'destage_on', h.destage_on, { type: 'date' }) + '</div>' +
      '<div class="photo"><div class="photo__box" id="photoBox">' + thumb({ photo_url: h.cover_url }, 'photo__img') + '</div><div class="photo__side">' +
        field('Cover photo link', 'cover_url', h.cover_url, { ph: 'https://', hint: 'A photo of the staged house. It leads the page the QR code opens.' }) +
        (ME.staff ? '<label class="btn btn--ghost btn--file">Take or choose a photo<input type="file" id="photoFile" accept="image/*"></label>' : '') + '</div></div>' +
      field('Note for buyers', 'public_note', h.public_note, { area: true, hint: 'Printed at the top of the page the QR code opens.' }) +
      (ME.staff ? field('Office note', 'notes', h.notes, { area: true, hint: 'Lockbox, gate code, who to call. Never shown to buyers or customers.' }) : '') +
      '<p class="sheet__err" role="alert"></p>' +
      '<div class="sheet__acts"><button class="btn" type="submit">Save house</button>' +
      (h.id && ME.staff ? '<button class="linkbtn linkbtn--bad" type="button" data-act="del-house" data-id="' + h.id + '">Delete house</button>' : '') + '</div></form>');
  }

  /* ---------- signing in ---------- */
  function openAuth(kind, mode) {
    var up = mode === 'up', fin = mode === 'finish';
    var title = fin ? 'Finish your account' : up ? 'Create an account' : 'Sign in';
    openSheet('<form class="sheet__in" id="authForm" novalidate>' + sheetTop(KIND[kind], title) +
      '<input type="hidden" name="kind" value="' + esc(kind) + '"><input type="hidden" name="mode" value="' + esc(mode) + '">' +
      (up || fin ? field('Your name', 'name', '', { req: true }) +
        (kind === 'designer' ? field('Studio or business name', 'studio', '') : '') +
        field('Phone', 'phone', '', { type: 'tel' }) : '') +
      (fin ? '' : field('Email', 'email', '', { type: 'email', req: true }) +
        field('Password', 'password', '', { type: 'password', req: true, hint: up ? 'At least 8 characters.' : '' })) +
      '<p class="sheet__err" role="alert"></p>' +
      '<div class="sheet__acts"><button class="btn" type="submit">' + title + '</button>' +
      (fin || kind === 'owner' ? '' : '<button class="linkbtn" type="button" data-act="door" data-kind="' + kind + '" data-mode="' + (up ? 'in' : 'up') + '">' +
        (up ? 'I already have an account' : 'Create an account instead') + '</button>') + '</div>' +
      (API.name === 'demo' && !fin ? '<p class="fine">Sample mode: this account is kept in this browser only, so use a throwaway password.</p>' : '') +
      '</form>');
    var pw = document.getElementById('f_password');
    if (pw) pw.setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    var em = document.getElementById('f_email');
    if (em) em.setAttribute('autocomplete', 'email');
  }

  function openItem(i, preset) {
    i = i || { status: 'available', source: 'other' };
    for (var k in (preset || {})) i = Object.assign({}, i, preset);
    var houseOpts = '<option value="">Warehouse</option>' + D.houses.map(function (h) {
      return '<option value="' + h.id + '"' + (i.house_id === h.id ? ' selected' : '') + '>' + esc(h.address) + '</option>';
    }).join('');
    var stays = i.id ? D.moves.filter(function (m) { return m.item_id === i.id; }) : [];

    openSheet('<form class="sheet__in" id="itemForm" novalidate>' + sheetTop(i.tag_no ? 'No. ' + i.tag_no : 'New piece', i.title || 'Add a piece') +
      '<input type="hidden" name="id" value="' + esc(i.id) + '">' +
      field('Name', 'title', i.title, { req: true, ph: 'Grey 3-piece sectional' }) +
      '<div class="pair">' + field('Category', 'category', i.category, { ph: 'Sofa, rug, lamp' }) +
        field('Came from', 'source', '', { select: opts(SOURCE, i.source) }) + '</div>' +
      '<div class="pair">' + field('Price tag ($)', 'price', dollars(i.price_cents), { mode: 'decimal' }) +
        field('What it cost you ($)', 'cost', dollars(i.cost_cents), { mode: 'decimal', hint: 'Never shown to buyers.' }) + '</div>' +
      '<div class="photo"><div class="photo__box" id="photoBox">' + thumb(i, 'photo__img') + '</div><div class="photo__side">' +
        field('Photo link', 'photo_url', i.photo_url, { ph: 'https://' }) +
        '<label class="btn btn--ghost btn--file">Take or choose a photo<input type="file" id="photoFile" accept="image/*" capture="environment"></label></div></div>' +
      field('Details for buyers', 'details', i.details, { area: true, hint: 'Size, finish, condition. Printed on the buyer page.' }) +
      '<div class="pair">' + field('Store handle, SKU or lot number', 'source_ref', i.source_ref) +
        field('Product page link', 'source_url', i.source_url, { type: 'url', ph: 'https://' }) + '</div>' +
      '<div class="pair">' + field('Where it is', 'house_id', '', { select: houseOpts }) + field('Room', 'room', i.room, { list: 'sheetRooms' }) + '</div>' +
      field('Status', 'status', '', { select: opts(STATUS, i.status) }) +
      '<div class="soldbox" id="soldBox"' + (i.status === 'sold' ? '' : ' hidden') + '><div class="pair">' +
        field('Sold for ($)', 'sold', dollars(i.sold_cents != null ? i.sold_cents : i.price_cents), { mode: 'decimal' }) +
        field('Sold to', 'sold_to', i.sold_to) + '</div></div>' +
      field('Office note', 'notes', i.notes, { area: true }) +
      (stays.length ? '<div class="stays"><h3>Where it has been</h3><ul>' + stays.map(function (m) {
          var h = house(m.house_id);
          return '<li>' + esc(h ? h.address : 'A deleted house') + (m.room ? ', ' + esc(m.room) : '') + ' <span>' + fmtDate(m.placed_at) + ' to ' +
            (m.removed_at ? fmtDate(m.removed_at) : 'now') + '</span></li>';
        }).join('') + '</ul></div>' : '') +
      '<datalist id="sheetRooms">' + ROOMS.map(function (r) { return '<option value="' + r + '">'; }).join('') + '</datalist>' +
      '<p class="sheet__err" role="alert"></p>' +
      '<div class="sheet__acts"><button class="btn" type="submit">Save piece</button>' +
      (i.id ? '<button class="linkbtn linkbtn--bad" type="button" data-act="del-item" data-id="' + i.id + '">Delete piece</button>' : '') + '</div></form>');
  }

  /* Shrink a phone photo before it is stored: a 12 MP original is wasted on a list. */
  function shrink(file, max) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not read that photo.')); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this browser can read.')); };
      img.src = url;
    });
  }

  /* ---------- add from the store ---------- */
  function openStore() {
    openSheet('<div class="sheet__in">' + sheetTop('Hughes Living Co.', 'Add a piece from the store') +
      (D.catalog_count
        ? '<div class="field"><label for="catQ">Search ' + D.catalog_count + ' store products</label><input id="catQ" type="search" placeholder="Name, SKU or handle" autocomplete="off"></div>' +
          '<div class="picks" id="catOut"><p class="hint">Type at least two letters.</p></div>'
        : '<p>The store catalog has not been loaded yet. Export your products from Shopify (Products &rarr; Export &rarr; All products, plain CSV) and choose the file here. Prices, costs and photos come across, so a piece can be added by name.</p>') +
      '<div class="catload"><label class="btn btn--ghost btn--file">' + (D.catalog_count ? 'Reload from a newer Shopify export' : 'Choose the Shopify export CSV') +
        '<input type="file" id="catFile" accept=".csv,text/csv"></label><p class="hint" id="catMsg">Costs stay in the office. They are never sent to the buyer page.</p></div></div>');
  }

  /* Shopify's export: one row per variant and per extra image; the title is
     only on a product's first row, quoted fields may hold commas and newlines. */
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, i = 0, c;
    if (text.charCodeAt(0) === 0xFEFF) i = 1;
    for (; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function catalogFromCsv(text) {
    var rows = parseCsv(text), head = rows.shift() || [];
    var col = function (name) { return head.indexOf(name); };
    var C = { handle: col('Handle'), title: col('Title'), type: col('Type'), o1: col('Option1 Value'), o2: col('Option2 Value'),
              sku: col('Variant SKU'), price: col('Variant Price'), cost: col('Cost per item'), img: col('Image Src'),
              vimg: col('Variant Image'), status: col('Status') };
    if (C.handle < 0 || C.title < 0 || C.price < 0) throw new Error('That does not look like a Shopify product export (no Handle, Title or Variant Price column).');
    var out = [], cur = null;
    rows.forEach(function (r) {
      var handle = r[C.handle];
      if (!handle) return;
      if (!cur || cur.handle !== handle) cur = { handle: handle, title: '', type: '', img: '', status: '' };
      if (r[C.title]) { cur.title = r[C.title]; cur.type = r[C.type] || ''; cur.status = (C.status >= 0 && r[C.status]) || ''; }
      if (!cur.img && r[C.img]) cur.img = r[C.img];
      if (r[C.price] === '' || r[C.price] == null) return;            // an image-only row
      if (cur.status && cur.status !== 'active') return;
      var variant = [r[C.o1], C.o2 >= 0 ? r[C.o2] : ''].filter(function (v) { return v && v !== 'Default Title'; }).join(' / ');
      out.push({ handle: handle, variant: variant, sku: (r[C.sku] || '').replace(/^'/, ''),
        title: cur.title + (variant ? ' · ' + variant : ''), category: cur.type,
        price_cents: cents(r[C.price]), cost_cents: C.cost >= 0 ? cents(r[C.cost]) : null,
        image_url: (C.vimg >= 0 && r[C.vimg]) || cur.img || '' });
    });
    // a variant row can come before its product's first image row
    var firstImg = {};
    rows.forEach(function (r) { if (r[C.handle] && r[C.img] && !firstImg[r[C.handle]]) firstImg[r[C.handle]] = r[C.img]; });
    out.forEach(function (o) { if (!o.image_url) o.image_url = firstImg[o.handle] || ''; });
    return out;
  }

  /* ---------- add from an auction lot ---------- */
  function openLots() {
    openSheet('<div class="sheet__in">' + sheetTop('Hughes Living Auctions', 'Add a piece from a lot') +
      '<div class="picks" id="lotOut"><p class="hint">Loading lots&hellip;</p></div></div>');
    API.lots().then(function (lots) {
      var out = document.getElementById('lotOut');
      if (!out) return;
      var used = {};
      D.items.forEach(function (i) { if (i.source === 'auction' && i.source_ref) used[i.source_ref] = true; });
      out.innerHTML = lots.length ? lots.map(function (l, k) {
        return '<button class="pick" type="button" data-act="pick-lot" data-k="' + k + '"' + (used[l.lot_no] ? ' disabled' : '') + '>' +
          '<span class="tagno">Lot ' + l.lot_no + '</span><span>' + esc(l.title) + (used[l.lot_no] ? ' <small>already added</small>' : '') + '</span>' +
          '<span class="num">' + esc(l.status) + '</span></button>';
      }).join('') : '<p class="hint">No lots found.</p>';
      out._lots = lots;
    }).catch(function (e) { var o = document.getElementById('lotOut'); if (o) o.innerHTML = '<p class="sheet__err">' + esc(e.message) + '</p>'; });
  }

  /* ================================================================ events */
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT') return;
    var act = el.getAttribute('data-act'), id = Number(el.getAttribute('data-id'));

    if (act === 'close') sheet.close();
    else if (act === 'door') openAuth(el.getAttribute('data-kind'), el.getAttribute('data-mode'));
    else if (act === 'sample') API.sampleSignIn(el.getAttribute('data-kind')).then(boot, function (x) { toast(x.message, true); });
    else if (act === 'new-house') openHouse();
    else if (act === 'edit-house') openHouse(house(id));
    else if (act === 'new-item') openItem();
    else if (act === 'edit-item') openItem(item(id));
    else if (act === 'from-store') openStore();
    else if (act === 'from-lot') openLots();
    else if (act === 'house-status') {
      var h = Object.assign({}, house(id), { status: el.getAttribute('data-v') });
      if (h.status === 'staged' && !h.staged_on) h.staged_on = today();
      if (h.status === 'destaged' && !h.destage_on) h.destage_on = today();
      run(API.saveHouse(h), 'House marked ' + HSTATUS[h.status].toLowerCase() + '.').catch(function () {});
    }
    else if (act === 'send-back') {
      run(API.placeItem(id, null, null), 'Moved out of the house.').catch(function () {});
    }
    else if (act === 'del-item') {
      if (confirm('Delete this piece and its history? This cannot be undone.')) {
        run(API.deleteItem(id), 'Piece deleted.').then(function () { sheet.close(); }, function () {});
      }
    }
    else if (act === 'del-house') {
      if (confirm('Delete this house, its requests and its history? This cannot be undone.')) {
        run(API.deleteHouse(id), 'House deleted.').then(function () { sheet.close(); location.hash = '#houses'; }, function () {});
      }
    }
    else if (act === 'pick-cat') {
      var c = document.getElementById('catOut')._rows[Number(el.getAttribute('data-k'))];
      openItem(null, { title: c.title, category: c.category, source: 'store', source_ref: c.sku || c.handle,
        source_url: CFG.storeUrl + 'products/' + c.handle, photo_url: c.image_url, price_cents: c.price_cents, cost_cents: c.cost_cents });
    }
    else if (act === 'pick-lot') {
      var l = document.getElementById('lotOut')._lots[Number(el.getAttribute('data-k'))];
      openItem(null, { title: l.title.replace(/^Sample lot: /, ''), source: 'auction', source_ref: String(l.lot_no),
        source_url: CFG.auctionUrl + 'lot.html?lot=' + l.lot_no,
        photo_url: l.image_path ? (/^https?:/.test(l.image_path) ? l.image_path : CFG.auctionUrl + l.image_path) : null,
        price_cents: l.retail_cents });
    }
  }

  function onChange(e) {
    var el = e.target, act = el.getAttribute('data-act'), id = Number(el.getAttribute('data-id'));
    if (act === 'item-status') {
      // a sale needs a price and a name, so it goes through the sheet
      if (el.value === 'sold') { openItem(item(id), { status: 'sold' }); el.value = item(id).status; return; }
      run(API.saveItem(Object.assign({}, item(id), { status: el.value })), 'Marked ' + STATUS[el.value].toLowerCase() + '.').catch(function () {});
    }
    else if (act === 'req-status') run(API.setRequest(id, el.value), 'Request updated.').catch(function () {});
    else if (el.id === 'fw') { F.where = el.value; renderFurniture(); }
    else if (el.id === 'fs') { F.status = el.value; renderFurniture(); }
    else if (el.id === 'f_status' && el.form && el.form.getAttribute('id') === 'itemForm') document.getElementById('soldBox').hidden = el.value !== 'sold';
    else if (el.id === 'f_photo_url' || el.id === 'f_cover_url') document.getElementById('photoBox').innerHTML = thumb({ photo_url: el.value }, 'photo__img');
    else if (el.id === 'photoFile' && el.files[0]) {
      var box = document.getElementById('photoBox');
      box.classList.add('is-busy');
      shrink(el.files[0], API.name === 'demo' ? 520 : 1400).then(API.uploadPhoto).then(function (url) {
        (document.getElementById('f_photo_url') || document.getElementById('f_cover_url')).value = url;
        box.innerHTML = thumb({ photo_url: url }, 'photo__img');
      }).catch(function (err) { toast(err.message || 'Could not add that photo.', true); })
        .then(function () { box.classList.remove('is-busy'); el.value = ''; });
    }
    else if (el.id === 'catFile' && el.files[0]) {
      var msg = document.getElementById('catMsg');
      msg.textContent = 'Reading ' + el.files[0].name + '…';
      el.files[0].text().then(function (text) {
        var rows = catalogFromCsv(text);
        if (!rows.length) throw new Error('No priced, active products found in that file.');
        msg.textContent = 'Loading ' + rows.length + ' products…';
        return API.catalogImport(rows, true).then(function () { return rows.length; });
      }).then(function (n) {
        return reload().then(function () { toast(n + ' store products loaded.'); openStore(); });
      }).catch(function (err) { msg.textContent = err.message || 'Could not read that file.'; msg.className = 'sheet__err'; });
    }
  }

  var searchTimer;
  function onInput(e) {
    var el = e.target;
    if (el.id === 'fq') {
      F.q = el.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        renderFurniture();
        var again = document.getElementById('fq');
        again.focus(); again.setSelectionRange(again.value.length, again.value.length);
      }, 180);
    } else if (el.id === 'catQ') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var out = document.getElementById('catOut');
        if (el.value.trim().length < 2) { out.innerHTML = '<p class="hint">Type at least two letters.</p>'; return; }
        API.catalogSearch(el.value).then(function (rows) {
          out._rows = rows;
          out.innerHTML = rows.length ? rows.map(function (c, k) {
            return '<button class="pick" type="button" data-act="pick-cat" data-k="' + k + '">' + thumb({ photo_url: c.image_url }, 'thumb thumb--sm') +
              '<span>' + esc(c.title) + '<small>' + esc(c.sku || c.handle) + '</small></span><span class="num">' + money(c.price_cents, '') + '</span></button>';
          }).join('') : '<p class="hint">Nothing in the store matches that.</p>';
        }).catch(function (err) { out.innerHTML = '<p class="sheet__err">' + esc(err.message) + '</p>'; });
      }, 220);
    }
  }

  function onSubmit(e) {
    var form = e.target, fid = form.getAttribute('id');   // form.id would be the hidden input named id
    e.preventDefault();
    var f = formData(form), err = form.querySelector('.sheet__err');
    var btn = form.querySelector('[type=submit]');
    var busy = function (on) { if (btn) btn.disabled = on; };

    if (fid === 'houseForm') {
      if (!f.address.trim()) { err.textContent = 'A house needs an address.'; return; }
      var old = f.id ? house(Number(f.id)) : {};
      var h = Object.assign({}, old, f, { id: f.id ? Number(f.id) : null, fee_cents: cents(f.fee) || 0 });
      delete h.fee;
      busy(true);
      run(API.saveHouse(h), 'House saved.').then(function (saved) {
        sheet.close();
        if (!f.id && saved && saved.id) location.hash = '#house/' + saved.id;
      }, function (x) { err.textContent = x.message; }).then(function () { busy(false); });
    }
    else if (fid === 'itemForm') {
      if (!f.title.trim()) { err.textContent = 'A piece needs a name.'; return; }
      var prev = f.id ? item(Number(f.id)) : {};
      var i = Object.assign({}, prev, f, {
        id: f.id ? Number(f.id) : null, house_id: f.house_id ? Number(f.house_id) : null,
        price_cents: cents(f.price), cost_cents: cents(f.cost), sold_cents: f.status === 'sold' ? cents(f.sold) : null
      });
      delete i.price; delete i.cost; delete i.sold;
      busy(true);
      run(API.saveItem(i), 'Piece saved.').then(function () { sheet.close(); },
        function (x) { err.textContent = x.message; }).then(function () { busy(false); });
    }
    else if (fid === 'placeForm') {
      var hid = Number(location.hash.split('/')[1]);
      var picks = Array.prototype.filter.call(form.querySelectorAll('[name=pick]'), function (c) { return c.checked; });
      if (!picks.length) { toast('Tick the pieces to place first.', true); return; }
      busy(true);
      // one at a time so each piece gets its own stay in the history
      var chain = picks.reduce(function (p, c) {
        return p.then(function () { return API.placeItem(Number(c.value), hid, f.room); });
      }, Promise.resolve());
      run(chain, picks.length + ' piece' + (picks.length > 1 ? 's' : '') + ' placed.').catch(function () {}).then(function () { busy(false); });
    }
    else if (fid === 'authForm') {
      busy(true); err.textContent = '';
      var go = f.mode === 'finish' ? API.register(f)
        : f.mode === 'up' ? API.signUp(f)
        : API.signIn((f.email || '').trim(), f.password);
      go.then(function () { sheet.close(); return boot(); })
        .catch(function (x) { err.textContent = x.message || 'Could not sign in.'; })
        .then(function () { busy(false); });
    }
  }

  /* ================================================================ routing */
  function route() {
    var parts = (location.hash || '#houses').slice(1).split('/');
    if (!ME.staff && (parts[0] === 'money' || parts[0] === 'accounts')) parts = ['houses'];   // nothing to show a customer there
    var tab = parts[0] === 'house' ? 'houses' : parts[0];
    Array.prototype.forEach.call(document.querySelectorAll('#tabs a'), function (a) {
      a.hidden = a.hasAttribute('data-staff') && !ME.staff;
      a.getAttribute('data-tab') === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    var n = D.requests.filter(function (r) { return r.status === 'new'; }).length;
    var badge = document.getElementById('reqCount');
    badge.hidden = !n; badge.textContent = n;

    if (parts[0] === 'house') renderHouse(Number(parts[1]));
    else if (parts[0] === 'furniture') renderFurniture();
    else if (parts[0] === 'requests') renderRequests();
    else if (parts[0] === 'money') renderMoney();
    else if (parts[0] === 'accounts') renderAccounts();
    else renderHouses();
  }

  /* The front door: two kinds of customer, and a quiet line for staff. */
  function doorView() {
    var demo = API.name === 'demo';
    var kind = function (k, h, p) {
      return '<section class="kind"><h2>' + h + '</h2><p>' + p + '</p><div class="kind__acts">' +
        '<button class="btn" type="button" data-act="door" data-kind="' + k + '" data-mode="in">Sign in</button>' +
        '<button class="btn btn--ghost" type="button" data-act="door" data-kind="' + k + '" data-mode="up">Create an account</button></div>' +
        (demo ? '<button class="linkbtn" type="button" data-act="sample" data-kind="' + k + '">Look around with the sample account</button>' : '') + '</section>';
    };
    var room = function (file, name) {
      return '<figure class="rooms3__f"><img src="img/looks/' + file + '.webp" alt="A staged ' + name.toLowerCase() + '" loading="lazy" width="640" height="800">' +
        '<figcaption>' + name + '</figcaption></figure>';
    };
    view.innerHTML = '<div class="door">' +
      '<div class="door__top"><div><p class="eyebrow">Sign in</p>' +
      '<h1 class="title">Stage a home with Hughes Living <em>furniture</em></h1>' +
      '<p class="sub">Choose pieces, place them room by room, and print one QR code for the house. Buyers scan it to see what is for sale.</p></div>' +
      '<img class="door__img" src="img/looks/look-open-plan.webp" alt="A staged open-plan living and dining room" width="1381" height="777"></div>' +
      '<div class="kinds">' +
        kind('self', 'Staging it myself', 'For a homeowner or an agent getting a house ready to sell.') +
        kind('designer', 'Interior designer', 'For designers staging for clients, with several houses going at once.') +
      '</div>' +
      '<p class="door__staff">Hughes Living staff: <button class="linkbtn" type="button" data-act="door" data-kind="owner" data-mode="in">sign in to the office</button>' +
        (demo ? ' or <button class="linkbtn" type="button" data-act="sample" data-kind="owner">open the sample office</button>' : '') + '</p>' +
      '<div class="rooms3">' + room('room-living', 'Living room') + room('room-dining', 'Dining room') + room('room-bedroom', 'Bedroom') + '</div></div>';
  }

  /* Signed in, but not yet a staging customer (an auction bidder, say). */
  function finishView() {
    view.innerHTML = '<div class="door"><p class="eyebrow">One more step</p><h1 class="title">How will you be <em>staging?</em></h1>' +
      '<p class="sub">You are signed in as ' + esc(ME.email) + '. Pick one to finish your staging account.</p>' +
      '<div class="kind__acts" style="margin-top:1.4rem">' +
      '<button class="btn" type="button" data-act="door" data-kind="self" data-mode="finish">Staging it myself</button>' +
      '<button class="btn" type="button" data-act="door" data-kind="designer" data-mode="finish">Interior designer</button></div></div>';
  }

  function boot() {
    return API.session().then(function (s) {
      ME = s;
      var who = document.getElementById('who');
      document.getElementById('tabs').hidden = !s.kind;
      document.getElementById('signOut').hidden = !s.signedIn;
      who.hidden = !s.kind;
      who.textContent = s.kind ? (s.studio || s.name || s.email) + ' · ' + KIND[s.kind] : '';
      document.querySelector('.mark__role').textContent = s.kind && !s.staff ? KIND[s.kind] : 'Office';
      if (!s.signedIn) return doorView();
      if (!s.kind) return finishView();
      return reload();
    }).catch(function (e) {
      view.innerHTML = '<div class="door"><p class="eyebrow">Hughes Living Staging</p><h1 class="title">This page could not <em>open</em></h1><p class="sheet__err">' +
        esc(e.message || 'Something went wrong.') + '</p></div>';
    });
  }

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
  window.addEventListener('hashchange', function () { if (ME.kind) route(); window.scrollTo(0, 0); });
  document.getElementById('signOut').addEventListener('click', function () {
    API.signOut().then(function () { location.hash = '#houses'; return boot(); });
  });
  document.getElementById('demoNote').hidden = API.name !== 'demo';

  boot();
})();

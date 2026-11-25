/* Hughes Living Staging — the office, and the customer side of it.

   Three kinds of people sign in here:
     owner     Hughes Living staff: everything, including cost and Money
     self      someone staging their own house
     designer  an interior designer staging for clients
     realtor   an agent staging their listings
   Customers see only their own houses and never a cost. That is decided by
   the data layer (api.js / the database), not by this file: a customer's rows
   arrive already filtered, and this file only chooses which controls to draw.

   Screens over one small dataset: Home (a customer's dashboard, one per kind
   of account), Houses, Furniture, Requests, Services, Money, Accounts.
   Everything is loaded in one call (api.office) and re-read after every save,
   so what is on screen is always what the database holds. All arithmetic
   (days out, floor value, profit per house) is done here from those rows. */

(function () {
  'use strict';

  var API = window.HLS_API, CFG = window.HLS_CONFIG;
  var esc = window.HLS.esc, money = window.HLS.money, safeUrl = window.HLS.safeUrl;

  var D = { houses: [], items: [], requests: [], moves: [], accounts: [], services: [], catalog_count: 0 };
  var ME = { signedIn: false, kind: null, staff: false };     // who is signed in
  var KIND = { owner: 'Hughes Living staff', self: 'Staging it myself', designer: 'Interior designer', realtor: 'Realtor' };
  // what each kind calls its business, and the houses it looks after
  var TRADE = { designer: 'Studio or business name', realtor: 'Brokerage' };
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
  var CREDIT = Number(CFG.saleCreditPct) || 0;    // percent of a sale that comes off the staging fee

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
    var credit = h.account_id != null ? Math.round(sales * CREDIT / 100) : 0, applied = Math.min(credit, h.fee_cents || 0);
    var end = h.status === 'destaged' && h.destage_on ? new Date(h.destage_on + 'T12:00:00') : new Date();
    return {
      pieces: here.length, floor: sum(live, 'price_cents'), floorCost: sum(live, 'cost_cents'),
      soldN: sold.length, sales: sales, cogs: cogs,
      // the sales credit: earned on every sale from an account's house, applied up to the fee
      credit: credit, applied: applied, net: (h.fee_cents || 0) - applied,
      profit: (h.fee_cents || 0) - applied + sales - cogs,
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
    return API.office().then(function (d) { d.accounts = d.accounts || []; d.services = d.services || []; D = d; route(); });
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
      : ME.kind === 'designer' ? 'Your clients&rsquo; <em>houses</em>'
      : ME.kind === 'realtor' ? 'Your <em>listings</em>' : 'Your <em>house</em>';
    var none = ME.staff ? 'No houses yet. Add the first one, then place furniture in it from the Furniture tab or the house page.'
      : 'Add the house you are staging. Then choose Hughes Living furniture for it, room by room.';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Houses</p><h1 class="title">' + title + '</h1></div>' +
      '<button class="btn" type="button" data-act="new-house">Add a house</button></div>' +
      officeStart() +
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
        }).join('') +
        (h.status !== 'destaged' && missingIn(r, rooms[r]).length
          ? '<p class="room__hint">Usually also in this room: ' + esc(missingIn(r, rooms[r]).join(', ').toLowerCase()) + '. <a href="#guide/kit">What each room needs</a></p>' : '') +
        '</section>';
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
                       : (ME.kind !== 'self' ? [h.client_name, h.client_phone, h.client_email].filter(Boolean).join(' · ') || 'No client on file' : '');

    view.innerHTML =
      '<p class="crumb"><a href="#houses">&larr; ' + (ME.kind === 'realtor' ? 'All listings' : ME.kind === 'designer' ? 'All projects' : 'All houses') + '</a></p>' +
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
        (CREDIT && h.account_id != null
          ? '<div><dt>Sales credit, ' + CREDIT + '%</dt><dd>' + money(s.credit, '$0') + '</dd></div>' +
            (h.fee_cents ? '<div><dt>Fee after credit</dt><dd>' + money(s.net, '$0') + '</dd></div>' : '') : '') +
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
    var t = { fee: 0, sales: 0, cogs: 0, profit: 0, n: 0, credit: 0 };
    var rows = D.houses.map(function (h) {
      var s = stats(h);
      t.fee += h.fee_cents || 0; t.sales += s.sales; t.cogs += s.cogs; t.profit += s.profit; t.n += s.soldN; t.credit += s.applied;
      return '<tr><td><a href="#house/' + h.id + '">' + esc(h.address) + '</a><small>' + HSTATUS[h.status] + '</small></td>' +
        '<td class="num">' + money(h.fee_cents, '$0') + '</td><td class="num">' + s.soldN + '</td>' +
        '<td class="num">' + money(s.sales, '$0') + '</td><td class="num">' + money(s.cogs, '$0') + '</td>' +
        '<td class="num">' + (s.applied ? '&minus;' + money(s.applied) : '–') + (s.credit > s.applied ? '<small>' + money(s.credit) + ' earned</small>' : '') + '</td>' +
        '<td class="num"><strong>' + money(s.profit, '$0') + '</strong></td></tr>';
    }).join('');
    var loose = D.items.filter(function (i) { return i.status === 'sold' && i.sold_house_id == null; });
    if (loose.length) {
      var ls = sum(loose, 'sold_cents'), lc = sum(loose, 'cost_cents');
      t.sales += ls; t.cogs += lc; t.profit += ls - lc; t.n += loose.length;
      rows += '<tr><td>Sold from the warehouse</td><td class="num">–</td><td class="num">' + loose.length + '</td>' +
        '<td class="num">' + money(ls, '$0') + '</td><td class="num">' + money(lc, '$0') + '</td><td class="num">–</td><td class="num"><strong>' + money(ls - lc, '$0') + '</strong></td></tr>';
    }
    var out = D.items.filter(function (i) { return i.house_id != null && i.status !== 'sold' && i.status !== 'retired'; });
    var noCost = D.items.filter(function (i) { return i.status === 'sold' && i.cost_cents == null; }).length;

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Money</p><h1 class="title">What each house <em>made</em></h1></div></div>' +
      '<div class="tablewrap"><table class="grid grid--money"><thead><tr><th>House</th><th class="num">Staging fee</th><th class="num">Pieces sold</th>' +
        '<th class="num">Sales</th><th class="num">Cost of those pieces</th><th class="num">Sales credit</th><th class="num">Profit</th></tr></thead><tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td>Total</td><td class="num">' + money(t.fee, '$0') + '</td><td class="num">' + t.n + '</td><td class="num">' + money(t.sales, '$0') +
        '</td><td class="num">' + money(t.cogs, '$0') + '</td><td class="num">' + (t.credit ? '&minus;' + money(t.credit) : '–') + '</td><td class="num"><strong>' + money(t.profit, '$0') + '</strong></td></tr></tfoot></table></div>' +
      '<p class="fine">Profit = staging fee + sales &minus; what the sold pieces cost &minus; the sales credit. It leaves out the truck, labor, storage and sales tax.' +
        (CREDIT ? ' The sales credit is ' + CREDIT + '% of each sale from a customer account&rsquo;s house, taken off that house&rsquo;s fee and never more than the fee.' : '') +
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
        '<th class="num">Houses</th><th class="num">Pieces out</th><th class="num">Credit earned</th><th>Since</th></tr></thead><tbody>' +
        D.accounts.map(function (a) {
          var hs = D.houses.filter(function (h) { return String(h.account_id) === String(a.id); });
          var out = hs.reduce(function (t, h) { return t + inHouse(h.id).filter(function (i) { return i.status !== 'sold'; }).length; }, 0);
          return '<tr><td><strong>' + esc(a.name) + '</strong>' + (a.studio ? '<small>' + esc(a.studio) + '</small>' : '') + '</td>' +
            '<td>' + chip(a.kind === 'self' ? 'available' : 'hold', KIND[a.kind]) + '</td>' +
            '<td>' + (a.email ? '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>' : '') + (a.phone ? '<small>' + esc(a.phone) + '</small>' : '') + '</td>' +
            '<td class="num">' + hs.length + '</td><td class="num">' + out + '</td>' +
            '<td class="num">' + money(hs.reduce(function (t, h) { return t + stats(h).credit; }, 0), '$0') + '</td><td>' + fmtDate(a.created_at) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="empty">No customer accounts yet. Homeowners, interior designers and realtors create their own from the sign-in page.</p>') +
      '<p class="fine">To hand a house to an account, open the house, choose Edit, and set &ldquo;Staged by&rdquo;.</p>';
  }

  /* ============================================================ dashboards
     What a customer lands on. One screen per kind of account, because the three
     are doing different jobs: a homeowner is walking one house through a short
     list of steps, a designer is juggling several client projects and their
     dates, and a realtor wants to know which listings have a live QR code and
     who has scanned it. All three are drawn from the same rows as the other
     tabs; nothing here is stored. */
  var HOUSEWORD = { self: 'My house', designer: 'Projects', realtor: 'Listings' };
  var SSTATUS = { 'new': 'Requested', scheduled: 'Scheduled', done: 'Done', cancelled: 'Cancelled' };
  var CARPET = (CFG.services || {}).carpet;

  var shortDate = function (s) { return fmtDate(s).replace(/, \d{4}$/, ''); };
  function daysTo(s) {
    return s ? Math.round((new Date(s + 'T12:00:00') - new Date(today() + 'T12:00:00')) / DAY) : null;
  }
  function inDays(n) {
    return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? 'in ' + n + ' days' : -n + ' days ago';
  }
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  function roomsOf(h) {
    var by = {};
    inHouse(h.id).forEach(function (i) { (by[i.room || 'No room set'] = by[i.room || 'No room set'] || []).push(i); });
    return Object.keys(by).sort().map(function (r) { return { name: r, items: by[r] }; });
  }
  function freePieces() { return D.items.filter(function (i) { return i.house_id == null && i.status === 'available'; }); }

  /* What a house still needs from the person signed in, most pressing first. */
  function nudges(h) {
    var s = stats(h), out = [], to = daysTo(h.destage_on);
    var open = { href: '#house/' + h.id };
    if (h.status === 'planned') {
      if (!s.pieces) out.push({ t: 'No furniture chosen yet', href: open.href, label: 'Choose furniture' });
      else {
        if (!h.staged_on) out.push({ t: 'No day set for the furniture to go in', act: 'edit-house', label: 'Set the day' });
        out.push({ t: 'Mark it staged once the furniture is in. That opens the QR page', href: open.href, label: 'Open' });
      }
    }
    if (h.status === 'staged') {
      if (to != null && to < 0) out.push({ t: 'The furniture was due out ' + inDays(to), href: open.href, label: 'Open' });
      else if (to != null && to <= 7) out.push({ t: 'The furniture comes out ' + inDays(to), href: open.href, label: 'Open' });
      if (!h.destage_on) out.push({ t: 'No date set for the furniture to come out', act: 'edit-house', label: 'Set the date' });
      if (!h.cover_url) out.push({ t: 'No cover photo on the buyer page', act: 'edit-house', label: 'Add one' });
    }
    if (ME.kind === 'realtor' && h.status !== 'destaged' && !h.listing_url) out.push({ t: 'No listing link', act: 'edit-house', label: 'Add it' });
    return out;
  }
  function doIt(h, n) {
    return n.href ? '<a href="' + n.href + '">' + esc(n.label) + '</a>'
      : '<button class="linkbtn" type="button" data-act="' + n.act + '" data-id="' + h.id + '">' + esc(n.label) + '</button>';
  }
  function todoList(houses) {
    var rows = [];
    houses.forEach(function (h) {
      nudges(h).forEach(function (n) {
        rows.push('<li><span><strong>' + esc(h.address) + '</strong>' + esc(n.t) + '</span>' + doIt(h, n) + '</li>');
      });
    });
    return rows.length ? '<ul class="todo">' + rows.join('') + '</ul>' : '<p class="empty">Nothing waiting on you.</p>';
  }

  /* Buyers' orders and questions, one line each. No phone or email: the data
     layer never sends those to a customer. */
  function feed(rows, showHouse, none) {
    if (!rows.length) return '<p class="empty">' + none + '</p>';
    return '<ul class="feed">' + rows.map(function (r) {
      var h = house(r.house_id);
      var what = r.kind === 'look' ? 'wants the whole look, ' + plural(r.piece_count, 'piece')
        : r.kind === 'question' ? (r.item_title ? 'asked about the ' + r.item_title : 'asked a question')
        : 'wants the ' + r.item_title;
      return '<li><time>' + shortDate(r.created_at) + '</time><span><strong>' + esc(r.name) + '</strong> ' + esc(what) +
        (showHouse && h ? '<small>' + esc(h.address) + '</small>' : '') + '</span>' +
        chip(r.status === 'new' ? 'new' : 'hold', RSTATUS[r.status]) + '</li>';
    }).join('') + '</ul>' +
    '<p class="fine">Hughes Living follows up with each buyer and takes the payment. <a href="#requests">All requests</a></p>';
  }

  function svcBand(line, moveLine) {
    var mv = (CFG.services || {}).move;
    return (CARPET && line ? '<aside class="svc"><div><p class="eyebrow">Service</p><h2 class="svc__h">' + line + '</h2>' +
      '<p>' + esc(CARPET.name) + '. First room ' + money(CARPET.firstRoomCents) + ', each room after that ' + money(CARPET.extraRoomCents) + '.</p></div>' +
      '<a class="btn btn--ghost" href="#services/carpet">Request a cleaning</a></aside>' : '') +
      (mv && moveLine ? '<aside class="svc svc--2"><div><p class="eyebrow">Service</p><h2 class="svc__h">' + moveLine + '</h2>' +
      '<p>' + esc(mv.name) + '. Totes from ' + money(mv.toteTiers[0].cents) + ' each a week, crews from ' + money(mv.truckHourlyCents['16ft']) + ' an hour.</p></div>' +
      '<a class="btn btn--ghost" href="#services/move">Request totes or a crew</a></aside>' : '');
  }
  function qrActs(h) {
    var code = encodeURIComponent(h.code);
    return '<a class="btn" href="card.html?h=' + code + '" target="_blank" rel="noopener">QR card &amp; tags</a>' +
      (h.status === 'staged'
        ? '<a class="btn btn--ghost" href="house.html?h=' + code + '" target="_blank" rel="noopener">Buyer page</a>' +
          '<button class="btn btn--ghost" type="button" data-act="copy-link" data-code="' + esc(h.code) + '">Copy buyer link</button>' : '');
  }

  /* ---------- staging it myself: one house, a short list of steps ---------- */
  function renderHomeSelf() {
    var h = D.houses.filter(function (x) { return x.status !== 'destaged'; })[0] || D.houses[0];
    var s = h ? stats(h) : null, rooms = h ? roomsOf(h) : [];
    var cleaning = h && D.services.filter(function (v) { return v.house_id === h.id && v.status !== 'cancelled' && (v.service || 'carpet') === 'carpet'; })[0];
    var out = h ? daysTo(h.destage_on) : null;
    var hid = h ? h.id : '';

    var steps = [
      { t: 'Add your house', done: !!h,
        d: h ? esc(h.address) + (h.city ? ', ' + esc(h.city) : '') : 'The address, and the dates if you know them.',
        a: '<button class="btn" type="button" data-act="new-house">Add your house</button>' },
      { t: 'Choose your furniture', done: !!h && s.pieces > 0,
        d: h && s.pieces ? plural(s.pieces, 'piece') + ' in ' + plural(rooms.length, 'room') + ', ' + money(s.floor, '$0') + ' at tag price.'
          : plural(freePieces().length, 'piece') + ' free in the Hughes Living warehouse right now.',
        a: '<a class="btn" href="#house/' + hid + '">Choose furniture</a>',
        more: h && s.pieces ? '<a href="#house/' + hid + '">Change the furniture</a>' : '' },
      { t: 'Get the carpets cleaned', opt: true, done: !!cleaning, s: cleaning ? SSTATUS[cleaning.status] : '',
        d: cleaning ? SSTATUS[cleaning.status] + (cleaning.preferred_on ? ', asked for ' + shortDate(cleaning.preferred_on) : '') + '. ' + money(cleaning.estimate_cents) + ' estimate.'
          : 'Before the furniture goes in. ' + (CARPET ? 'First room ' + money(CARPET.firstRoomCents) + ' with ' + esc(CARPET.name) + '.' : ''),
        more: h ? '<a href="#services/carpet">' + (cleaning ? 'See the request' : 'Request a cleaning') + '</a>' : '' },
      { t: 'Staging fee', wait: true, done: !!h && h.fee_cents > 0, s: h && h.fee_cents ? 'Set' : '',
        d: (h && h.fee_cents ? money(h.fee_cents) + ', set by Hughes Living.' : 'Hughes Living sets this. Not set yet.') +
          (!CREDIT ? '' : h && s.credit ? ' Less ' + money(s.applied, '$0') + ' credit from sales: ' + money(s.net, '$0') + ' to pay.'
            : ' ' + CREDIT + '% of every piece that sells from your house comes off it.') },
      { t: 'Mark the house staged', done: !!h && h.status !== 'planned',
        d: h && h.status !== 'planned' ? 'Staged ' + (h.staged_on ? shortDate(h.staged_on) : '') + '. The QR code is ' + (h.status === 'staged' ? 'live.' : 'closed.')
          : 'Once the furniture is in. That opens the page buyers see when they scan the QR code.',
        a: '<button class="btn" type="button" data-act="house-status" data-id="' + hid + '" data-v="staged">Mark it staged</button>' },
      { t: 'The furniture comes out', done: !!h && h.status === 'destaged',
        d: h && h.destage_on ? shortDate(h.destage_on) + (h.status === 'staged' ? ', ' + inDays(out) + '.' : '.') : 'No date set yet.',
        a: h && !h.destage_on ? '<button class="btn" type="button" data-act="edit-house" data-id="' + hid + '">Set the date</button>'
          : '<button class="btn btn--ghost" type="button" data-act="house-status" data-id="' + hid + '" data-v="destaged">Mark it destaged</button>' }
    ];
    var next = -1;
    steps.forEach(function (st, k) { if (next < 0 && !st.done && !st.opt && !st.wait) next = k; });

    var stepHtml = '<ol class="steps">' + steps.map(function (st, k) {
      var state = st.done ? 'done' : k === next ? 'next' : 'later';
      var label = st.s ? st.s : st.done ? 'Done' : k === next ? 'Next' : st.opt ? 'Optional' : st.wait ? 'Hughes Living' : '';
      return '<li class="step step--' + state + '"><span class="step__n" aria-hidden="true">' + (st.done ? '&#10003;' : k + 1) + '</span>' +
        '<div class="step__b"><h2 class="step__t">' + st.t + (label ? ' <span class="step__s">' + label + '</span>' : '') + '</h2>' +
        '<p>' + st.d + '</p>' +
        (k === next && st.a ? '<p class="step__a">' + st.a + '</p>' : (st.more && (h || k === 0) ? '<p class="step__a">' + st.more + '</p>' : '')) +
        '</div></li>';
    }).join('') + '</ol>';

    var title = !h ? 'Let&rsquo;s get your house <em>ready</em>'
      : h.status === 'staged' ? 'Your house is <em>staged</em>'
      : h.status === 'destaged' ? 'Your staging has <em>ended</em>' : 'Getting your house <em>ready</em>';

    var side = !h
      ? '<img class="dash__img" src="img/looks/room-living.webp" alt="A staged living room" width="640" height="800" loading="lazy">' +
        '<p class="fine">A style example, not a real staging.</p>'
      : (safeUrl(h.cover_url) ? '<img class="dash__img dash__img--wide" src="' + esc(safeUrl(h.cover_url)) + '" alt="Cover photo of ' + esc(h.address) + '" loading="lazy">' : '') +
        '<dl class="facts facts--2">' +
          '<div><dt>Pieces here</dt><dd>' + s.pieces + '</dd></div>' +
          '<div><dt>At tag price</dt><dd>' + money(s.floor, '$0') + '</dd></div>' +
          '<div><dt>Sold from here</dt><dd>' + money(s.sales, '$0') + ' <small>' + s.soldN + ' pc</small></dd></div>' +
          '<div><dt>Staged</dt><dd>' + (s.days != null && h.status !== 'planned' ? s.days + ' <small>days</small>' : 'Not yet') + '</dd></div>' +
        '</dl>' +
        (h.status !== 'planned' ? '<div class="head__acts dash__acts">' + qrActs(h) + '</div>' : '') +
        '<h2 class="h2">Buyers</h2>' +
        feed(D.requests.filter(function (r) { return r.house_id === h.id; }).slice(0, 4), false,
          'Nobody yet. When a buyer scans the QR code and taps &ldquo;Buy this piece&rdquo;, it shows here.');

    var roomHtml = rooms.length ? '<h2 class="h2">Room by room</h2><div class="roomsum">' + rooms.map(function (r) {
      return '<a class="roomsum__r" href="#house/' + h.id + '"><span class="roomsum__n">' + esc(r.name) + '</span>' +
        '<span class="roomsum__t">' + r.items.slice(0, 5).map(function (i) { return thumb(i, 'thumb thumb--sm'); }).join('') + '</span>' +
        '<span class="num">' + plural(r.items.length, 'piece') + '</span>' +
        '<span class="num">' + money(sum(r.items.filter(function (i) { return i.status !== 'sold'; }), 'price_cents'), '$0') + '</span></a>';
    }).join('') + '</div>' : '';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">' + (h ? esc(h.address) : 'Staging it myself') + '</p><h1 class="title">' + title + '</h1>' +
        (D.houses.length > 1 ? '<p class="sub">You have ' + D.houses.length + ' houses. <a href="#houses">See them all</a></p>' : '') + '</div>' +
        (h ? '<div class="head__acts"><a class="btn btn--ghost" href="#house/' + h.id + '">Open the house</a></div>' : '') + '</div>' +
      '<div class="dash"><div>' + stepHtml + '</div><aside>' + side + '</aside></div>' +
      roomHtml +
      tipBox(topicForHouse(h), h ? 'for where your house is now' : 'before you start') +
      svcBand('', 'Totes and a crew to clear the house out first');
  }

  /* ---------- interior designer: several client projects and their dates ---------- */
  function renderHomeDesigner() {
    var staged = D.houses.filter(function (h) { return h.status === 'staged'; });
    var live = D.houses.filter(function (h) { return h.status !== 'destaged'; });
    var out = D.items.filter(function (i) { return i.house_id != null && i.status !== 'sold' && i.status !== 'retired'; });
    var free = freePieces();

    var card = function (h) {
      var s = stats(h), n = nudges(h)[0], to = daysTo(h.destage_on), go = daysTo(h.staged_on);
      var date = h.status === 'planned' ? (h.staged_on ? 'Goes in ' + shortDate(h.staged_on) + ', ' + inDays(go) : 'No go-in day set')
        : h.status === 'staged' ? (h.destage_on ? 'Comes out ' + shortDate(h.destage_on) + ', ' + inDays(to) : 'Staged ' + plural(s.days, 'day'))
        : 'Came out ' + (h.destage_on ? shortDate(h.destage_on) : '');
      return '<a class="pcard" href="#house/' + h.id + '">' + thumb({ photo_url: h.cover_url }, 'pcard__img') +
        '<strong>' + esc(h.address) + '</strong>' +
        '<small>' + esc([h.client_name, h.city].filter(Boolean).join(' · ') || 'No client on file') + '</small>' +
        '<span class="pcard__m">' + plural(s.pieces, 'piece') + ' · ' + plural(roomsOf(h).length, 'room') + ' · ' + money(s.floor, '$0') + '</span>' +
        '<span class="pcard__d">' + esc(date) + '</span>' +
        (s.newReq ? '<span class="pcard__d pcard__d--flag">' + plural(s.newReq, 'new buyer request') + '</span>' : '') +
        (n ? '<span class="pcard__n">' + esc(n.t) + '</span>' : '') + '</a>';
    };
    var col = function (k, none) {
      var hs = D.houses.filter(function (h) { return h.status === k; });
      return '<section class="board__c"><h2 class="board__h">' + HSTATUS[k] + ' <span>' + hs.length + '</span></h2>' +
        (hs.length ? hs.map(card).join('') : '<p class="board__none">' + none + '</p>') + '</section>';
    };

    // dated things in the next six weeks, plus anything overdue
    var ev = [];
    D.houses.forEach(function (h) {
      if (h.status === 'planned' && h.staged_on) ev.push({ on: h.staged_on, t: 'Furniture goes in', h: h });
      if (h.status === 'staged' && h.destage_on) ev.push({ on: h.destage_on, t: 'Furniture comes out', h: h });
    });
    D.services.forEach(function (v) {
      var h = house(v.house_id);
      if (h && v.preferred_on && (v.status === 'new' || v.status === 'scheduled')) {
        ev.push({ on: v.preferred_on, t: (v.service === 'move' ? 'Move & Tote, ' : 'Carpet cleaning, ') + SSTATUS[v.status].toLowerCase(), h: h });
      }
    });
    ev = ev.filter(function (e) { return daysTo(e.on) <= 42; }).sort(function (a, b) { return a.on < b.on ? -1 : 1; });
    var evHtml = ev.length ? '<ul class="events">' + ev.map(function (e) {
      var n = daysTo(e.on);
      return '<li' + (n < 0 ? ' class="is-late"' : '') + '><time>' + shortDate(e.on) + '</time>' +
        '<span><strong>' + esc(e.t) + '</strong><a href="#house/' + e.h.id + '">' + esc(e.h.address) + '</a></span>' +
        '<span class="events__in">' + inDays(n) + '</span></li>';
    }).join('') + '</ul>' : '<p class="empty">No dates in the next six weeks. Set a go-in or come-out day on a house and it shows here.</p>';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">' + esc(ME.studio || 'Interior designer') + '</p><h1 class="title">Your <em>projects</em></h1></div>' +
        '<div class="head__acts"><button class="btn" type="button" data-act="new-house">Add a house</button></div></div>' +
      '<dl class="facts">' +
        '<div><dt>Staged now</dt><dd>' + staged.length + ' <small>' + (staged.length === 1 ? 'house' : 'houses') + '</small></dd></div>' +
        '<div><dt>Being planned</dt><dd>' + (live.length - staged.length) + '</dd></div>' +
        '<div><dt>Pieces out</dt><dd>' + out.length + '</dd></div>' +
        '<div><dt>Their price tags</dt><dd>' + money(sum(out, 'price_cents'), '$0') + '</dd></div>' +
        '<div><dt>Free to place</dt><dd>' + free.length + ' <small>in the warehouse</small></dd></div>' +
        (CREDIT ? '<div><dt>Credit from sales</dt><dd>' + money(D.houses.reduce(function (t, h) { return t + stats(h).credit; }, 0), '$0') +
          ' <small>' + CREDIT + '% of sales</small></dd></div>' : '') +
      '</dl>' +
      (D.houses.length
        ? '<div class="board">' + col('planned', 'Nothing being planned.') + col('staged', 'Nothing staged right now.') + col('destaged', 'No finished projects yet.') + '</div>'
        : '<p class="empty">No projects yet. Add a client&rsquo;s house, then choose Hughes Living furniture for it room by room.</p>') +
      '<div class="cols"><div>' +
        '<h2 class="h2">Coming up</h2>' + evHtml +
        '<h2 class="h2">Waiting on you</h2>' + todoList(live) +
      '</div><aside>' +
        '<h2 class="h2">Free in the warehouse</h2>' +
        (free.length ? '<div class="wh">' + free.slice(0, 6).map(function (i) {
            return '<div class="wh__i">' + thumb(i, 'wh__img') + '<span>' + esc(i.title) + '</span><span class="num">' + money(i.price_cents, '') + '</span></div>';
          }).join('') + '</div><p class="fine"><a href="#furniture">All ' + plural(free.length, 'free piece') + '</a>. Place them from a house&rsquo;s page.</p>'
          : '<p class="empty">Nothing is free in the Hughes Living warehouse right now.</p>') +
        '<h2 class="h2">Buyers</h2>' +
        feed(D.requests.slice(0, 4), true, 'Nobody yet. Orders from your staged houses show here.') +
      '</aside></div>' +
      tipBox(D.houses.length ? topic('projects') : topic('rooms'), D.houses.length ? '' : 'before your first project') +
      svcBand('Carpets cleaned before install day', 'Totes and a crew when a client&rsquo;s rooms need clearing');
  }

  /* ---------- realtor: which listings have a live QR code, and who scanned ---------- */
  function renderHomeRealtor() {
    var live = D.houses.filter(function (h) { return h.status !== 'destaged'; });
    var rows = D.houses.map(function (h) {
      var s = stats(h), to = daysTo(h.destage_on);
      var reqs = D.requests.filter(function (r) { return r.house_id === h.id; });
      var qr = { planned: 'The QR page opens when this listing is marked staged.',
                 staged: 'The QR page is open. Buyers who scan see every piece and its price.',
                 destaged: 'The staging has ended and the QR page says so.' }[h.status];
      return '<article class="lrow">' +
        '<a class="lrow__pic" href="#house/' + h.id + '" tabindex="-1" aria-hidden="true">' + thumb({ photo_url: h.cover_url }, 'lrow__img') + '</a>' +
        '<div class="lrow__b"><h2 class="lrow__t"><a href="#house/' + h.id + '">' + esc(h.address) + '</a> ' + chip(h.status, HSTATUS[h.status]) + '</h2>' +
        '<p class="lrow__who">' + esc([h.client_name ? 'Seller: ' + h.client_name : 'No seller on file', h.city].filter(Boolean).join(' · ')) + '</p>' +
        '<p class="lrow__qr">' + qr + '</p>' +
        '<dl class="lrow__nums">' +
          '<div><dt>Staged</dt><dd>' + (h.status === 'planned' || s.days == null ? '–' : s.days + ' <small>days</small>') + '</dd></div>' +
          '<div><dt>Buyer requests</dt><dd>' + reqs.length + (s.newReq ? ' <small class="is-flag">' + s.newReq + ' new</small>' : '') + '</dd></div>' +
          '<div><dt>Sold from here</dt><dd>' + money(s.sales, '$0') + '</dd></div>' +
          (CREDIT ? '<div><dt>Your credit, ' + CREDIT + '%</dt><dd>' + money(s.credit, '$0') + (s.credit && h.fee_cents ? ' <small>fee now ' + money(s.net, '$0') + '</small>' : '') + '</dd></div>' : '') +
          '<div><dt>Comes out</dt><dd>' + (h.destage_on ? shortDate(h.destage_on) + (h.status === 'staged' ? ' <small>' + inDays(to) + '</small>' : '') : '–') + '</dd></div>' +
        '</dl>' +
        '<div class="head__acts">' + qrActs(h) + '</div></div></article>';
    }).join('');

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">' + esc(ME.studio || 'Realtor') + '</p><h1 class="title">Your <em>listings</em></h1></div>' +
        '<div class="head__acts"><button class="btn" type="button" data-act="new-house">Add a listing</button></div></div>' +
      (D.houses.length ? '<div class="lrows">' + rows + '</div>'
        : '<p class="empty">No listings yet. Add one, choose Hughes Living furniture for it, and print a QR code for the showings.</p>') +
      '<div class="cols"><div>' +
        '<h2 class="h2">Who scanned</h2>' +
        feed(D.requests.slice(0, 8), true, 'Nobody yet. When a buyer scans a QR code at a showing and asks for a piece, it shows here.') +
      '</div><aside>' +
        '<h2 class="h2">Waiting on you</h2>' + todoList(live) +
      '</aside></div>' +
      tipBox(D.houses.some(function (h) { return h.status === 'staged'; }) ? topic('link') : topic('photos'), '') +
      svcBand('Carpets cleaned before the listing photos', 'Totes and a crew to help a seller clear out');
  }

  function renderHome() {
    if (ME.kind === 'designer') renderHomeDesigner();
    else if (ME.kind === 'realtor') renderHomeRealtor();
    else renderHomeSelf();
  }

  /* ============================================================== services
     Two services a customer can ask for at one of their houses: Richard's
     carpet cleaning, and Hughes Move & Tote (totes, or a crew with totes).
     Each is a request to the office, like a buyer's order: no booking is made
     and no money moves. The running total is for show; the data layer prices
     it again from its own copy of the rates. */
  var MOVE = (CFG.services || {}).move;
  var SVCNAME = { carpet: 'Carpet cleaning', move: 'Move & Tote' };
  function svcSummary(v) {
    try {
      if (v.service === 'move') {
        var d = v.details || {};
        return (d.mode === 'move' ? d.hours + ' hours, ' + String(d.truck).replace('ft', ' ft') + ' truck, ' + d.movers + ' movers' + (d.totes ? ', ' : '') : '') +
          (d.totes ? plural(d.totes, 'tote') + ' for ' + plural(d.weeks, 'week') : '');
      }
      return window.HLS.carpetQuote(v.rooms, v.addons).lines.map(function (l) { return l.label; }).join(' + ');
    } catch (e) { return ''; }
  }
  function svcCard(v) {
    var h = house(v.house_id), a = ME.staff && v.account_id != null && account(v.account_id);
    var what = SVCNAME[v.service] || SVCNAME.carpet;
    return '<article class="req' + (ME.staff && v.status === 'new' ? ' req--new' : '') + '">' +
      '<header><strong>' + esc(h ? h.address : 'A house that was deleted') + '</strong><time>' + fmtDate(v.created_at) + '</time></header>' +
      '<p class="req__what">' + what + ': ' + esc(svcSummary(v)) + '</p>' +
      '<p><span class="tagno">' + money(v.estimate_cents) + '</span> estimate' + (v.preferred_on ? ' · asked for ' + fmtDate(v.preferred_on) : '') + '</p>' +
      (v.note ? '<p class="req__note">&ldquo;' + esc(v.note) + '&rdquo;</p>' : '') +
      (ME.staff
        ? '<p class="req__reach">Asked by ' + (a ? esc(a.studio || a.name) + (a.email ? ' · <a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>' : '') : 'Hughes Living') + '</p>' +
          '<label class="vh" for="sv' + v.id + '">Status of the ' + what.toLowerCase() + ' request at ' + esc(h ? h.address : 'a deleted house') + '</label>' +
          '<select class="mini" id="sv' + v.id + '" data-act="svc-status" data-id="' + v.id + '">' + opts(SSTATUS, v.status) + '</select>'
        : '<p class="req__reach">' + chip(v.status === 'scheduled' ? 'staged' : v.status === 'new' ? 'hold' : 'x', SSTATUS[v.status]) +
          (v.status === 'new' ? ' <button class="linkbtn" type="button" data-act="cancel-service" data-id="' + v.id + '">Cancel this request</button>' : '') + '</p>') +
    '</article>';
  }
  /* What the Move & Tote form currently says, in the shape the data layer takes. */
  function moveChoice(form) {
    var f = formData(form);
    return { service: 'move', house_id: Number(f.house_id), mode: f.mode, totes: Number(f.totes || 0), weeks: Number(f.weeks),
             truck: f.truck, movers: Number(f.movers), hours: Number(f.hours), preferred_on: f.preferred_on, note: f.note };
  }
  function svcSum() {
    var form = document.getElementById('svcForm') || document.getElementById('mvForm'), box = document.getElementById('svcSum');
    if (!form || !box) return;
    var q;
    try {
      if (form.getAttribute('id') === 'mvForm') {
        var crew = form.elements.mode.value === 'move';
        document.getElementById('mvCrew').hidden = !crew;
        document.querySelector('label[for=f_totes]').textContent = crew ? 'Totes (0 for none)' : 'Totes';
        q = window.HLS.moveQuote(moveChoice(form));
      } else {
        q = window.HLS.carpetQuote(form.elements.rooms.value, Array.prototype.filter.call(form.querySelectorAll('[name=addon]'),
          function (c) { return c.checked; }).map(function (c) { return c.value; }));
      }
    } catch (e) { box.innerHTML = '<div><span>' + esc(e.message) + '</span></div>'; return; }
    box.innerHTML = q.lines.length
      ? q.lines.map(function (l) { return '<div><span>' + esc(l.label) + '</span><span class="num">' + money(l.cents) + '</span></div>'; }).join('') +
        '<div class="est__t"><span>Estimate</span><span class="num">' + money(q.total_cents) + '</span></div>'
      : '<div><span>Choose at least one room or add-on.</span></div>';
  }
  var priceRows = function (rows) {
    return '<dl class="prices">' + rows.map(function (r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>';
  };
  var numOpts = function (lo, hi, cur, word) {
    var o = '';
    for (var n = lo; n <= hi; n++) o += '<option value="' + n + '"' + (n === cur ? ' selected' : '') + '>' + plural(n, word) + '</option>';
    return o;
  };

  function renderServices(which) {
    var list = [CARPET && 'carpet', MOVE && 'move'].filter(Boolean);
    if (!list.length) { view.innerHTML = '<p class="empty">No services are set up.</p>'; return; }
    if (list.indexOf(which) === -1) which = list[0];
    var houses = D.houses.filter(function (h) { return h.status !== 'destaged'; });
    var houseField = field(ME.kind === 'realtor' ? 'Listing' : 'House', 'house_id', '', { select: houses.map(function (h) {
      return '<option value="' + h.id + '">' + esc(h.address) + '</option>'; }).join('') });
    var tail = function (hint, ph, fine) {
      return field('Day you would like', 'preferred_on', '', { type: 'date', hint: hint }) +
        field('Anything the crew should know', 'note', '', { area: true, ph: ph }) +
        '<div class="est" id="svcSum" aria-live="polite"></div>' +
        '<p class="sheet__err" role="alert"></p>' +
        '<button class="btn btn--block" type="submit">Send the request</button>' +
        '<p class="fine">This is a request, not a booking, and no payment is taken here. Hughes Living arranges it and confirms the day with you. ' + fine + '</p>';
    };
    var about, form;

    if (which === 'move') {
      var t = MOVE.toteTiers, trucks = MOVE.truckHourlyCents;
      about =
        '<img class="provider__img" src="img/services/move-tote-totes.webp" alt="Two black totes with yellow snap lids, stacked" width="581" height="671" loading="lazy">' +
        '<h2 class="h2">' + esc(MOVE.name) + '</h2>' +
        '<p>Reusable totes in place of cardboard boxes, and box-truck moving crews. For clearing a house out before it is staged, or for the move once it sells.</p>' +
        priceRows(t.slice().reverse().map(function (x, k, all) {
            var next = all[k + 1];
            return [(next ? (x.min || 1) + ' to ' + (next.min - 1) : x.min + ' or more') + ' totes, each per week', money(x.cents)];
          }).concat([
            ['Smallest totes-only order', money(MOVE.toteMinimumCents)],
            ['Totes booked with a crew, each per week', money(MOVE.toteWithMoveCents)],
            ['16 ft truck with 2 movers, per hour', money(trucks['16ft'])],
            ['26 ft truck with 2 movers, per hour', money(trucks['26ft'])],
            ['Each extra mover, per hour', money(MOVE.extraMoverCents)],
            ['Trip fee', money(MOVE.tripFeeCents)],
            ['Shortest crew booking', MOVE.minHours + ' hours']])) +
        '<p class="fine"><a href="' + esc(MOVE.url) + '" target="_blank" rel="noopener">Move &amp; Tote&rsquo;s own site</a> has the tote sizes, clothes bags and wardrobe boxes.</p>';
      form = '<form class="svcform" id="mvForm" novalidate>' + houseField +
        field('What you need', 'mode', '', { select: '<option value="totes">Totes only</option><option value="move">A moving crew, with or without totes</option>' }) +
        '<div class="pair">' + field('Totes', 'totes', '30', { type: 'number', mode: 'numeric' }) +
          field('For how long', 'weeks', '', { select: numOpts(1, MOVE.maxWeeks, 2, 'week') }) + '</div>' +
        '<div id="mvCrew" hidden><div class="pair">' +
          field('Truck', 'truck', '', { select: '<option value="16ft">16 ft, ' + money(trucks['16ft']) + '/hr</option><option value="26ft">26 ft, ' + money(trucks['26ft']) + '/hr</option>' }) +
          field('Movers', 'movers', '', { select: numOpts(2, MOVE.maxMovers, 2, 'mover') }) + '</div>' +
          field('Hours you expect', 'hours', '', { select: numOpts(MOVE.minHours, MOVE.maxHours, 4, 'hour'),
            hint: 'A crew is billed by the hour, so this is your guess. The estimate moves with it.' }) + '</div>' +
        tail('A request. The day is confirmed with you.', 'Stairs, a long carry, large or fragile pieces, where to park',
             'The estimate uses Move &amp; Tote&rsquo;s posted rates; a move is billed for the hours it takes.') +
        '</form>';
    } else {
      about =
        '<img class="provider__img" src="img/services/richards-truck-mount.jpg" alt="The truck-mount cleaning unit in Richard&rsquo;s van" width="830" height="824" loading="lazy">' +
        '<h2 class="h2">' + esc(CARPET.name) + '</h2>' +
        '<p>Truck-mount steam cleaning for carpet and upholstery. Carpets get cleaned while the house is empty, before the furniture goes in.</p>' +
        priceRows([['First room', money(CARPET.firstRoomCents)], ['Each room after that', money(CARPET.extraRoomCents)]]
          .concat(CARPET.addons.map(function (a) { return [esc(a.label), money(a.cents)]; }))) +
        '<p class="fine"><a href="' + esc(CARPET.url) + '" target="_blank" rel="noopener">Richard&rsquo;s own site</a> has tile, rugs and everything else he does.</p>';
      var roomOpts = '';
      for (var n = 0; n <= CARPET.maxRooms; n++) roomOpts += '<option value="' + n + '"' + (n === 3 ? ' selected' : '') + '>' + (n ? plural(n, 'room') : 'No rooms, add-ons only') + '</option>';
      form = '<form class="svcform" id="svcForm" novalidate>' + houseField +
        field('Carpeted rooms', 'rooms', '', { select: roomOpts, hint: 'First room ' + money(CARPET.firstRoomCents) + ', each room after that ' + money(CARPET.extraRoomCents) + '.' }) +
        '<fieldset class="adds"><legend>Add-ons</legend>' + CARPET.addons.map(function (a) {
          return '<label class="place__row"><input type="checkbox" name="addon" value="' + esc(a.key) + '"><span>' + esc(a.label) + '</span><span class="num">' + money(a.cents) + '</span></label>';
        }).join('') + '</fieldset>' +
        tail('A request. The day is confirmed with you.', 'Stains to look at, pets, where to park',
             'The estimate uses Richard&rsquo;s posted prices; the final price is confirmed at the house.') +
        '</form>';
    }
    if (!houses.length) form = '<p class="empty">Add a house first, then come back to request this for it. <a href="#houses">Go to houses</a></p>';

    var asked = D.services.length ? '<div class="reqs">' + D.services.map(svcCard).join('') + '</div>'
      : '<p class="empty">' + (ME.staff ? 'No one has asked for a service yet.' : 'You have not asked for anything yet.') + '</p>';
    var mine = (ME.staff ? '' : '<h2 class="h2">Your requests</h2>') + asked;
    var pick = list.length > 1 ? '<div class="seg" role="group" aria-label="Which service">' + list.map(function (k) {
      return '<a href="#services/' + k + '" aria-current="' + (k === which ? 'true' : 'false') + '">' + ({ carpet: 'Carpet cleaning', move: 'Moving &amp; totes' })[k] + '</a>';
    }).join('') + '</div>' : '';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Services</p><h1 class="title">' +
        (ME.staff ? 'What customers have <em>asked for</em>' : 'Help getting the house <em>ready</em>') + '</h1>' +
        (ME.staff ? '' : '<p class="sub">Two services you can ask for at any of your houses. Both are requests to the Hughes Living office.</p>') + '</div></div>' +
      (ME.staff ? mine : '') + pick +
      '<div class="cols cols--svc"><div class="provider">' + about + '</div><aside>' +
        '<h2 class="h2">' + (which === 'move' ? 'Request totes or a crew' : 'Request a cleaning') + '</h2>' + form + '</aside></div>' +
      (ME.staff ? '' : mine);
    svcSum();
  }

  /* ================================================================= guide
     What the pages know (guide.js): which login this is, what a room usually
     needs, and general staging practice. Drawn in full on the Guide tab, and a
     line at a time on the dashboards and house pages. */
  var GUIDE = window.HLS_GUIDE || { roles: {}, rooms: {}, topics: [] };
  var topicsFor = function (kind) {
    return GUIDE.topics.filter(function (t) { return t.who ? t.who.indexOf(kind) !== -1 : kind !== 'owner'; });
  };
  var topic = function (id) { return GUIDE.topics.filter(function (t) { return t.id === id; })[0]; };

  /* What a room is still missing from its usual list, given the pieces in it. */
  function missingIn(room, items) {
    return (GUIDE.rooms[room] || []).filter(function (need) {
      return !items.some(function (i) { return need.k.test(i.title + ' ' + (i.category || '')); });
    }).map(function (need) { return need.n; });
  }
  /* The guide topic that fits where a house is right now. */
  function topicForHouse(h) {
    if (!h) return topic('before');
    if (h.status === 'destaged') return topic('end');
    if (h.status === 'staged') {
      var to = daysTo(h.destage_on);
      if (to != null && to <= 7) return topic('end');
      return topic(D.requests.some(function (r) { return r.house_id === h.id; }) ? 'buyers' : 'qr');
    }
    return topic(inHouse(h.id).length ? 'photos' : 'rooms');
  }
  function tipBox(t, why) {
    if (!t) return '';
    return '<aside class="tip"><p class="eyebrow">From the guide' + (why ? ' · ' + esc(why) : '') + '</p>' +
      '<h2 class="tip__h">' + t.title + '</h2><p>' + t.lead + '</p>' +
      (t.points ? '<ul>' + t.points.slice(0, 3).map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="tip__more"><a href="#guide/' + t.id + '">Read the rest</a></p></aside>';
  }

  function renderGuide(jump) {
    var role = GUIDE.roles[ME.kind] || {}, list = topicsFor(ME.kind);
    var roomsTable = '<dl class="kit">' + Object.keys(GUIDE.rooms).map(function (r) {
      return '<div><dt>' + esc(r) + '</dt><dd>' + GUIDE.rooms[r].map(function (n) { return esc(n.n); }).join(', ') + '</dd></div>';
    }).join('') + '</dl>';

    view.innerHTML =
      '<div class="head"><div><p class="eyebrow">Guide · ' + esc(role.name || '') + '</p>' +
        '<h1 class="title">' + (ME.staff ? 'How the office <em>works</em>' : 'How staging with Hughes Living <em>works</em>') + '</h1>' +
        '<p class="sub">' + esc(role.line || '') + '</p></div></div>' +
      '<div class="guide"><nav class="guide__nav" aria-label="Guide sections"><a href="#guide/login">This login</a>' +
        list.map(function (t) { return '<a href="#guide/' + t.id + '">' + t.title + '</a>'; }).join('') + '</nav><div>' +
        '<section class="gsec" id="g-login"><h2 class="h2">This login: ' + esc(role.name || '') + '</h2>' +
          '<div class="can"><div><h3>What you do here</h3><ul>' + (role.can || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' +
          (role.hughes && role.hughes.length ? '<div><h3>What Hughes Living does</h3><ul>' + role.hughes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>' : '') +
          '</div>' +
          (ME.staff ? '' : '<p class="fine">You never see what a piece cost, the office notes, another account&rsquo;s houses, or a buyer&rsquo;s phone or email. Those stay with Hughes Living.</p>') +
        '</section>' +
        list.map(function (t) {
          return '<section class="gsec" id="g-' + t.id + '"><h2 class="h2">' + t.title + '</h2><p class="gsec__lead">' + t.lead + '</p>' +
            (t.points ? '<ul>' + t.points.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul>' : '') +
            (t.rooms ? roomsTable : '') + '</section>';
        }).join('') +
      '</div></div>';
    var el = jump && document.getElementById('g-' + jump);
    if (el) el.scrollIntoView();
  }

  /* ---------- sample data: something to look at in an empty office ----------
     Written through the same doors as real data, so it is real rows: staff can
     open the houses, print the cards and scan them. Every row is marked SAMPLE
     in its office note, which is how "Remove sample data" finds them again. */
  var SAMPLE = 'SAMPLE';
  var isSample = function (row) { return String(row.notes || '').indexOf(SAMPLE) === 0; };
  function dateOff(n) { var d = new Date(Date.now() + n * DAY); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
  function loadSample() {
    var P = 'img/sample/', note = SAMPLE + ' data. Remove it from the Houses tab.';
    var houses = [
      { address: '4410 Sample Oak Lane', city: 'Houston', zip: '77008', client_name: 'Sample Agent, Heights Realty', status: 'staged',
        staged_on: dateOff(-12), destage_on: dateOff(48), fee_cents: 180000, cover_url: 'img/looks/look-stone-hearth.webp',
        public_note: 'A sample house. These pieces are examples, not for sale.', notes: note },
      { address: '918 Example Bayou Court', city: 'Houston', zip: '77007', client_name: 'Sample Builder LLC', status: 'planned',
        staged_on: dateOff(6), destage_on: dateOff(66), fee_cents: 240000, cover_url: 'img/looks/look-fireside.webp', notes: note }
    ];
    // [title, category, source, cost, price, house (0 = first sample house, null = warehouse), room, photo, extra]
    var pieces = [
      ['Grey 3-piece sectional', 'Sectional', 'store', 46800, 109999, 0, 'Living room', 'lot-sectional.jpg'],
      ['Boucle accent chair', 'Accent chair', 'store', 14200, 29899, 0, 'Living room', 'lot-accent-chair.jpg'],
      ['Arc floor lamp', 'Lighting', 'auction', 2500, 8900, 0, 'Living room', 'lot-arc-lamp.jpg', { status: 'sold', sold_cents: 8500, sold_to: 'Sample buyer' }],
      ['8 x 10 area rug', 'Rug', 'store', 7100, 14999, 0, 'Living room', 'lot-rug.jpg'],
      ['Upholstered king headboard', 'Headboard', 'store', 9000, 18999, 0, 'Primary bedroom', 'lot-headboard.jpg'],
      ['Pair of nightstands', 'Nightstand', 'auction', 6000, 16000, 0, 'Primary bedroom', 'lot-nightstands.jpg', { status: 'hold' }],
      ['Six-drawer dresser', 'Dresser', 'auction', 11000, 32500, 0, 'Primary bedroom', 'lot-dresser.jpg'],
      ['Arched floor mirror', 'Mirror', 'store', 5200, 10999, 0, 'Entry', 'lot-mirror.jpg'],
      ['Entry bench', 'Bench', 'auction', 4000, 12000, null, null, 'lot-bench.jpg'],
      ['65" TV stand', 'TV stand', 'store', 9500, 19999, null, null, 'lot-tvstand.jpg']
    ];
    var ids = [];
    var chain = houses.reduce(function (p, h) {
      return p.then(function () { return API.saveHouse(h); }).then(function (saved) { ids.push(saved.id); });
    }, Promise.resolve());
    pieces.forEach(function (x) {
      chain = chain.then(function () {
        return API.saveItem(Object.assign({ title: x[0], category: x[1], source: x[2], cost_cents: x[3], price_cents: x[4],
          house_id: x[5] == null ? null : ids[x[5]], room: x[6], photo_url: P + x[7], details: 'Sample piece.',
          status: 'available', notes: SAMPLE }, x[8] || {}));
      });
    });
    return chain;
  }
  function removeSample() {
    var chain = Promise.resolve();
    D.items.filter(isSample).forEach(function (i) { chain = chain.then(function () { return API.deleteItem(i.id); }); });
    D.houses.filter(isSample).forEach(function (h) { chain = chain.then(function () { return API.deleteHouse(h.id); }); });
    return chain;
  }
  /* What staff see above the houses: how to start when the office is empty,
     or a reminder that what they are looking at is sample data. */
  function officeStart() {
    if (!ME.staff) return '';
    var sh = D.houses.filter(isSample).length, si = D.items.filter(isSample).length;
    if (sh || si) {
      return '<p class="note note--sample"><strong>Sample data is loaded</strong> ' + plural(sh, 'house') + ' and ' + plural(si, 'piece') +
        ', each marked SAMPLE in its office note. Real houses and pieces can sit beside them. ' +
        '<button class="linkbtn" type="button" data-act="remove-sample">Remove sample data</button></p>';
    }
    if (D.houses.length || D.items.length) return '';
    return '<section class="start"><h2 class="h2">Start here</h2><ol class="start__l">' +
      '<li><strong>Load the store catalog.</strong> Export your products from Shopify once, so pieces can be added by name with their price, cost and photo. ' +
        '<button class="linkbtn" type="button" data-act="from-store">Load the catalog</button></li>' +
      '<li><strong>Add the furniture you stage with.</strong> By hand, from the store, or from an auction lot. <a href="#furniture">Go to Furniture</a></li>' +
      '<li><strong>Add a house</strong> and place pieces in it, room by room. Mark it Staged to open its QR page.</li>' +
      '<li><strong>Print the QR card and tags</strong> from the house page.</li></ol>' +
      '<p class="start__s">Or look around first: <button class="btn btn--ghost" type="button" data-act="load-sample">Load sample data</button> ' +
        '<span class="fine">Two sample houses and ten sample pieces, removable with one click.</span></p></section>';
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
      field(ME.kind === 'realtor' ? 'Seller' : 'Client (agent, seller or builder)', 'client_name', h.client_name) +
      '<div class="pair">' + field(ME.kind === 'realtor' ? 'Seller phone' : 'Client phone', 'client_phone', h.client_phone, { type: 'tel' }) +
        field(ME.kind === 'realtor' ? 'Seller email' : 'Client email', 'client_email', h.client_email, { type: 'email' }) + '</div>';
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
        (TRADE[kind] ? field(TRADE[kind], 'studio', '') : '') +
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
    else if (act === 'copy-link') {
      var link = window.HLS.houseUrl(el.getAttribute('data-code'));
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(function () { toast('Buyer link copied.'); }, function () { prompt('Copy the buyer link:', link); });
    }
    else if (act === 'load-sample') {
      el.disabled = true; toast('Loading sample data…');
      run(loadSample(), 'Sample data loaded.').catch(function () {});
    }
    else if (act === 'remove-sample') {
      if (confirm('Remove every sample house and sample piece? Their requests and history go too. Real houses and pieces are not touched.')) {
        run(removeSample(), 'Sample data removed.').catch(function () {});
      }
    }
    else if (act === 'cancel-service') {
      if (confirm('Cancel this request?')) run(API.setService(id, 'cancelled'), 'Request cancelled.').catch(function () {});
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
    else if (act === 'svc-status') run(API.setService(id, el.value), 'Request marked ' + SSTATUS[el.value].toLowerCase() + '.').catch(function () {});
    else if (el.form && /^(svcForm|mvForm)$/.test(el.form.getAttribute('id'))) svcSum();
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
    } else if (el.id === 'f_totes') {
      svcSum();
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
    else if (fid === 'svcForm') {
      var adds = Array.prototype.filter.call(form.querySelectorAll('[name=addon]'), function (c) { return c.checked; })
        .map(function (c) { return c.value; });
      if (!Number(f.rooms) && !adds.length) { err.textContent = 'Choose at least one room or add-on.'; return; }
      busy(true); err.textContent = '';
      run(API.requestService({ house_id: Number(f.house_id), rooms: Number(f.rooms), addons: adds, preferred_on: f.preferred_on, note: f.note }),
          'Request sent. Hughes Living will confirm the day.')
        .catch(function (x) { err.textContent = x.message; busy(false); });
    }
    else if (fid === 'mvForm') {
      var choice = moveChoice(form);
      try { window.HLS.moveQuote(choice); } catch (x) { err.textContent = x.message; return; }
      busy(true); err.textContent = '';
      run(API.requestService(choice), 'Request sent. Hughes Living will confirm the day.')
        .catch(function (x) { err.textContent = x.message; busy(false); });
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
    var parts = (location.hash || (ME.staff ? '#houses' : '#home')).slice(1).split('/');
    if (!ME.staff && (parts[0] === 'money' || parts[0] === 'accounts')) parts = ['home'];   // nothing to show a customer there
    if (ME.staff && parts[0] === 'home') parts = ['houses'];                                // the office has no dashboard
    var tab = parts[0] === 'house' ? 'houses' : parts[0];
    Array.prototype.forEach.call(document.querySelectorAll('#tabs a'), function (a) {
      a.hidden = (a.hasAttribute('data-staff') && !ME.staff) || (a.hasAttribute('data-cust') && ME.staff);
      a.getAttribute('data-tab') === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    var n = D.requests.filter(function (r) { return r.status === 'new'; }).length;
    var badge = document.getElementById('reqCount');
    badge.hidden = !n; badge.textContent = n;
    var sn = ME.staff ? D.services.filter(function (v) { return v.status === 'new'; }).length : 0;
    var sbadge = document.getElementById('svcCount');
    sbadge.hidden = !sn; sbadge.textContent = sn;

    if (parts[0] === 'home') renderHome();
    else if (parts[0] === 'services') renderServices(parts[1]);
    else if (parts[0] === 'guide') renderGuide(parts[1]);
    else if (parts[0] === 'house') renderHouse(Number(parts[1]));
    else if (parts[0] === 'furniture') renderFurniture();
    else if (parts[0] === 'requests') renderRequests();
    else if (parts[0] === 'money') renderMoney();
    else if (parts[0] === 'accounts') renderAccounts();
    else renderHouses();
  }

  /* The front door: two kinds of customer, and a quiet line for staff. */
  var atDoor = false;
  function doorView() {
    var demo = API.name === 'demo';
    atDoor = true;
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
        kind('self', 'Staging it myself', 'For a homeowner getting their own house ready to sell.') +
        kind('designer', 'Interior designer', 'For designers staging for clients, with several houses going at once.') +
        kind('realtor', 'Realtor', 'For agents staging their listings, with a QR code for every showing.') +
      '</div>' +
      '<p class="door__staff">Hughes Living staff: <button class="linkbtn" type="button" data-act="door" data-kind="owner" data-mode="in">sign in to the office</button>' +
        (demo ? ' or <button class="linkbtn" type="button" data-act="sample" data-kind="owner">open the sample office</button>' : '') + '</p>' +
      '<div class="rooms3">' + room('room-living', 'Living room') + room('room-dining', 'Dining room') + room('room-bedroom', 'Bedroom') + '</div>' +
      '<p class="door__more"><a class="btn btn--ghost" href="gallery.html">See the gallery</a></p></div>';
  }

  /* Signed in, but not yet a staging customer (an auction bidder, say). */
  function finishView() {
    view.innerHTML = '<div class="door"><p class="eyebrow">One more step</p><h1 class="title">How will you be <em>staging?</em></h1>' +
      '<p class="sub">You are signed in as ' + esc(ME.email) + '. Pick one to finish your staging account.</p>' +
      '<div class="kind__acts" style="margin-top:1.4rem">' +
      '<button class="btn" type="button" data-act="door" data-kind="self" data-mode="finish">Staging it myself</button>' +
      '<button class="btn" type="button" data-act="door" data-kind="designer" data-mode="finish">Interior designer</button>' +
      '<button class="btn" type="button" data-act="door" data-kind="realtor" data-mode="finish">Realtor</button></div></div>';
  }

  function boot() {
    return API.session().then(function (s) {
      ME = s;
      var who = document.getElementById('who');
      document.getElementById('tabs').hidden = !s.kind;
      document.getElementById('signOut').hidden = !s.signedIn;
      who.hidden = true;                    // the band under the header says who is signed in
      who.textContent = !s.kind ? '' : (s.studio || s.name || s.email) + (s.staff ? ' · ' + KIND[s.kind] : '');   // a customer's kind is already beside the name of the site
      document.querySelector('.mark__role').textContent = s.kind && !s.staff ? KIND[s.kind] : 'Office';
      document.querySelector('.mark').setAttribute('href', s.kind && !s.staff ? '#home' : '#houses');
      document.getElementById('tabHouses').textContent = HOUSEWORD[s.kind] || 'Houses';
      var role = GUIDE.roles[s.kind], band = document.getElementById('roleBand');
      s.kind ? document.body.setAttribute('data-role', s.kind) : document.body.removeAttribute('data-role');
      document.title = (role ? role.name + ' · ' : '') + 'Hughes Living Staging';
      band.hidden = !role;
      band.innerHTML = role ? '<div class="wrap role__in"><span class="role__k">' + esc(role.name) + ' login</span>' +
        // the person, then their business if they gave one: "Jane Smith · Smith Interiors"
        '<span class="role__l">' + (s.staff ? '' : '<strong class="role__who">' +
          esc([s.name, s.studio !== s.name && s.studio].filter(Boolean).join(' · ') || s.email || '') + '</strong>') + esc(role.line) + '</span>' +
        '<a href="#guide/login">What this login can do</a></div>' : '';
      if (!s.signedIn) return doorView();
      if (!s.kind) return finishView();
      if (atDoor) {                       // just came through the door: start on this account's first screen
        atDoor = false;
        history.replaceState(null, '', location.pathname + location.search + (s.staff ? '#houses' : '#home'));
      }
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
  window.addEventListener('hashchange', function () {
    var inGuide = /^#guide\//.test(location.hash);
    if (ME.kind) route();
    if (!inGuide) window.scrollTo(0, 0);          // a guide link scrolls to its own section
  });
  document.getElementById('signOut').addEventListener('click', function () {
    API.signOut().then(function () { history.replaceState(null, '', location.pathname + location.search); return boot(); });
  });
  document.getElementById('demoNote').hidden = API.name !== 'demo';

  boot();
})();

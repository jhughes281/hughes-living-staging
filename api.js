/* Hughes Living Staging — the one place that talks to the data.

   Two interchangeable backends behind the same functions, chosen in config.js.
   The pages never know which one answered.

   window.HLS_API
     name                      'demo' | 'supabase'
     session()                 -> { signedIn, email, name, kind, staff }
                                  kind: 'owner' (Hughes Living staff), 'self'
                                  (staging my own house), 'designer', 'realtor', or null
                                  for a signed-in user with no account yet
     signIn(email, password)   signOut()
     signUp({ kind, name, studio, phone, email, password })
     register({ kind, name, studio, phone })   finish an account after sign-in
     sampleSignIn(kind)        demo only: step into a sample account
     placeItem(id, houseId, room)   move a piece; the one write customers have
     office()                  -> { houses, items, requests, moves, catalog_count }
     saveHouse(h)  saveItem(i) deleteHouse(id)  deleteItem(id)
     setRequest(id, status)
     catalogImport(rows, replace) -> n       catalogSearch(q) -> rows
     lots()                    -> auction lots, for adding a piece from one
     uploadPhoto(blob)         -> url
     publicHouse(code)         -> what a buyer's phone gets
     sendRequest(code, tagNo, name, phone, email, note, kind)
                               kind: 'piece' (buy one), 'look' (buy every piece
                               still available in the house) or 'question'.
                               Takes no money: it is an order for the office. */

(function (global) {
  'use strict';

  var CFG = global.HLS_CONFIG || {};

  function fail(msg) { var e = new Error(msg); e.friendly = true; return e; }
  var txt = function (v) { v = v == null ? '' : String(v).trim(); return v === '' ? null : v; };
  var int = function (v) { v = txt(v); return v == null ? null : Math.round(Number(v)); };

  /* ================================================================ demo */
  function demoBackend() {
    var KEY = 'hls-demo-v5', SKEY = 'hls-demo-session';

    function seed() {
      var day = 86400000, now = Date.now();
      var iso = function (d) { return new Date(now - d * day).toISOString(); };
      var date = function (d) { return iso(d).slice(0, 10); };
      var P = 'img/sample/';
      var houses = [
        { id: 1, code: 'SAMPLE22', address: '4410 Sample Oak Lane', city: 'Houston', zip: '77008',
          client_name: 'Sample Agent, Heights Realty', client_phone: '', client_email: '',
          listing_url: '', status: 'staged', staged_on: date(12), destage_on: date(-48),
          fee_cents: 180000, public_note: 'Pieces stay in the home until the listing closes.', cover_url: 'img/looks/look-stone-hearth.webp',
          notes: 'Sample house. Delete it once real ones are in.', account_id: 2, created_at: iso(14) },
        { id: 2, code: 'SAMPLE33', address: '918 Example Bayou Court', city: 'Houston', zip: '77007',
          client_name: 'Sample Builder LLC', client_phone: '', client_email: '', listing_url: '',
          status: 'planned', staged_on: null, destage_on: null, fee_cents: 240000, cover_url: 'img/looks/look-fireside.webp',
          public_note: null, notes: 'Sample house.', account_id: null, created_at: iso(3) },
        { id: 3, code: 'SAMPLE44', address: '27 Demo Pine Drive', city: 'Houston', zip: '77018',
          client_name: null, client_phone: '', client_email: '', listing_url: '',
          status: 'planned', staged_on: null, destage_on: null, fee_cents: 95000, cover_url: 'img/looks/look-media-wall.webp',
          public_note: null, notes: 'Sample house.', account_id: 3, created_at: iso(2) },
        { id: 4, code: 'SAMPLE55', address: '302 Sample Heights Blvd', city: 'Houston', zip: '77008',
          client_name: 'Sample Seller', client_phone: '', client_email: '', listing_url: '',
          status: 'planned', staged_on: null, destage_on: null, fee_cents: 150000, cover_url: 'img/looks/look-navy-accent.webp',
          public_note: null, notes: 'Sample house.', account_id: 4, created_at: iso(1) }
      ];
      var accounts = [
        { id: 1, kind: 'owner', name: 'Hughes Living', studio: null, phone: null, email: 'office@sample.test', created_at: iso(30) },
        { id: 2, kind: 'designer', name: 'Sample Designer', studio: 'Sample Interiors', phone: null, email: 'designer@sample.test', created_at: iso(20) },
        { id: 3, kind: 'self', name: 'Sample Homeowner', studio: null, phone: null, email: 'homeowner@sample.test', created_at: iso(5) },
        { id: 4, kind: 'realtor', name: 'Sample Realtor', studio: 'Sample Realty Group', phone: null, email: 'realtor@sample.test', created_at: iso(3) }
      ];
      var n = 1000;
      var it = function (title, cat, src, cost, price, house, room, photo, details, extra) {
        n++;
        var o = { id: n - 1000, tag_no: n, title: title, category: cat, source: src,
          source_ref: null, source_url: src === 'store' ? CFG.storeUrl : (src === 'auction' ? CFG.auctionUrl : null),
          photo_url: photo ? P + photo : null, cost_cents: cost, price_cents: price, details: details || null,
          notes: null, status: 'available', house_id: house, room: house ? room : null,
          sold_at: null, sold_cents: null, sold_to: null, sold_house_id: null,
          created_at: iso(20), updated_at: iso(1) };
        for (var k in (extra || {})) o[k] = extra[k];
        return o;
      };
      var items = [
        it('Grey 3-piece sectional', 'Sectional', 'store', 46800, 109999, 1, 'Living room', 'lot-sectional.jpg', '112" W x 84" D. Sample piece.'),
        it('Boucle accent chair', 'Accent chair', 'store', 14200, 29899, 1, 'Living room', 'lot-accent-chair.jpg', 'Sample piece.'),
        it('Arc floor lamp', 'Lighting', 'auction', 2500, 8900, 1, 'Living room', 'lot-arc-lamp.jpg', 'Repaired base. Sample piece.',
           { status: 'sold', sold_at: iso(4), sold_cents: 8500, sold_to: 'Sample buyer', sold_house_id: 1 }),
        it('8 x 10 area rug', 'Rug', 'store', 7100, 14999, 1, 'Living room', 'lot-rug.jpg', 'Sample piece.'),
        it('Upholstered king headboard', 'Headboard', 'store', 9000, 18999, 1, 'Primary bedroom', 'lot-headboard.jpg', 'Sample piece.'),
        it('Pair of nightstands', 'Nightstand', 'auction', 6000, 16000, 1, 'Primary bedroom', 'lot-nightstands.jpg', 'Sold as a pair. Sample piece.', { status: 'hold' }),
        it('Six-drawer dresser', 'Dresser', 'auction', 11000, 32500, 1, 'Primary bedroom', 'lot-dresser.jpg', 'Sample piece.'),
        it('Arched floor mirror', 'Mirror', 'store', 5200, 10999, 1, 'Entry', 'lot-mirror.jpg', 'Sample piece.'),
        it('Entry bench', 'Bench', 'auction', 4000, 12000, null, null, 'lot-bench.jpg', 'Sample piece.'),
        it('65" TV stand', 'TV stand', 'store', 9500, 19999, null, null, 'lot-tvstand.jpg', 'Sample piece.')
      ];
      var moves = items.filter(function (i) { return i.house_id; }).map(function (i, k) {
        return { id: k + 1, item_id: i.id, house_id: i.house_id, room: i.room, placed_at: iso(12), removed_at: null };
      });
      var requests = [
        { id: 1, house_id: 1, item_id: 1, item_title: 'Grey 3-piece sectional', name: 'Sample visitor',
          phone: '555-0100', email: null, note: 'Would you deliver to Katy?', status: 'new', kind: 'piece',
          piece_count: null, total_cents: null, created_at: iso(1) }
      ];
      return { houses: houses, items: items, moves: moves, requests: requests, accounts: accounts, catalog: [],
               seq: { house: 5, item: 11, move: 20, req: 2, tag: 1011, account: 5 } };
    }

    function load() {
      try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && s.houses) return s; } catch (e) {}
      var fresh = seed(); save(fresh); return fresh;
    }
    function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
    var ok = function (v) { return Promise.resolve(v); };
    var no = function (m) { return Promise.reject(fail(m)); };
    function code() {
      var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', v = '';
      for (var i = 0; i < 8; i++) v += a.charAt(Math.floor(Math.random() * a.length));
      return v;
    }

    /* Who is signed in, in this browser. The demo enforces the same rules the
       database does (supabase/0002_accounts.sql), so the screens can be tried
       honestly: a customer's data really is filtered before the page gets it. */
    function me(s) {
      var id = null;
      try { id = Number(localStorage.getItem(SKEY)); } catch (e) {}
      return s.accounts.filter(function (a) { return a.id === id; })[0] || null;
    }
    function need(s, staffOnly) {
      var a = me(s);
      if (!a) throw fail('Sign in first.');
      if (staffOnly && a.kind !== 'owner') throw fail('Only Hughes Living staff can do that.');
      return a;
    }
    function mine(s, a) {
      var ids = {};
      s.houses.forEach(function (h) { if (h.account_id === a.id) ids[h.id] = true; });
      return ids;
    }
    function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
    function digest(email, password) {
      var bytes = new TextEncoder().encode('hls-demo|' + email.toLowerCase() + '|' + password);
      return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    function setSession(id) { try { id == null ? localStorage.removeItem(SKEY) : localStorage.setItem(SKEY, String(id)); } catch (e) {} }
    function sessionOf(a) {
      return a ? { signedIn: true, email: a.email, name: a.name, studio: a.studio, kind: a.kind, staff: a.kind === 'owner' }
               : { signedIn: false, email: null, name: null, kind: null, staff: false };
    }

    var demo = {
      name: 'demo',
      session: function () { return ok(sessionOf(me(load()))); },
      signIn: function (email, password) {
        var s = load();
        email = (email || '').trim().toLowerCase();
        var a = s.accounts.filter(function (x) { return (x.email || '').toLowerCase() === email; })[0];
        if (!a || !a.pass) return no('That email and password do not match.');
        return digest(email, password || '').then(function (h) {
          if (h !== a.pass) throw fail('That email and password do not match.');
          setSession(a.id); return true;
        });
      },
      signUp: function (p) {
        var s = load();
        var email = (p.email || '').trim().toLowerCase();
        if (['self', 'designer', 'realtor'].indexOf(p.kind) === -1) return no('Choose staging it myself, interior designer or realtor.');
        if (!txt(p.name)) return no('Please give your name.');
        if (!/^\S+@\S+\.\S+$/.test(email)) return no('Enter a valid email address.');
        if ((p.password || '').length < 8) return no('Use a password of at least 8 characters.');
        if (s.accounts.some(function (x) { return (x.email || '').toLowerCase() === email; })) return no('There is already an account for that email. Sign in instead.');
        return digest(email, p.password).then(function (h) {
          var a = { id: s.seq.account++, kind: p.kind, name: txt(p.name), studio: p.kind === 'self' ? null : txt(p.studio),
                    phone: txt(p.phone), email: email, pass: h, created_at: new Date().toISOString() };
          s.accounts.push(a); save(s); setSession(a.id); return true;
        });
      },
      register: function () { return no('Nothing to finish in the sample.'); },
      sampleSignIn: function (kind) {
        var a = load().accounts.filter(function (x) { return x.kind === kind && !x.pass; })[0];
        if (!a) return no('No sample account of that kind.');
        setSession(a.id); return ok(true);
      },
      signOut: function () { setSession(null); return ok(true); },

      office: function () {
        var s = load(), a = need(s);
        if (a.kind === 'owner') {
          return ok({ houses: s.houses.slice().reverse(), items: s.items, requests: s.requests.slice().reverse(),
                      moves: s.moves, catalog_count: s.catalog.length,
                      accounts: s.accounts.filter(function (x) { return x.kind !== 'owner'; })
                        .map(function (x) { return pick(x, ['id', 'kind', 'name', 'studio', 'phone', 'email', 'created_at']); }) });
        }
        // a customer: only their houses, never cost, office notes or buyers' contact details
        var ids = mine(s, a);
        return ok({
          houses: s.houses.filter(function (h) { return ids[h.id]; }).reverse().map(function (h) {
            var c = Object.assign({}, h); delete c.notes; return c;
          }),
          items: s.items.filter(function (i) {
            return ids[i.house_id] || ids[i.sold_house_id] || (i.house_id == null && i.status === 'available');
          }).map(function (i) {
            return pick(i, ['id', 'tag_no', 'title', 'category', 'source', 'source_url', 'photo_url', 'price_cents',
                            'details', 'status', 'house_id', 'room', 'sold_at', 'sold_cents', 'sold_house_id']);
          }),
          requests: s.requests.filter(function (r) { return ids[r.house_id]; }).reverse().map(function (r) {
            return pick(r, ['id', 'house_id', 'item_id', 'item_title', 'name', 'note', 'kind', 'piece_count', 'total_cents', 'status', 'created_at']);
          }),
          moves: s.moves.filter(function (m) { return ids[m.house_id]; }),
          catalog_count: 0, accounts: []
        });
      },

      saveHouse: function (p) {
        var s = load(), a = need(s), staff = a.kind === 'owner';
        if (!txt(p.address)) return no('A house needs an address.');
        var h = s.houses.filter(function (x) { return x.id === p.id; })[0];
        if (h && !staff && h.account_id !== a.id) return no('That is not one of your houses.');
        if (!h) {
          h = { id: s.seq.house++, code: code(), created_at: new Date().toISOString(),
                fee_cents: 0, notes: null, account_id: staff ? null : a.id };
          s.houses.push(h);
        }
        ['address', 'city', 'zip', 'client_name', 'client_phone', 'client_email', 'listing_url',
         'staged_on', 'destage_on', 'public_note', 'cover_url'].forEach(function (k) { h[k] = txt(p[k]); });
        h.status = txt(p.status) || 'planned';
        if (staff) {                      // the fee, the office note and whose house it is are Hughes Living's to set
          h.fee_cents = int(p.fee_cents) || 0;
          h.notes = txt(p.notes);
          h.account_id = int(p.account_id);
        }
        save(s);
        var out = Object.assign({}, h); if (!staff) delete out.notes;
        return ok(out);
      },

      placeItem: function (id, houseId, room) {
        var s = load(), a = need(s), staff = a.kind === 'owner';
        var i = s.items.filter(function (x) { return x.id === id; })[0];
        if (!i) return no('That piece no longer exists.');
        if (!staff) {
          var ids = mine(s, a);
          if (!((i.house_id == null && i.status === 'available') || ids[i.house_id])) return no('That piece is not yours to move.');
          if (i.status === 'sold') return no('That piece has sold. Hughes Living will collect it.');
          if (houseId != null && !ids[houseId]) return no('That is not one of your houses.');
        }
        var oldHouse = i.house_id;
        i.house_id = houseId == null ? null : houseId;
        i.room = i.house_id == null ? null : txt(room);
        i.updated_at = new Date().toISOString();
        if (oldHouse !== i.house_id) {
          s.moves.forEach(function (m) { if (m.item_id === i.id && !m.removed_at) m.removed_at = new Date().toISOString(); });
          if (i.house_id != null) s.moves.push({ id: s.seq.move++, item_id: i.id, house_id: i.house_id, room: i.room,
                                                 placed_at: new Date().toISOString(), removed_at: null });
        } else s.moves.forEach(function (m) { if (m.item_id === i.id && !m.removed_at) m.room = i.room; });
        save(s); return ok();
      },

      saveItem: function (p) {
        var s = load(); need(s, true);
        if (!txt(p.title)) return no('A piece needs a name.');
        var i = s.items.filter(function (x) { return x.id === p.id; })[0];
        var fresh = !i;
        if (fresh) {
          i = { id: s.seq.item++, tag_no: s.seq.tag++, created_at: new Date().toISOString(),
                house_id: null, sold_at: null, sold_house_id: null };
          s.items.push(i);
        }
        var oldHouse = i.house_id, oldRoom = i.room;
        ['title', 'category', 'source_ref', 'source_url', 'photo_url', 'details', 'notes'].forEach(function (k) { i[k] = txt(p[k]); });
        i.source = txt(p.source) || 'other';
        i.cost_cents = int(p.cost_cents); i.price_cents = int(p.price_cents);
        i.status = txt(p.status) || 'available';
        i.house_id = int(p.house_id);
        i.room = i.house_id == null ? null : txt(p.room);
        if (i.status === 'sold') {
          i.sold_at = txt(p.sold_at) || i.sold_at || new Date().toISOString();
          i.sold_cents = int(p.sold_cents) != null ? int(p.sold_cents) : i.price_cents;
          i.sold_to = txt(p.sold_to);
          i.sold_house_id = i.sold_house_id || i.house_id || oldHouse || null;
        } else { i.sold_at = null; i.sold_cents = null; i.sold_to = null; i.sold_house_id = null; }
        i.updated_at = new Date().toISOString();

        // the same bookkeeping the database trigger does
        if (fresh || oldHouse !== i.house_id) {
          s.moves.forEach(function (m) { if (m.item_id === i.id && !m.removed_at) m.removed_at = new Date().toISOString(); });
          if (i.house_id != null) s.moves.push({ id: s.seq.move++, item_id: i.id, house_id: i.house_id, room: i.room,
                                                 placed_at: new Date().toISOString(), removed_at: null });
        } else if (oldRoom !== i.room) {
          s.moves.forEach(function (m) { if (m.item_id === i.id && !m.removed_at) m.room = i.room; });
        }
        save(s); return ok(i);
      },

      deleteItem: function (id) {
        var s = load(); need(s, true);
        s.items = s.items.filter(function (x) { return x.id !== id; });
        s.moves = s.moves.filter(function (m) { return m.item_id !== id; });
        s.requests.forEach(function (r) { if (r.item_id === id) r.item_id = null; });
        save(s); return ok();
      },
      deleteHouse: function (id) {
        var s = load(); need(s, true);
        if (s.items.some(function (x) { return x.house_id === id; })) return no('Move the furniture out of this house before deleting it.');
        s.houses = s.houses.filter(function (x) { return x.id !== id; });
        s.moves = s.moves.filter(function (m) { return m.house_id !== id; });
        s.requests = s.requests.filter(function (r) { return r.house_id !== id; });
        s.items.forEach(function (x) { if (x.sold_house_id === id) x.sold_house_id = null; });
        save(s); return ok();
      },
      setRequest: function (id, status) {
        var s = load(); need(s, true);
        s.requests.forEach(function (r) { if (r.id === id) r.status = status; });
        save(s); return ok();
      },

      catalogImport: function (rows, replace) {
        var s = load(); need(s, true);
        if (replace) s.catalog = [];
        var by = {};
        s.catalog.forEach(function (c) { by[c.handle + '|' + c.variant] = c; });
        rows.forEach(function (r) { if (r.handle && r.title) by[r.handle + '|' + (r.variant || '')] = r; });
        // browser storage is small; the real backend keeps the whole catalog
        s.catalog = Object.keys(by).map(function (k) { return by[k]; }).slice(0, 1500);
        save(s); return ok(rows.length);
      },
      catalogSearch: function (q) {
        need(load(), true);
        q = (q || '').toLowerCase().trim();
        return ok(load().catalog.filter(function (c) {
          return !q || (c.title + ' ' + (c.sku || '') + ' ' + c.handle).toLowerCase().indexOf(q) !== -1;
        }).slice(0, 30));
      },
      lots: function () {
        need(load(), true);
        return ok([
          { lot_no: 101, title: 'Sample lot: tufted storage ottoman', image_path: null, retail_cents: 18900, status: 'open' },
          { lot_no: 102, title: 'Sample lot: bar cabinet with glass rack', image_path: null, retail_cents: 42000, status: 'open' }
        ]);
      },
      uploadPhoto: function (blob) {
        need(load(), true);
        return new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { resolve(r.result); };
          r.onerror = function () { reject(fail('Could not read that photo.')); };
          r.readAsDataURL(blob);
        });
      },

      publicHouse: function (c) {
        var s = load();
        c = (c || '').trim().toUpperCase();
        var h = s.houses.filter(function (x) { return x.code === c; })[0];
        if (!h) return ok({ found: false });
        if (h.status !== 'staged') return ok({ found: true, open: false, address: h.address, city: h.city });
        var items = s.items.filter(function (i) { return i.house_id === h.id && i.status !== 'retired'; })
          .map(function (i) {
            return { tag_no: i.tag_no, title: i.title, category: i.category, room: i.room || 'Around the house',
                     price_cents: i.price_cents, photo_url: i.photo_url, details: i.details, status: i.status,
                     source: i.source, source_url: i.source_url };
          })
          .sort(function (a, b) { return a.room === b.room ? a.tag_no - b.tag_no : (a.room < b.room ? -1 : 1); });
        return ok({ found: true, open: true, code: h.code, address: h.address, city: h.city, note: h.public_note,
                    cover_url: h.cover_url, items: items });
      },
      sendRequest: function (c, tagNo, name, phone, email, note, kind) {
        var s = load();
        kind = kind || (tagNo == null ? 'question' : 'piece');
        c = (c || '').trim().toUpperCase();
        var h = s.houses.filter(function (x) { return x.code === c; })[0];
        if (!h || h.status !== 'staged') return no('This house is not taking requests.');
        if (!txt(name)) return no('Please give your name.');
        if (!txt(phone) && !txt(email)) return no('Leave a phone number or an email so we can reach you.');
        var look = null;
        if (kind === 'look') {          // priced here, not trusted from the page, as the database does
          look = s.items.filter(function (x) { return x.house_id === h.id && x.status === 'available'; });
          if (!look.length) return no('Nothing in this home is available right now.');
          tagNo = null;
        }
        var i = tagNo == null ? null : s.items.filter(function (x) { return x.tag_no === tagNo && x.house_id === h.id; })[0];
        if (tagNo != null && !i) return no('That piece is not in this house.');
        if (i && i.status === 'sold') return no('That piece has already sold.');
        s.requests.push({ id: s.seq.req++, house_id: h.id, item_id: i ? i.id : null, item_title: i ? i.title : null,
          name: txt(name), phone: txt(phone), email: txt(email), note: txt(note), status: 'new', kind: kind,
          piece_count: look ? look.length : null,
          total_cents: look ? look.reduce(function (t, x) { return t + (x.price_cents || 0); }, 0) : null,
          created_at: new Date().toISOString() });
        save(s); return ok(true);
      }
    };

    // a broken rule is thrown inside; hand it back as a rejected promise like the real backend
    Object.keys(demo).forEach(function (k) {
      var fn = demo[k];
      if (typeof fn !== 'function') return;
      demo[k] = function () {
        try { return fn.apply(demo, arguments); } catch (e) { return Promise.reject(e); }
      };
    });
    return demo;
  }

  /* ============================================================ supabase */
  function supabaseBackend() {
    var LIB = 'vendor/supabase-js-2.112.4.js';
    var sb = null, loading = null, staff = false;

    function client() {
      if (sb) return Promise.resolve(sb);
      if (loading) return loading;
      loading = new Promise(function (resolve, reject) {
        if (global.supabase && global.supabase.createClient) return resolve();
        var el = document.createElement('script');
        el.src = LIB;
        el.onload = resolve;
        el.onerror = function () { reject(fail('Could not load ' + LIB + '.')); };
        document.head.appendChild(el);
      }).then(function () {
        sb = global.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
        return sb;
      }).catch(function (e) { loading = null; throw e; });
      return loading;
    }

    /* Turn a database error into a sentence a person can act on. */
    function explain(error) {
      var m = (error && error.message) || 'Something went wrong.';
      if (/not staff|no staging account|permission denied/i.test(m)) return fail('This account cannot do that.');
      if (/Could not find the function|PGRST202|schema cache/i.test(m)) {
        return fail('The staging tables are not installed in Supabase yet. Run supabase/0001_staging.sql and 0002_accounts.sql first.');
      }
      if (/JWT|session/i.test(m)) return fail('Your sign-in has expired. Sign in again.');
      return fail(m);
    }
    function rpc(fn, args) {
      return client().then(function (c) { return c.rpc(fn, args || {}); }).then(function (r) {
        if (r.error) throw explain(r.error);
        return r.data;
      });
    }

    return {
      name: 'supabase',
      session: function () {
        return client().then(function (c) { return c.auth.getSession(); }).then(function (r) {
          var s = r.data && r.data.session;
          if (!s) return { signedIn: false, email: null, name: null, kind: null, staff: false };
          return rpc('stg_my_account').then(function (a) {
            staff = !!(a && a.kind === 'owner');
            return { signedIn: true, email: s.user.email, name: a ? a.name : null, studio: a ? a.studio : null,
                     kind: a ? a.kind : null, staff: staff };
          });
        });
      },
      signIn: function (email, password) {
        return client().then(function (c) { return c.auth.signInWithPassword({ email: email, password: password }); })
          .then(function (r) {
            if (r.error) throw fail(/invalid/i.test(r.error.message) ? 'That email and password do not match.' : r.error.message);
            return true;
          });
      },
      signUp: function (p) {
        return client().then(function (c) { return c.auth.signUp({ email: p.email, password: p.password }); })
          .then(function (r) {
            if (r.error) throw fail(r.error.message);
            if (!r.data.session) throw fail('Check your email to confirm the address, then sign in to finish.');
            return rpc('stg_register', { p_kind: p.kind, p_name: p.name, p_studio: p.studio || null, p_phone: p.phone || null });
          }).then(function () { return true; });
      },
      register: function (p) {
        return rpc('stg_register', { p_kind: p.kind, p_name: p.name, p_studio: p.studio || null, p_phone: p.phone || null });
      },
      sampleSignIn: function () { return Promise.reject(fail('Sample accounts exist only in sample mode.')); },
      signOut: function () { staff = false; return client().then(function (c) { return c.auth.signOut(); }); },

      // staff and customers read through different doors; the database decides what each may see
      office: function () { return rpc(staff ? 'stg_office' : 'stg_portal'); },
      saveHouse: function (h) { return rpc(staff ? 'stg_save_house' : 'stg_portal_save_house', { p: h }); },
      placeItem: function (id, houseId, room) { return rpc('stg_place', { p_item: id, p_house: houseId, p_room: room || null }); },
      saveItem: function (i) { return rpc('stg_save_item', { p: i }); },
      deleteHouse: function (id) { return rpc('stg_delete_house', { p_id: id }); },
      deleteItem: function (id) { return rpc('stg_delete_item', { p_id: id }); },
      setRequest: function (id, status) { return rpc('stg_set_request', { p_id: id, p_status: status }); },

      catalogImport: function (rows, replace) {
        // 400 rows a call keeps each request small; only the first call clears
        var chunks = [];
        for (var i = 0; i < rows.length; i += 400) chunks.push(rows.slice(i, i + 400));
        var total = 0;
        return chunks.reduce(function (p, chunk, k) {
          return p.then(function () {
            return rpc('stg_catalog_import', { p_rows: chunk, p_replace: !!replace && k === 0 });
          }).then(function (n) { total += n || 0; });
        }, Promise.resolve()).then(function () { return total; });
      },
      catalogSearch: function (q) { return rpc('stg_catalog_search', { p_q: q }); },

      lots: function () {
        return client().then(function (c) {
          return c.from('lots').select('lot_no,title,image_path,retail_cents,status').order('lot_no', { ascending: false }).limit(200);
        }).then(function (r) { if (r.error) throw explain(r.error); return r.data; });
      },

      uploadPhoto: function (blob) {
        var name = 'pieces/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
        return client().then(function (c) {
          return c.storage.from('staging').upload(name, blob, { contentType: 'image/jpeg', upsert: false })
            .then(function (r) {
              if (r.error) throw explain(r.error);
              return c.storage.from('staging').getPublicUrl(name).data.publicUrl;
            });
        });
      },

      publicHouse: function (code) { return rpc('stg_house_public', { p_code: code }); },
      sendRequest: function (code, tagNo, name, phone, email, note, kind) {
        return rpc('stg_request', { p_code: code, p_tag_no: tagNo, p_name: name, p_phone: phone, p_email: email, p_note: note, p_kind: kind || null });
      }
    };
  }

  global.HLS_API = CFG.backend === 'demo' ? demoBackend() : supabaseBackend();

  /* ---------- small things every page needs ---------- */
  global.HLS = {
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    money: function (cents, blank) {
      if (cents == null) return blank == null ? '' : blank;
      var d = cents / 100;
      return '$' + d.toLocaleString('en-US', { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
    },
    /* Only http(s) and same-site paths become links or image sources. */
    safeUrl: function (u) {
      u = String(u == null ? '' : u).trim();
      if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
      if (/^[a-z0-9_\-./]+$/i.test(u) && u.indexOf('//') === -1) return u;
      return '';
    },
    houseUrl: function (code, tagNo) {
      var base = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && CFG.backend === 'demo'
        ? location.href.replace(/[^/]*([?#].*)?$/, '')
        : (CFG.publicBase || location.href.replace(/[^/]*([?#].*)?$/, ''));
      return base + 'house.html?h=' + encodeURIComponent(code) + (tagNo ? '#t' + tagNo : '');
    }
  };
})(window);

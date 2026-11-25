/* Hughes Living Staging — where the data comes from.

   supabase  the real thing. Same project as Hughes Living Auctions; the staging
             tables are added by supabase/0001_staging.sql. Staff sign in with
             their auction office account.
   demo      sample houses and furniture kept in this browser only. Nothing is
             shared and a buyer's phone cannot see it. Used automatically on
             localhost so the pages can be tried without touching real data.

   Add ?backend=supabase or ?backend=demo to any page to switch; the choice is
   remembered in this browser. */

(function () {
  var pick = new URLSearchParams(location.search).get('backend');
  try {
    if (pick === 'demo' || pick === 'supabase') localStorage.setItem('hls-backend', pick);
    pick = localStorage.getItem('hls-backend');
  } catch (e) { /* private window: fall through to the default */ }
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  window.HLS_CONFIG = {
    backend: pick || (local ? 'demo' : 'supabase'),

    supabaseUrl: 'https://otkkmcxgufrspwipdfgk.supabase.co',
    // Publishable key. Public by design; the staging tables are closed to it
    // and only the functions in 0001_staging.sql answer. The SECRET key must
    // never appear here.
    supabaseAnonKey: 'sb_publishable_JhOEnBchDxRL-KgYiEG2fw_Z9bHBiT-',

    // What the QR codes point at. Printed cards are permanent, so change this
    // BEFORE printing if the site will live on another domain.
    publicBase: 'https://jhughes281.github.io/hughes-living-staging/',

    storeUrl: 'https://hugheslivingco.com/',
    auctionUrl: 'https://hugheslivingauctions.com/',

    // Shown on the buyer page when filled in. Left empty until Jay supplies them.
    contactPhone: '',
    contactEmail: '',

    // Services a signed-in customer can ask for, for one of their houses.
    // Carpet prices are a copy of Richard's own price book
    // (richards-carpet-cleaning/supabase/functions/_shared/pricing.js) and of
    // stg_carpet_estimate() in supabase/0003_services.sql. A test compares all
    // three, so change them together.
    services: {
      carpet: {
        name: "Richard's Carpet Cleaning & Upholstery",
        url: 'https://jhughes281.github.io/richards-carpet-cleaning/',
        maxRooms: 8,
        firstRoomCents: 7900,
        extraRoomCents: 2000,
        addons: [
          { key: 'addon_hall', label: 'Hallway', cents: 2500 },
          { key: 'addon_stairs', label: 'Stairs', cents: 4500 },
          { key: 'addon_pet', label: 'Pet treatment', cents: 4900 },
          { key: 'addon_scotchgard', label: 'Scotchgard', cents: 3900 },
          { key: 'addon_sofa', label: 'Sofa or loveseat', cents: 7900 }
        ]
      },

      // Hughes Move & Tote Co. A copy of the RATES object on its own site
      // (hughes-move-tote/index.html) and of stg_move_estimate() in
      // supabase/0004_move_tote.sql; the same test compares all three. The
      // mobile app repo is NOT a source: its prices were made up by a generator.
      move: {
        name: 'Hughes Move & Tote Co.',
        url: 'https://jhughes281.github.io/hughes-move-tote/',
        toteTiers: [                       // rental only, per tote per week; first match wins
          { min: 40, cents: 225 },
          { min: 20, cents: 275 },
          { min: 0, cents: 350 }
        ],
        toteWithMoveCents: 150,            // per tote per week when booked with the crew
        toteMinimumCents: 9900,            // floor on a rental-only order
        truckHourlyCents: { '16ft': 10900, '26ft': 12900 },   // includes 2 movers
        extraMoverCents: 4500,             // per mover beyond 2, per hour
        tripFeeCents: 9500,
        minHours: 2,
        maxHours: 12, maxMovers: 4, maxTotes: 200, maxWeeks: 12   // limits of this form, not of the business
      }
    }
  };
})();

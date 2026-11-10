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
    contactEmail: ''
  };
})();

/* Hughes Living Staging — the gallery.

   All nine photos, a small file in the grid and the full one in the viewer.
   The order is the layout: the first photo runs full width, the rest fall
   into two columns at their own proportions, so nothing is cropped. */

(function () {
  'use strict';

  // n = file number in img/gallery/, w/h = the full image's size (reserves space before it loads)
  var SHOTS = [
    { n: 3, w: 1381, h: 778,  cap: 'Open-plan living and dining', alt: 'A long open-plan room: linen sofa, two leather sling chairs, a fluted stone coffee table, and a dining table by the windows' },
    { n: 6, w: 1600, h: 900,  cap: 'Fireside living room', alt: 'A cream sectional and a low walnut coffee table facing a stone fireplace, under a ring chandelier' },
    { n: 9, w: 1600, h: 900,  cap: 'Stone hearth sectional', alt: 'A white sectional with black pillows around a square wood coffee table, beside a stacked-stone fireplace' },
    { n: 1, w: 1536, h: 1024, cap: 'One house, four rooms', alt: 'Four staged rooms from one home: living room, dining room, kitchen with woven counter stools, and bedroom' },
    { n: 8, w: 1600, h: 900,  cap: 'Navy accents', alt: 'A light grey sectional with navy pillows and throw, a metal-framed coffee table, and three abstract canvases on a dark wall' },
    { n: 7, w: 1536, h: 1024, cap: 'Media wall living room', alt: 'A tufted sectional and a round wood coffee table facing a slatted media wall with lit shelves' },
    { n: 2, w: 1358, h: 767,  cap: 'Natural oak and linen', alt: 'Three rooms in oak, cane and linen: a living room, a dining table set for a meal, and a bedroom with olive bedding' },
    { n: 4, w: 1390, h: 780,  cap: 'Soft neutrals, five rooms', alt: 'Five rooms in soft grey and wood: living room, dining room, bedroom, entry console and a reading chair' },
    { n: 5, w: 1024, h: 1024, cap: 'A whole house, room by room', alt: 'Twelve photos of one staged house: living room, dining room, kitchen, bedrooms and sitting areas' }
  ];

  var grid = document.getElementById('shots');
  var viewer = document.getElementById('viewer');
  var img = document.getElementById('viewerImg');
  var cap = document.getElementById('viewerCap');
  var count = document.getElementById('viewerN');
  var at = 0, opener = null;

  grid.innerHTML = SHOTS.map(function (s, i) {
    return '<figure class="shot' + (i === 0 ? ' shot--lead' : '') + '">' +
      '<button class="shot__btn" type="button" data-i="' + i + '" aria-label="View full size: ' + s.cap + '">' +
        '<img src="img/gallery/look-' + s.n + (i === 0 ? '' : '-sm') + '.webp" alt="' + s.alt + '" width="' + s.w + '" height="' + s.h + '"' +
        (i < 3 ? '' : ' loading="lazy"') + '></button>' +
      '<figcaption>' + s.cap + '</figcaption></figure>';
  }).join('');

  function show(i) {
    at = (i + SHOTS.length) % SHOTS.length;
    var s = SHOTS[at];
    img.src = 'img/gallery/look-' + s.n + '.webp';
    img.alt = s.alt;
    img.width = s.w; img.height = s.h;
    cap.textContent = s.cap;
    count.textContent = (at + 1) + ' / ' + SHOTS.length;
  }

  grid.addEventListener('click', function (e) {
    var b = e.target.closest('[data-i]');
    if (!b) return;
    opener = b;
    show(Number(b.getAttribute('data-i')));
    viewer.showModal();
  });
  document.getElementById('viewerPrev').addEventListener('click', function () { show(at - 1); });
  document.getElementById('viewerNext').addEventListener('click', function () { show(at + 1); });
  document.getElementById('viewerClose').addEventListener('click', function () { viewer.close(); });
  viewer.addEventListener('click', function (e) { if (e.target === viewer) viewer.close(); });
  viewer.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') show(at - 1);
    else if (e.key === 'ArrowRight') show(at + 1);
  });
  viewer.addEventListener('close', function () { if (opener) opener.focus(); });
})();

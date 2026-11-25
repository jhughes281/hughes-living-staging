/* Hughes Living Staging — what the pages know.

   Words only, no data: what each login is for, what a room usually needs, and
   general staging practice. app.js draws it on the Guide tab, and pulls single
   lines from it into the dashboards and house pages so they have something to
   say before any houses exist.

   Nothing here is a Hughes Living policy (fees, delivery, timing). Those are
   Jay's to write; this file sticks to what the site itself does and to common
   staging practice. */

(function () {
  'use strict';

  /* One entry per login. `can` is what that login does here, `hughes` is what
     stays with Hughes Living. Both mirror the rules in api.js and the database. */
  var ROLES = {
    self: {
      name: 'Staging it myself',
      line: 'One house: your own. You choose the furniture and buyers scan a QR code to buy it.',
      can: ['Add your house and its dates', 'Choose from the furniture that is free in the Hughes Living warehouse, room by room',
            'Print the QR card for the house and a tag for every piece', 'See what buyers ask for', 'Request a carpet cleaning'],
      hughes: ['Sets the staging fee', 'Follows up with every buyer and takes the payment', 'Collects the pieces that sell']
    },
    designer: {
      name: 'Interior designer',
      line: 'Several client houses at once, all drawing on the same Hughes Living warehouse.',
      can: ['Add a house for each client, with the client on file', 'Place and send back warehouse pieces across all your projects',
            'Keep go-in and come-out days, so they show under Coming up', 'Print QR cards and tags for each house',
            'See what buyers ask for in your houses', 'Request a carpet cleaning before install day'],
      hughes: ['Sets the staging fee for each house', 'Follows up with every buyer and takes the payment', 'Collects the pieces that sell']
    },
    realtor: {
      name: 'Realtor',
      line: 'Your listings, each with a QR code buyers scan at a showing.',
      can: ['Add each listing, with the seller on file and the listing link', 'Choose warehouse furniture for a listing, room by room',
            'Print the QR card and tags, and copy the buyer link to send', 'See who scanned and what they asked for',
            'Request a carpet cleaning before the listing photos'],
      hughes: ['Sets the staging fee for each listing', 'Follows up with every buyer and takes the payment', 'Collects the pieces that sell']
    },
    owner: {
      name: 'Hughes Living office',
      line: 'Everything: every house and piece, what each cost, every buyer, and the money.',
      can: ['Add furniture by hand, from the store catalog or from an auction lot', 'Add houses and hand one to a customer account (Edit, then Staged by)',
            'Set each staging fee', 'Work the Requests and Services inboxes', 'Mark pieces on hold or sold, and see profit per house'],
      hughes: []
    }
  };

  /* What a room usually has. `k` is matched against a piece's name and category,
     so "Grey 3-piece sectional" counts as the sofa. */
  var ROOMS = {
    'Living room': [
      { n: 'Sofa or sectional', k: /sofa|sectional|couch|loveseat/i }, { n: 'Accent chair', k: /chair/i },
      { n: 'Coffee table', k: /coffee|cocktail|ottoman/i }, { n: 'Rug', k: /rug/i },
      { n: 'Lamp', k: /lamp|light/i }, { n: 'Art or a mirror', k: /art|mirror|print|canvas/i }],
    'Dining room': [
      { n: 'Dining table', k: /table/i }, { n: 'Dining chairs', k: /chair|bench/i },
      { n: 'Rug', k: /rug/i }, { n: 'Art or a mirror', k: /art|mirror|print|canvas/i }],
    'Kitchen': [{ n: 'Counter stools', k: /stool/i }],
    'Primary bedroom': [
      { n: 'Bed or headboard', k: /bed|headboard/i }, { n: 'Nightstands', k: /nightstand|night stand|bedside/i },
      { n: 'Lamps', k: /lamp|light/i }, { n: 'Dresser', k: /dresser|chest/i }, { n: 'Rug', k: /rug/i }],
    'Bedroom 2': [{ n: 'Bed or headboard', k: /bed|headboard/i }, { n: 'Nightstand', k: /nightstand|night stand|bedside/i }, { n: 'Lamp', k: /lamp|light/i }],
    'Bedroom 3': [{ n: 'Bed or headboard', k: /bed|headboard/i }, { n: 'Nightstand', k: /nightstand|night stand|bedside/i }, { n: 'Lamp', k: /lamp|light/i }],
    'Office': [{ n: 'Desk', k: /desk/i }, { n: 'Chair', k: /chair/i }, { n: 'Lamp', k: /lamp|light/i }, { n: 'Bookcase or shelf', k: /book|shelf|shelv/i }],
    'Entry': [{ n: 'Bench or console', k: /bench|console/i }, { n: 'Mirror', k: /mirror/i }],
    'Patio': [{ n: 'Seating', k: /chair|sofa|bench|seat/i }, { n: 'Small table', k: /table/i }]
  };

  /* The guide itself. `who` lists the logins a topic is shown to (none = all).
     `when` ties a topic to a house's stage, so a dashboard can show the one
     that fits. Each point is one plain sentence. */
  var TOPICS = [
    { id: 'before', title: 'Before any furniture goes in', when: 'empty',
      lead: 'Furniture hides nothing. An empty house is the one chance to fix what a buyer will notice.',
      points: ['Take down family photos, collections and anything on the fridge. Buyers should picture their own things.',
               'Deep clean, carpets included, while the rooms are empty. A cleaning can be requested from the Services tab.',
               'Patch nail holes and touch up paint. One light neutral through the main rooms photographs best.',
               'Fix what a buyer will try: sticking doors, dripping taps, loose handles, dead switches.',
               'Put the same warm-white bulb in every fixture, and replace any that are out.',
               'Open the blinds and clean the windows. Daylight does more than any lamp.'] },
    { id: 'rooms', title: 'Which rooms to stage first', when: 'choosing',
      lead: 'Not every room needs furniture. Put the pieces where buyers spend their time and where the photos start.',
      points: ['First: the living room, the primary bedroom, and the kitchen and dining area.',
               'Next: the entry, because it sets the first impression.',
               'Spare bedrooms and an office can be light: a bed and a lamp, or a desk and a chair, is enough to name the room.',
               'An awkward space is worth a piece or two if it answers the question of what the room is for.'] },
    { id: 'kit', title: 'What each room usually needs', when: 'choosing', rooms: true,
      lead: 'A starting list, not a rule. A house page shows what a room is still missing from this list.' },
    { id: 'layout', title: 'Scale and layout', when: 'choosing',
      lead: 'The aim is rooms that look bigger and easy to walk through, in person and in a wide-angle photo.',
      points: ['Leave a clear path of about three feet through every room and to every door.',
               'In a large room, pull the seating off the walls into one group around a rug.',
               'A rug should be big enough that the front legs of the seating sit on it.',
               'Give each room one thing to look at: a fireplace, a window, a headboard wall. Face the furniture toward it.',
               'A few larger pieces read better than many small ones.'] },
    { id: 'photos', title: 'Photo day', when: 'ready',
      lead: 'Stage first, photograph second. The listing photos are where most buyers first see the furniture.',
      points: ['Every light on, every blind open.',
               'Toilet lids down, bins and cords out of sight, counters nearly bare.',
               'Cars off the driveway and the hose put away for the front shot.',
               'Leave the price tags on. Tuck them to the back or side of each piece so they do not lead the photo.',
               'Add one good wide shot as the house cover photo (Edit on the house). It leads the page buyers open.'] },
    { id: 'qr', title: 'The QR card and the tags', when: 'staged',
      lead: 'One code for the house, one tag for every piece. The buyer page only opens once the house is marked Staged.',
      points: ['Print the card and tags from the house page, on plain letter paper.',
               'Stand the card where people stop: the kitchen counter or the entry table.',
               'Hang a tag on every piece. Scanning a tag opens the buyer page at that piece.',
               'Added a piece after printing? Print its tag from the same page; the house code does not change.',
               'A piece shows its room on the buyer page, so move it on the house page if you move it in the house.'] },
    { id: 'buyers', title: 'When a buyer wants a piece', when: 'staged',
      lead: 'A buyer taps Buy this piece, or Buy the look for everything still available. That is an order, not a payment.',
      points: ['The order goes to the Hughes Living office with the buyer&rsquo;s name and how to reach them.',
               'Hughes Living contacts the buyer, confirms the piece and takes the payment.',
               'You see the order and its status here, but not the buyer&rsquo;s phone or email.',
               'A piece being held shows On hold; once paid for it shows Sold, on your screens and on the buyer page.',
               'A sold piece cannot be sent back from here. Hughes Living collects it.'] },
    { id: 'end', title: 'When the staging ends', when: 'ending',
      lead: 'Set the day the furniture comes out as soon as you know it, then close the house out.',
      points: ['The come-out day shows on your dashboard and counts down through the last week.',
               'Send back any piece you are done with from the house page. It is free for other houses straight away.',
               'Mark the house Destaged when the furniture is out. The buyer page then says the staging has ended.',
               'Printed cards for that house stop working as a shop, so take them down with the furniture.'] },

    { id: 'living', title: 'Living in the house while it is staged', who: ['self'],
      lead: 'A staged house you still live in has to be ready to show on short notice.',
      points: ['Keep counters, the dining table and nightstands clear; a basket you can carry out in one trip helps.',
               'Leave the tags on, and leave tagged pieces in the room the buyer page lists them in.',
               'Use the furniture gently. A buyer is paying the tag price for it.'] },
    { id: 'projects', title: 'Running several projects at once', who: ['designer'],
      lead: 'Every project draws on the same warehouse, so the board is only as good as what is entered.',
      points: ['A piece placed in one house is no longer free for another. Place it when you have decided, not before.',
               'Send back what you do not use so it shows as free again, for you and for everyone else.',
               'Enter the go-in and come-out day on each house. That is what fills Coming up.',
               'Put the client on each house. Only you and Hughes Living see it; buyers never do.'] },
    { id: 'link', title: 'Using the buyer link on a listing', who: ['realtor'],
      lead: 'The buyer link opens the same page as the QR code, so it works for people who are not in the house.',
      points: ['Copy it from the listing row once the listing is marked Staged, and text or email it after a showing.',
               'Say in the showing instructions that the furniture is for sale and the QR card is on the counter.',
               'Check your MLS rules before putting any link in public remarks; agent remarks are usually the safer place.',
               'Put the seller on each listing. Only you and Hughes Living see it; buyers never do.'] },

    { id: 'office', title: 'Running the office', who: ['owner'],
      lead: 'The office is the only login that sees cost, buyers&rsquo; contact details and every account.',
      points: ['Requests: every order and question from a buyer page. Call or write, then set it Contacted, Sold or Closed.',
               'Services: carpet cleanings customers have asked for. Arrange the visit, then set it Scheduled and Done.',
               'Furniture: add a piece by hand, from the store catalog (load the Shopify export once) or from an auction lot. Cost stays in the office.',
               'To hand a house to a customer, open it, choose Edit and set Staged by. The staging fee is set on the same form.',
               'Money: profit per house is the fee plus sales, less what the sold pieces cost. Truck, labor, storage and sales tax are not in it.'] }
  ];

  window.HLS_GUIDE = { roles: ROLES, rooms: ROOMS, topics: TOPICS };
})();

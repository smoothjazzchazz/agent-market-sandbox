import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sellers = [
  ["seller_ada", "Ada Ortiz", "Ada makes small-batch housewares from a studio in Duluth."],
  ["seller_noah", "Noah Bennett", "Noah sells refurbished electronics and trail gear."],
  ["seller_priya", "Priya Shah", "Priya stocks kitchen tools and desk accessories."],
  ["seller_leo", "Leo Martins", "Leo builds simple furniture and cycling kit."],
];

const groups = [
  ["audio", [
    ["Pocket Radio", 3200, "A compact AM/FM radio with a clip and a single dial."],
    ["Desk Headphones", 5400, "Closed headphones for a shared room. Cloth ear pads."],
    ["Aux Speaker", 2800, "A small speaker with a cloth grille and a 3.5 mm jack."],
    ["Studio Mic", 8900, "A cardioid microphone on a short stand."],
    ["Replacement Cable", 1400, "A braided 3.5 mm cable, one meter."],
    ["Earplugs Pair", 900, "Soft silicone earplugs in a tin."],
    ["Turntable Brush", 1600, "Carbon-fiber brush for vinyl."],
    ["Shelf Speakers", 12000, "A pair of passive bookshelf speakers."],
    ["Audio Interface", 15000, "Two-input USB audio interface."],
    ["Headphone Stand", 2200, "Bent plywood stand for one pair of headphones."],
  ]],
  ["computers", [
    ["USB-C Hub", 3600, "Three ports and one HDMI plug on a short lead."],
    ["Mechanical Keyboard", 7400, "A compact keyboard with brown switches."],
    ["Wired Mouse", 1800, "A symmetrical wired mouse."],
    ["Laptop Stand", 4200, "Aluminum stand that raises a laptop to eye height."],
    ["Webcam Cover", 600, "A sliding cover that fits most webcams."],
    ["Monitor Lamp", 3100, "A bar lamp that clips to the top of a monitor."],
    ["External SSD", 9800, "A 1 TB solid-state drive in a metal shell."],
    ["Ethernet Adapter", 1900, "USB to Ethernet adapter."],
    ["Cable Tray", 2500, "An under-desk tray for a power strip."],
    ["Drawing Tablet", 11000, "A small pen tablet for notes and markup."],
  ]],
  ["kitchen", [
    ["Harbor Whistle Kettle", 2400, "A stainless kettle with a whistle lid. Holds one liter."],
    ["Stoneware Soup Bowl", 1200, "A deep bowl glazed in oat."],
    ["Linen Tea Towel Set", 1800, "Two linen towels, undyed."],
    ["Beechwood Spoon", 900, "A long stirring spoon."],
    ["Small Prep Knife", 2100, "A short kitchen knife with a wood handle."],
    ["Cast Iron Skillet", 4500, "A 10 inch seasoned skillet."],
    ["Stand Mixer", 15000, "A tilt-head mixer with one bowl."],
    ["Glass Storage Set", 3200, "Three glass containers with locking lids."],
    ["Espresso Pot", 8000, "A stovetop espresso pot for four cups."],
    ["Oak Cutting Board", 6000, "An edge-grain oak board."],
  ]],
  ["furniture", [
    ["Side Table", 8400, "A round side table in white oak."],
    ["Wall Shelf", 3600, "A single pine shelf with hidden brackets."],
    ["Desk Lamp", 4800, "An adjustable arm lamp with a linen shade."],
    ["Entry Bench", 12000, "A short bench with a lower rack for shoes."],
    ["Coat Hook Rail", 2200, "Four hooks on an oak rail."],
    ["Nightstand", 9600, "One drawer and an open shelf."],
    ["Floor Mirror", 14000, "A full-length mirror in a black frame."],
    ["Bookend Pair", 1800, "Two steel bookends."],
    ["Waste Bin", 2600, "A steel bin with a soft-close lid."],
    ["Stool", 5400, "A backless stool, counter height."],
  ]],
  ["camping", [
    ["Cedar Camp Lantern", 4200, "A rechargeable lantern in a cedar frame."],
    ["Enamel Mug", 1600, "A white enamel mug with a blue rim."],
    ["Wool Blanket", 7800, "A striped wool blanket, twin size."],
    ["Pack Towel", 1400, "A quick-dry towel that stuffs into its pocket."],
    ["Trail Notebook", 1100, "A waterproof notebook, 48 pages."],
    ["Two-Person Tent", 18000, "A freestanding tent with aluminum poles."],
    ["Sleeping Pad", 6400, "An inflatable pad, three-quarter length."],
    ["Camp Stove", 5200, "A single-burner stove for screw-top canisters."],
    ["Water Bottle", 2000, "A steel bottle, 750 ml."],
    ["Headlamp", 2800, "A headlamp with a red night mode."],
  ]],
  ["cycling", [
    ["Front Light", 3400, "A USB front light, 400 lumens."],
    ["Rear Light", 1800, "A USB rear light with a steady and a pulse mode."],
    ["Patch Kit", 700, "Vulcanizing patches and a small grater."],
    ["Mini Pump", 2600, "A frame-mounted pump with a hose."],
    ["Bottle Cage", 1500, "An alloy cage for a standard bottle."],
    ["U-Lock", 4800, "A mid-size U-lock with two keys."],
    ["Saddle Bag", 3200, "A wedge bag that fits a spare tube."],
    ["Repair Stand Hook", 2200, "A portable hook that hangs a bike from a branch or beam."],
    ["Cycling Cap", 1900, "A cotton cap with a short brim."],
    ["Floor Pump", 4500, "A steel floor pump with a gauge."],
  ]],
];

const categories = [
  ["electronics", "Electronics", null],
  ["audio", "Audio", "electronics"],
  ["computers", "Computers", "electronics"],
  ["home", "Home", null],
  ["kitchen", "Kitchen", "home"],
  ["furniture", "Furniture", "home"],
  ["outdoors", "Outdoors", null],
  ["camping", "Camping", "outdoors"],
  ["cycling", "Cycling", "outdoors"],
];

const listings = [];
for (const [categoryId, items] of groups) {
  items.forEach((item, index) => {
    const [title, price_cents, description] = item;
    const n = String(index + 1).padStart(2, "0");
    const seller = sellers[index % sellers.length][0];
    listings.push({
      id: `${categoryId.slice(0, 3)}_${n}`,
      seller_id: seller,
      category_id: categoryId,
      title,
      description,
      price_cents,
      stock: 4 + (index % 5),
    });
  });
}

const catalog = {
  seed_version: "v1",
  categories: categories.map(([id, name, parent_id]) => ({ id, name, parent_id })),
  users: [
    ...sellers.map(([id, name, bio]) => ({
      id,
      name,
      kind: "seller",
      bio,
      wallet_cents: 0,
    })),
    {
      id: "buyer_mina",
      name: "Mina Cole",
      kind: "buyer",
      bio: "Mina keeps a small apartment kitchen and a weekend bike.",
      wallet_cents: 80000,
    },
    {
      id: "buyer_jon",
      name: "Jon Ellis",
      kind: "buyer",
      bio: "Jon is furnishing a first desk.",
      wallet_cents: 400,
    },
    {
      id: "buyer_ruth",
      name: "Ruth Hale",
      kind: "buyer",
      bio: "Ruth cooks for a household of three.",
      wallet_cents: 12000,
    },
  ],
  listings,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "catalog.json");
writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
console.log(`listings ${listings.length}`);
console.log(listings.filter((l) => l.category_id === "kitchen" && l.price_cents < 2500).map((l) => l.id).join(","));
console.log(listings.find((l) => l.title === "Harbor Whistle Kettle").id);
console.log(listings.find((l) => l.title === "Cedar Camp Lantern").id);

/**
 * Curated product-family rules for scripts/fetch-item-images.cjs.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Most of the catalog is private-label / house SKUs. Searching the web for
 * "DI-4W/200-N1-KIT.xx" returns nothing useful, and 408 rows share that shape —
 * a per-SKU sweep would produce 408 confidently-wrong pictures. Those rows are
 * also, physically, the same handful of products with different amperage and
 * enclosure options, so one correct photo per family is both cheaper AND more
 * accurate than one bad guess per row.
 *
 * A rule is tried against the item's `name` and `sales_desc`. FIRST MATCH WINS,
 * so this array runs most-specific to most-general. Rows that match nothing here
 * fall through to a per-SKU image search built from their own description.
 *
 * Each family resolves to ONE image, fetched once and reused by every row in it
 * (stored at family/<id>.webp). To pin a family to a picture you already trust,
 * paste a direct image URL into `imageUrl` — that skips search entirely and is
 * the fastest way to fix a family that keeps matching badly.
 *
 * EDITING: this is meant to be edited by hand as the catalog is reviewed. Add a
 * rule, re-run the script with `--refresh --only <regex>`, done.
 */

/**
 * @typedef {Object} FamilyRule
 * @property {string}  id          Stable slug. Also the storage filename. Don't rename casually.
 * @property {string}  label       Human name, shown in the script's summary output.
 * @property {RegExp} [name]       Tested against qb_item.name.
 * @property {RegExp} [desc]       Tested against qb_item.sales_desc. With `name`, BOTH must match.
 * @property {string}  query       Search phrase used when `imageUrl` is unset. Write it as a
 *                                 human would search for the physical object.
 * @property {string} [imageUrl]   Direct image URL. Set this to pin the family and skip search.
 * @property {number} [confidence] 0-100, recorded on every row in the family. Default 75.
 * @property {boolean}[none]       True = this family never gets a picture; rows are marked
 *                                 image_status='none' instead of being searched.
 */

/** @type {FamilyRule[]} */
const FAMILIES = [
  // ===== Non-products ======================================================
  // Catch these first or they soak up nonsense images from a generic search.
  {
    id: 'no-image-charge',
    label: 'Freight / labor / adders / misc charges',
    name: /^(FREIGHT|SHIPPING|LABOR|TAX|DISCOUNT|NON-INVENTORY PART SALES|MISC|RESTOCK)/i,
    none: true,
    query: '',
  },
  {
    id: 'no-image-option-adder',
    label: 'Option adders (priced line items, no physical part)',
    name: /(-Option-Adder|OPTION ADDER|ADDER$)/i,
    none: true,
    query: '',
  },
  {
    id: 'no-image-literature',
    label: 'Brochures / literature / standards',
    name: /(Brochure|Catalog|HANDBOOK|STANDARD &)/i,
    none: true,
    query: '',
  },
  {
    id: 'no-image-software',
    label: 'Software / licences / hosted tenants',
    desc: /(licen[cs]e|webserver|Additional \d+\+? Tenants|subscription|software)/i,
    none: true,
    query: '',
  },

  // ===== DI-* smart meter kits (the 408-row cluster) =======================
  // Split by enclosure, because that IS the visual difference between them.
  // The amperage and CT options inside don't change the photo.
  {
    id: 'di-mmu',
    imageUrl:
      'https://honeywell.scene7.com/is/image/Honeywell65/hbt-BMS-P1904525-primaryimage?wid=900',
    label: 'DI multiple meter unit (MMU panel)',
    name: /^E?\d*-?DI-MMU/i,
    query: 'multi-circuit branch panel submeter multiple meter unit enclosure',
    confidence: 85,
  },
  {
    id: 'di-meter-n4x',
    imageUrl:
      'https://honeywell.scene7.com/is/image/Honeywell65/hbt-bms-e3212025hvjbackit-class3200smartmeter-primaryimage?wid=900',
    label: 'DI smart meter kit — NEMA 4X/6P enclosure',
    name: /^E?\d*-?DI-/i,
    desc: /NEMA 4X/i,
    query: 'NEMA 4X polycarbonate enclosure electric submeter kit',
    confidence: 85,
  },
  {
    id: 'di-meter-jic',
    imageUrl:
      'https://honeywell.scene7.com/is/image/Honeywell65/hbt-bms-e3212025hvjbackit-class3200smartmeter-primaryimage?wid=900',
    label: 'DI smart meter kit — NEMA 3R/4/12 JIC steel enclosure',
    name: /^E?\d*-?DI-/i,
    desc: /(NEMA 3R|JIC|4\/12)/i,
    query: 'NEMA 3R steel JIC enclosure electric submeter kit',
    confidence: 55,
  },
  {
    id: 'di-meter-n1',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/2022/07/PS3HD-wall-mount-hv-cover-transparent-composite-1200px-700x700.png',
    label: 'DI smart meter kit — NEMA 1 wallmount',
    name: /^E?\d*-?DI-/i,
    query: 'NEMA 1 wallmount electric submeter kit power meter',
    confidence: 80,
  },

  // ===== E-class meters ====================================================
  {
    id: 'e-class-meter',
    imageUrl:
      'https://honeywell.scene7.com/is/image/Honeywell65/hbt-bms-e3412025hvj01kit-class3400advancedkwhdeman-primaryimage?wid=900',
    label: 'Class 3200/3400 socket meter kit',
    desc: /Class 3[24]00 Meter/i,
    query: 'commercial electric revenue meter NEMA 4X enclosure kit',
    confidence: 85,
  },

  // ===== Current transformers ==============================================
  // Ordered by CT construction — these look genuinely different from each other,
  // and the description states which one it is.
  {
    id: 'ct-rogowski',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/2022/07/ctr24a4u_53cbdff5-7ab0-4cd1-b95b-914e783db0e0.jpg',
    label: 'Rogowski / rope coil CT',
    desc: /(Rogowski|Rope CT|RoCoil|Flexible Rope)/i,
    query: 'rogowski coil flexible rope current transformer',
    confidence: 85,
  },
  {
    id: 'ct-clamp-on',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/2022/09/ctcon0150ez_large.jpg',
    label: 'Clamp-on CT',
    desc: /CLAMP-?ON/i,
    query: 'clamp on current transformer split core amp probe',
    confidence: 85,
  },
  {
    id: 'ct-hinged',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/CT-HSC-020_No-Background.png',
    label: 'Hinged split-core CT',
    desc: /Hinged (Split-?Core )?CT|Hinged Split-?Core/i,
    query: 'hinged split core current transformer energy meter',
    confidence: 85,
  },
  {
    id: 'ct-solid-core',
    label: 'Solid-core CT',
    desc: /Solid[- ]Core CT/i,
    query: 'solid core donut current transformer revenue grade',
    confidence: 80,
  },
  {
    id: 'ct-split-core',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/CT-SCCM-0200-U-Open.png',
    label: 'Split-core CT',
    desc: /Split-?Core CT/i,
    query: 'split core current transformer submetering clamp',
    confidence: 85,
  },
  {
    id: 'ct-split-rect',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/CT-SCM-400-U-700x716.png',
    label: 'Rectangular slide-out split-core CT',
    desc: /Rectangular|Slide-?Out/i,
    name: /^CT/i,
    query: 'rectangular split core current transformer large busbar',
    confidence: 85,
  },
  {
    id: 'ct-generic',
    imageUrl:
      'https://www.dentinstruments.com/wp-content/uploads/CT-HMC-100_No-Background.png',
    label: 'Current transformer (unclassified)',
    name: /^CT[-\s]?[A-Z0-9]/i,
    query: 'split core current transformer submetering',
    confidence: 70,
  },

  // ===== Cable / leads =====================================================
  {
    id: 'cbl-ct-extension',
    label: 'CT lead extension cable',
    desc: /(CT (extension|Lead Length)|Lead Length Extension)/i,
    query: 'shielded twisted pair CT lead extension cable spool',
    confidence: 75,
  },
  {
    id: 'cbl-usb',
    label: 'USB cable',
    name: /^CBL USB/i,
    query: 'USB cable A to B black',
    confidence: 85,
  },
  {
    id: 'cbl-comms',
    label: 'RS-485 / BACnet communications cable',
    desc: /(RS-?485|MS\/TP|Communications Cable)/i,
    query: 'RS-485 shielded communications cable spool plenum',
    confidence: 75,
  },
  {
    id: 'cbl-network-spool',
    label: 'Cat5e/Cat6 network cable spool',
    desc: /Cat ?[56][Ae]? ?(Plus)?.*(Spool|1000ft)/i,
    query: 'Cat6A shielded network cable 1000ft spool box',
    confidence: 80,
  },

  // ===== Lamps / lighting ==================================================
  {
    id: 'lamp-par',
    label: 'PAR / MR LED lamp',
    desc: /\b(PAR\s?\d{2}|MR\s?16)\b/i,
    query: 'PAR30 LED flood lamp bulb',
    confidence: 75,
  },
  {
    id: 'lamp-highbay',
    label: 'Linear LED high bay',
    desc: /High ?Bay/i,
    query: 'linear LED high bay light fixture',
    confidence: 80,
  },
  {
    id: 'lamp-downlight',
    label: 'LED retrofit downlight',
    desc: /RETROFIT LED|downlight/i,
    query: '6 inch LED retrofit downlight trim',
    confidence: 75,
  },
  {
    id: 'lamp-linear-fluor',
    label: 'Linear fluorescent tube',
    desc: /\bF\d{2} ?T[58]\b/i,
    query: 'T5 linear fluorescent tube lamp',
    confidence: 75,
  },
  {
    id: 'light-pole',
    label: 'Steel light pole',
    desc: /Light pole/i,
    query: 'square straight steel light pole',
    confidence: 80,
  },

  // ===== Meters (non-electric) =============================================
  {
    id: 'water-meter',
    label: 'Water meter with pulse output',
    desc: /WATER ?(\/FLOW)? ?METER/i,
    query: 'cold water meter with pulse output brass',
    confidence: 80,
  },
  {
    id: 'gas-meter',
    label: 'Gas meter',
    desc: /\b(NG|Natural Gas)\b.*(CFH|IWC)|gas meter/i,
    query: 'natural gas diaphragm meter',
    confidence: 70,
  },

  // ===== Enclosures / hardware =============================================
  {
    id: 'enclosure',
    label: 'NEMA enclosure / meter housing',
    desc: /(NEMA ?[0-9]|Enclosure|Meter Housing)/i,
    query: 'NEMA polycarbonate hinged electrical enclosure box',
    confidence: 65,
  },
  {
    id: 'transformer-cpt',
    label: 'Control power transformer',
    desc: /VA,?.*Transformer|Class 2 Transformer/i,
    query: 'class 2 control power transformer 480 to 120 VAC',
    confidence: 80,
  },
  {
    id: 'fuse',
    label: 'Fuse',
    desc: /\bFuse\b/i,
    query: 'class CC time delay fuse 600V',
    confidence: 85,
  },
  {
    id: 'network-switch',
    label: 'Ethernet switch',
    desc: /Ethernet.*Switch/i,
    query: 'gigabit ethernet unmanaged switch DIN rail',
    confidence: 85,
  },
];

/**
 * First matching rule for a row, or null to fall through to a per-SKU search.
 * A rule with both `name` and `desc` requires both — that's how the DI-* rules
 * pick an enclosure without every DI row colliding on the first one.
 * @param {{name: string|null, sales_desc: string|null}} row
 * @returns {FamilyRule|null}
 */
function matchFamily(row) {
  const name = row.name || '';
  const desc = row.sales_desc || '';
  for (const rule of FAMILIES) {
    const nameOk = rule.name ? rule.name.test(name) : null;
    const descOk = rule.desc ? rule.desc.test(desc) : null;
    if (nameOk === null && descOk === null) continue;
    if (nameOk === false || descOk === false) continue;
    return rule;
  }
  return null;
}

module.exports = { FAMILIES, matchFamily };

/**
 * Regression tests for the catalog-image family rules.
 *
 * These matter more than they look: a single rule reordering can silently move
 * 400 DI-* rows into the wrong enclosure photo, and nothing downstream would
 * complain — the pictures would just be wrong on a printed sheet. The cases
 * below are real rows from qb_item.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchFamily, FAMILIES } = require('./image-families.cjs');

const row = (name, sales_desc = '') => ({ name, sales_desc });

describe('matchFamily', () => {
  it('splits DI meter kits by enclosure, not by amperage', () => {
    expect(matchFamily(row('DI-2W/200-N1-KIT.xx', '(1)-Phase, 2-Wire, NEMA 1 Wallmount Smart Meter')).id).toBe('di-meter-n1');
    expect(matchFamily(row('DI-4W/2000-N1-KIT.xx', '(3)-Phase, 4-Wire, NEMA 1 Wallmount Smart Meter')).id).toBe('di-meter-n1');
    expect(matchFamily(row('DI-2W/400-N4X-KIT.xx', 'NEMA 4X/6P Enclosure Smart Meter')).id).toBe('di-meter-n4x');
    expect(matchFamily(row('DI-2W/400-JIC-SCCT-KIT.xx', 'NEMA 3R, 4/12 Enclosure Smart Meter')).id).toBe('di-meter-jic');
  });

  it('keeps the MMU panel out of the plain meter families', () => {
    expect(matchFamily(row('DI-MMU56-JIC-(8)VR.xx', '56-Element HD Multiple Meter Unit. NEMA 3R, 4, 12')).id).toBe('di-mmu');
  });

  it('matches the E-prefixed DI variants the same way as the bare ones', () => {
    expect(matchFamily(row('E20-DI-4W/4000-7.5-N1-KIT.02', 'NEMA 1 Wallmount Smart Meter')).id).toBe('di-meter-n1');
  });

  it('does not let a DI kit fall into a CT family because its description mentions CTs', () => {
    // Every DI kit description ends "...w/(3) 200-Amp Split-Core CT". The DI
    // rules must win, or 400 meter kits get a picture of a CT.
    const m = matchFamily(row('DI-4W/200-N1-KIT.xx', '(3)-Phase, NEMA 1 Wallmount Smart Meter w/(3) 200-Amp Split-Core CT'));
    expect(m.id).toBe('di-meter-n1');
  });

  it('classifies CTs by construction', () => {
    expect(matchFamily(row('CTRCFX17L4000A3MSTV1', '4000A, Rogowski Coil, 17" length')).id).toBe('ct-rogowski');
    expect(matchFamily(row('CT-CON-0150EZ-U', 'CLAMP-ON CT, 1.0" OPENING')).id).toBe('ct-clamp-on');
    expect(matchFamily(row('CT-HMC-0100-U-7M', '100A, Hinged CT, 1.0" window, 7m Leads')).id).toBe('ct-hinged');
    expect(matchFamily(row('CT-RGT-19-0100-U', '100A, Solid Core CT, 0.75" window')).id).toBe('ct-solid-core');
    expect(matchFamily(row('100A - CT', '100-Amp Split-Core CT')).id).toBe('ct-split-core');
  });

  it('marks non-products as imageless instead of searching for them', () => {
    expect(matchFamily(row('FREIGHT', '')).none).toBe(true);
    expect(matchFamily(row('CTLSC N4X-Option-Adder', 'For outdoor NEMA 3R option')).none).toBe(true);
    expect(matchFamily(row('CT Brochure', 'TBWC Technology 5A Split-Core CT Brochure')).none).toBe(true);
    expect(matchFamily(row('OE-TEN500', 'Optergy P-TEN500 Additional 500+ Tenants')).none).toBe(true);
  });

  it('falls through to a per-SKU search when nothing fits', () => {
    expect(matchFamily(row('P-APS', 'Audio Paging System'))).toBeNull();
    expect(matchFamily(row('S-5735', 'Economy Strapping Tape - 3/4" x 60 yds'))).toBeNull();
  });

  it('gives every rule a unique id, since the id is the storage filename', () => {
    const ids = FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every searchable rule a query to search with', () => {
    for (const f of FAMILIES) {
      if (f.none || f.imageUrl) continue;
      expect(f.query, `${f.id} has no query`).toBeTruthy();
    }
  });
});

import { describe, it, expect } from 'vitest';
import { serialsFromDesc, extractOrderSerials } from './orderSerials';

// Every desc below is a verbatim shape from the live qb_invoice.lines data —
// the parser exists because staff type serials into these by hand.
describe('serialsFromDesc', () => {
  it('reads a single serial after "Serial #:"', () => {
    expect(serialsFromDesc(
      '(3)-Phase, 4-Wire, 3-Pole, 90-600V, NEMA 1 Wallmount Smart Meter. BACnet/Modbus Serial or IP. (DIPS3HD-C-D-N w/(3) WC0-10-MV333)\n\nSerial #: P032609156'
    )).toEqual(['P032609156']);
  });

  it('reads a comma-separated list after "Meter Serial #s:"', () => {
    expect(serialsFromDesc(
      '16-Element, High-Density Multi-Meter Unit.\n\nMeter Serial #s: P482609179, P482609058, P482609141'
    )).toEqual(['P482609179', 'P482609058', 'P482609141']);
  });

  it('reads serials off their own lines, with passwords alongside', () => {
    expect(serialsFromDesc(
      'DENTCloud Smart Meter w/(2) 100-Amp Split-Core CT. Modbus IP.\n\nMETER SERIAL # / PASSWORD\nP032508495 / 890G\nP032508478 / ZSLF\n'
    )).toEqual(['P032508495', 'P032508478']);
  });

  it('handles the PROTON prefix and an all-caps marker', () => {
    expect(serialsFromDesc('OPTERGY PROTON webserver.\n\nPROTON SERIAL # PR0007948\n*******PROTON NOT INCLUDED******'))
      .toEqual(['PR0007948']);
  });

  // 1200+ lines in the file say "Modbus Serial or IP" or "Serial Modbus and
  // BACnet Communications" — a protocol, not a serial. The part numbers in the
  // same text must not be mistaken for one either.
  it('ignores "serial" used as a protocol name', () => {
    expect(serialsFromDesc('4-Element Multi-Meter Unit, Modbus Serial or IP Communications. (DIPS48HD-C-D-N-G201608C)')).toEqual([]);
    expect(serialsFromDesc('(3) 50-Amp Split-Core CT. Serial Modbus and BACnet Communications. (WC1-100-MV333)')).toEqual([]);
  });

  // The same desc routinely ends with the shipping block; those numbers are
  // shipping_tracking's job (and would be wrong here).
  it('stops at the tracking block', () => {
    expect(serialsFromDesc('Smart Meter.\n\nSerial #: P032609192 | Tracking: 1ZK6B2030326969405 EJ123456789'))
      .toEqual(['P032609192']);
  });

  it('dedupes a serial repeated in one desc, and keeps typos verbatim', () => {
    expect(serialsFromDesc('Serial #: P32606298, P32606298')).toEqual(['P32606298']);
  });

  it('is empty for no desc, no marker, or a marker with no number', () => {
    expect(serialsFromDesc(null)).toEqual([]);
    expect(serialsFromDesc('100-Amp Split-Core CT, 36" lead length')).toEqual([]);
    expect(serialsFromDesc('METER SERIAL # / PASSWORD')).toEqual([]);
  });
});

describe('extractOrderSerials', () => {
  const invoice = {
    ref_number: '10503',
    txn_date: '2026-10-02',
    lines: [
      { item: 'DI-4W/50-N1-KIT.xx', desc: 'Smart Meter w/(3) 50-Amp CT.\n\nSerial #: P032609156' },
      { item: 'CT-RGT12-0050-U', desc: '50-Amp Split-Core CT: 0.72" window, 36" lead length' },
      { item: 'FREIGHT', desc: 'Tracking: 1ZK6B2030326969405' },
    ],
  };

  it('keeps only the lines that carry serials, with the source invoice', () => {
    expect(extractOrderSerials(invoice)).toEqual({
      invoice_ref: '10503',
      invoice_date: '2026-10-02',
      items: [{
        item: 'DI-4W/50-N1-KIT.xx',
        desc: 'Smart Meter w/(3) 50-Amp CT.\n\nSerial #: P032609156',
        serials: ['P032609156'],
      }],
    });
  });

  // No invoice at all vs. an invoice with no serials are different answers on
  // the form's tab ("not invoiced yet" vs. "none typed on invoice 10503").
  it('is null with no invoice, and an empty item list with no serials on one', () => {
    expect(extractOrderSerials(null)).toBeNull();
    expect(extractOrderSerials({ ref_number: '10503', txn_date: '2026-10-02', lines: [{ item: 'X', desc: 'no serials here' }] }))
      .toEqual({ invoice_ref: '10503', invoice_date: '2026-10-02', items: [] });
  });

  it('survives an invoice with no lines column', () => {
    expect(extractOrderSerials({ ref_number: '1', txn_date: null, lines: null }))
      .toEqual({ invoice_ref: '1', invoice_date: null, items: [] });
  });
});

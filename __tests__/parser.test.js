const {
    parseAsterixStream,
    parseRecord,
} = require("../parser");

// Helper to build a Uint8Array from simple JS number arrays
const U8 = (arr) => new Uint8Array(arr);

describe("ASTERIX parser (CAT 048 synthetic data)", () => {
    test("parses a simple CAT048 record with I048/010 and I048/040", () => {
        // FSPEC: one byte, b7=I048/010, b5=I048/040 => 1000_0000 + 0010_0000 = 0xA0
        // Items in order: I048/010 (2B), I048/040 (4B)
        // I048/010: SAC=0x12, SIC=0x34
        // I048/040: RHO=2560 (0x0A00) => 10 NM; THETA=16384 (0x4000) => 90 deg
        const buf = U8([
            0x30,             // CAT = 48
            0x00, 0x0A,       // LEN = 10 (1+2 + 1 FSPEC + 2 + 4)
            0xA0,             // FSPEC (FX=0)
            0x12, 0x34,       // I048/010
            0x0A, 0x00,       // I048/040 RHO
            0x40, 0x00,       // I048/040 THETA
        ]);

        const { record, nextOffset } = parseRecord(buf, 0);
        expect(nextOffset).toBe(buf.length);

        expect(record.category).toBe(48);
        expect(record.length).toBe(10);
        expect(record.fspec_hex).toBe("a0");

        expect(record.items["I048/010"]).toEqual({ sac: 0x12, sic: 0x34 });

        const pos = record.items["I048/040"];
        expect(pos.rho_raw).toBe(2560);
        expect(pos.theta_raw).toBe(16384);
        expect(pos.range_nm).toBeCloseTo(10.0, 6);
        expect(pos.bearing_deg).toBeCloseTo(90.0, 6);

        // no tail expected
        expect(record.rawItems._tail).toBeUndefined();
    });

    test("parses multi-byte FSPEC (I048/020 + I048/240)", () => {
        // FSPEC1: b6=I048/020 set, FX=1 => 0b0100_0001 = 0x41
        // FSPEC2: b7=I048/240 set, FX=0 => 0b1000_0000 = 0x80
        // Items in order: I048/020 (variable FX-chained, 1 octet w/FX=0), then I048/240 (3 bytes)
        // I048/020: 0x38 => dt=1, sim=1, rab=1, tst=0, mea=0, FX=0
        // I048/240: addr AABBCC
        const buf = U8([
            0x30,       // CAT = 48
            0x00, 0x09, // LEN = 9 (1+2 + 2 FSPEC + 1 + 3)
            0x41, 0x80, // FSPEC bytes
            0x38,       // I048/020 (single octet, FX=0)
            0xAA, 0xBB, 0xCC, // I048/240
        ]);

        const { record } = parseRecord(buf, 0);
        expect(record.fspec_hex).toBe("4180");

        const trd = record.items["I048/020"];
        expect(trd.raw).toBe("38");
        expect(trd.detectionType).toBe(1);
        expect(trd.simulated).toBe(true);
        expect(trd.reportedAsBad).toBe(true);
        expect(trd.testTarget).toBe(false);
        expect(trd.meaconing).toBe(false);

        const ms = record.items["I048/240"];
        expect(ms.icao24).toBe("AABBCC");
    });

    test("parses I048/140 Time-of-Day via 3rd FSPEC byte", () => {
        // We need 3 FSPEC bytes:
        //   FSPEC1: FX=1 -> 0x01
        //   FSPEC2: FX=1 -> 0x01
        //   FSPEC3: b3=I048/140 set, FX=0 -> 0x08
        // I048/140: 3 bytes raw in 1/128s => 3600s -> 3600*128 = 460800 = 0x07 08 00
        const buf = U8([
            0x30,       // CAT = 48
            0x00, 0x09, // LEN = 9 (1+2 + 3 FSPEC + 3 data)
            0x01, 0x01, 0x08, // FSPEC
            0x07, 0x08, 0x00, // I048/140 raw
        ]);

        const { record } = parseRecord(buf, 0);
        expect(record.fspec_hex).toBe("010108");

        const tod = record.items["I048/140"];
        expect(tod.raw).toBe(0x070800);
        expect(tod.seconds).toBeCloseTo(3600, 6);
    });

    test("parses a stream with multiple records concatenated", () => {
        const rec1 = U8([
            0x30, 0x00, 0x0A, 0xA0, 0x12, 0x34, 0x0A, 0x00, 0x40, 0x00,
        ]);
        const rec2 = U8([
            0x30, 0x00, 0x09, 0x41, 0x80, 0x38, 0xAA, 0xBB, 0xCC,
        ]);
        const stream = U8([...rec1, ...rec2]);

        const records = Array.from(parseAsterixStream(stream));
        expect(records).toHaveLength(2);

        expect(records[0].items["I048/010"]).toEqual({ sac: 0x12, sic: 0x34 });
        expect(records[1].items["I048/240"].icao24).toBe("AABBCC");
    });

    test("unknown category payload is preserved as raw", () => {
        // CAT=0x99 (unknown); FSPEC single byte (no items), but 2 bytes of raw payload afterward
        // LEN = 1+2 +1 +2 = 6
        const buf = U8([
            0x99,       // CAT unknown
            0x00, 0x06, // LEN
            0x00,       // FSPEC (no bits, FX=0)
            0xDE, 0xAD, // raw payload
        ]);

        const { record } = parseRecord(buf, 0);
        expect(record.category).toBe(0x99);
        expect(record.fspec_hex).toBe("00");
        expect(record.rawItems._unknownCategoryPayload).toBe("dead");
    });

    test("throws on truncated record body", () => {
        // Declared LEN is too long for available bytes
        const buf = U8([
            0x30,
            0x00, 0x0A, // says 10, but we only supply 4 bytes total
            0xA0,
        ]);
        expect(() => parseRecord(buf, 0)).toThrow(/Truncated record body/i);
    });

    test("throws on truncated FSPEC", () => {
        // FSPEC continuation bit set but no following byte present
        const buf = U8([
            0x30, 0x00, 0x04,
            0x01, // FSPEC with FX=1 but record ends here
        ]);
        expect(() => parseRecord(buf, 0)).toThrow(/Truncated FSPEC/i);
    });

    test("stops decoding gracefully when an FSPEC bit has no decoder", () => {
        // Create FIVE FSPEC bytes where:
        //  - First 4 FSPEC bytes only have FX=1 (0x01) and no item bits set
        //  - 5th FSPEC byte sets one item bit (e.g., b7) and FX=0 (0x80)
        // This produces an FSPEC longer than the CAT048 UAP we defined,
        // so when iterating fsBits, we'll reach a bit position with no UAP entry.
        //
        // Record length = 1 (CAT) + 2 (LEN) + 5 (FSPEC) = 8
        const buf = new Uint8Array([
            0x30,       // CAT 48
            0x00, 0x08, // LEN = 8 bytes total
            0x01,       // FSPEC1: FX=1, no items
            0x01,       // FSPEC2: FX=1, no items
            0x01,       // FSPEC3: FX=1, no items
            0x01,       // FSPEC4: FX=1, no items
            0x80,       // FSPEC5: b7 set (an "excess" bit), FX=0 (end)
        ]);

        const { record } = parseRecord(buf, 0);

        // We should not have decoded any items, and we should flag the excess bit.
        expect(record.items).toEqual({});
        expect(record.rawItems._excessFSPECBit).toBe(true);

        // No tail payload expected since there were no data items.
        expect(record.rawItems._tail).toBeUndefined();
    });

    test("parses CAT034 with TOD, sector, antenna period and 3D sensor pos", () => {
        // FSPEC1: 0xF9 -> I034/010, /000, /030, /020, /041; FX=1
        // FSPEC2: 0x10 -> I034/120; FX=0
        //
        // Items bytes: 2 + 1 + 3 + 1 + 2 + 8 = 17
        // Total LEN = 1 (CAT) + 2 (LEN) + 2 (FSPEC) + 17 (items) = 22 -> 0x0016

        const buf = new Uint8Array([
            0x22,             // CAT 34
            0x00, 0x16,       // LEN = 22  <-- was 0x0015; must be 0x0016
            0xF9, 0x10,       // FSPEC1, FSPEC2  <-- FSPEC2 changed from 0x80 to 0x10
            0x12, 0x34,       // I034/010 SAC/SIC
            0x01,             // I034/000 Message Type = North Marker
            0x00, 0x08, 0x00, // I034/030 TOD = 2048 (16.0 s)
            0x20,             // I034/020 Sector = 32 -> 45 deg
            0x01, 0x00,       // I034/041 Ant rotation = 256/128=2.0 s => 30 rpm
            // I034/120 3D position: height=+100m, lat≈+1 deg, lon≈-1 deg (synthetic)
            0x00, 0x64,       // height_m = 100
            0x02, 0xAA, 0xAA, // lat  (approx +1.0° in signed 24-bit scale)
            0xFD, 0x55, 0x56, // lon  (approx -1.0°)
        ]);

        const { record } = parseRecord(buf, 0);
        expect(record.category).toBe(34);
        expect(record.items["I034/010"]).toEqual({ sac: 0x12, sic: 0x34 });
        expect(record.items["I034/000"].type).toBe(1);
        expect(record.items["I034/030"].seconds).toBeCloseTo(16.0, 6);
        expect(record.items["I034/020"].sector_deg).toBeCloseTo(45.0, 6);
        expect(record.items["I034/041"].rpm).toBeCloseTo(30.0, 3);
        expect(record.items["I034/120"].height_m).toBe(100);
    });

});

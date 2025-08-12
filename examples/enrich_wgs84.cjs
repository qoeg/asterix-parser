const fs = require("node:fs");
const { parseAsterixStream } = require("../parser");
const { enrichAsterix } = require("../enricher");

// 1) Parse
const buf = fs.readFileSync("data/asterix.log");
const records = parseAsterixStream(buf);

// 2) Enrich with your radar site pose and date
const enriched = enrichAsterix(records, {
  sensorLatDeg: 42.362,      // example
  sensorLonDeg: -71.006,
  sensorAltM: 15,
  azimuthZeroRef: "north",   // common for radar
  clockwise: true,           // azimuth increases clockwise
  azimuthOffsetDeg: 0,       // apply your boresight calibration if any
  utcDate: "2025-08-12",     // same day as the data (UTC)
  altitudePreference: ["I048/110", "I048/090"],
  trackMemoryTtlMs: 120000
});

console.dir(enriched[0], { depth: null });

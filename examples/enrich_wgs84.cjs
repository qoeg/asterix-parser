const fs = require("node:fs");
const { parseAsterixStream } = require("../parser");
const { enrichAsterix } = require("../enricher");

// Create or clear the log file
fs.writeFileSync("data/wgs84.log", "");

// 1) Parse
const buf = fs.readFileSync("data/asterix.data");

for (let record of parseAsterixStream(buf)) {

  // 2) Enrich with your radar site pose and date
  const enriched = enrichAsterix([record], {
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

  fs.appendFileSync("data/wgs84.log", JSON.stringify(enriched[0]) + "\n");
}

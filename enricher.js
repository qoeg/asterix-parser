"use strict";

/**
 * Enrich parsed ASTERIX records with absolute WGS-84 geodesy, timestamp, and correlation.
 * Works best with CAT 048 (radar) and CAT 021 (ADS-B).
 *
 * Inputs:
 *  - records: output from your parseAsterixStream()
 *  - cfg: {
 *      sensorLatDeg, sensorLonDeg, sensorAltM,
 *      azimuthZeroRef: "north" | "east",   // default "north"
 *      clockwise: true | false,            // default true (radar azimuth increases clockwise)
 *      azimuthOffsetDeg: number,           // default 0; adds boresight offset
 *      utcDate: "2025-08-12",              // YYYY-MM-DD for CAT048 I048/140 (seconds since midnight)
 *      altitudePreference: ["I048/110","I048/090"], // priority order
 *      trackMemoryTtlMs: 60000             // how long to keep correlation memory
 *    }
 *
 * Output: array of enriched records
 */

// --------------------- WGS-84 helpers ---------------------
const WGS84 = {
  a: 6378137.0,
  f: 1/298.257223563,
  b: function(){ return this.a * (1 - this.f); },
  e2: function(){ return 2*this.f - this.f*this.f; },
};

function deg2rad(d) { return d * Math.PI/180; }
function rad2deg(r) { return r * 180/Math.PI; }

/** geodetic -> ECEF */
function geodeticToEcef(latDeg, lonDeg, hM) {
  const { a, e2 } = WGS84;
  const lat = deg2rad(latDeg);
  const lon = deg2rad(lonDeg);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const N = a / Math.sqrt(1 - e2()*sinLat*sinLat);
  const x = (N + hM) * cosLat * cosLon;
  const y = (N + hM) * cosLat * sinLon;
  const z = (N*(1 - e2()) + hM) * sinLat;
  return { x, y, z };
}

/** ENU (east,north,up) at ref -> ECEF */
function enuToEcef(e, n, u, refLatDeg, refLonDeg, refAltM) {
  const ref = geodeticToEcef(refLatDeg, refLonDeg, refAltM);
  const lat = deg2rad(refLatDeg), lon = deg2rad(refLonDeg);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  // ENU->ECEF rotation
  const xEast = -sinLon,              yEast =  cosLon,             zEast = 0;
  const xNorth = -sinLat*cosLon,      yNorth = -sinLat*sinLon,     zNorth =  cosLat;
  const xUp =  cosLat*cosLon,         yUp =  cosLat*sinLon,        zUp =  sinLat;
  const x = ref.x + e*xEast + n*xNorth + u*xUp;
  const y = ref.y + e*yEast + n*yNorth + u*yUp;
  const z = ref.z + e*zEast + n*zNorth + u*zUp;
  return { x, y, z };
}

/** ECEF -> geodetic (iterative) */
function ecefToGeodetic(x, y, z) {
  const { a, e2 } = WGS84;
  const b = WGS84.b();
  const ep2 = (a*a - b*b)/(b*b);
  const p = Math.hypot(x, y);
  const th = Math.atan2(a*z, b*p);
  const lon = Math.atan2(y, x);
  const sinTh = Math.sin(th), cosTh = Math.cos(th);
  const lat = Math.atan2(z + ep2*b*sinTh*sinTh*sinTh, p - e2()*a*cosTh*cosTh*cosTh);
  const sinLat = Math.sin(lat);
  const N = a / Math.sqrt(1 - e2()*sinLat*sinLat);
  const h = p/Math.cos(lat) - N;
  return { latDeg: rad2deg(lat), lonDeg: rad2deg(lon), altM: h };
}

/** Build a UTC timestamp from seconds since midnight + a UTC date */
function timeOfDayToIso(utcDate, seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return null;
  const ms = Math.floor(seconds * 1000);
  const d = new Date(`${utcDate}T00:00:00.000Z`);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + ms).toISOString();
}

/** Convert Mode C Flight Level (I048/090 raw/4) -> altitude (feet, meters) assuming std pressure. */
function flightLevelToAltMeters(flightLevel) {
  // FL is in hundreds of feet; standard conversion (approx, ISA):
  const feet = flightLevel * 100;
  return feet * 0.3048;
}

// --------------------- Azimuth / polar handling ---------------------

/**
 * Convert (range, theta) from sensor to local ENU.
 * thetaDeg is the ASTERIX angle; we normalize by:
 * - reference: "north" (0° toward +N) or "east" (0° toward +E)
 * - clockwise: if true, angles increase clockwise (common for radar)
 * - azimuthOffsetDeg: additional rotation to align boresight
 *
 * Returns {e, n} in meters (range in NM is converted to meters).
 */
function polarToEn(rangeNm, thetaDeg, cfg) {
  const mPerNm = 1852;
  let az = thetaDeg + (cfg.azimuthOffsetDeg || 0);

  // Re-map zero reference and direction to math convention
  // Math convention: angle from +X (east), CCW positive.
  if (cfg.azimuthZeroRef === "north" || cfg.azimuthZeroRef === undefined) {
    // 0° = North. Convert to math angle: from east CCW => math = 90° - az
    az = 90 - az;
  } else {
    // 0° = East; math angle initially = az
  }
  if (cfg.clockwise !== false) {
    // If clockwise, invert sign for math CCW
    az = -az;
  }

  const rad = deg2rad(az);
  const rMeters = rangeNm * mPerNm;
  const e = rMeters * Math.cos(rad);
  const n = rMeters * Math.sin(rad);
  return { e, n };
}

// --------------------- Correlation (simple tracker) ---------------------

/**
 * Maintain a short-lived map of "identity" -> lastSeen, to tag repeats.
 * Identity can be:
 *  - CAT048 Track Number (I048/161)
 *  - Mode S address (I048/240)
 *  - Mode 3/A code (I048/070)
 * This is a *lightweight* correlator; proper MHT/JPDA is out of scope here.
 */
class Correlator {
  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { count, lastSeenIso }
  }
  prune(nowIso) {
    const now = new Date(nowIso || Date.now()).getTime();
    for (const [k, v] of this.map.entries()) {
      if (!v.lastSeenMs || now - v.lastSeenMs > this.ttlMs) this.map.delete(k);
    }
  }
  update(keys, timestampIso) {
    const nowMs = timestampIso ? new Date(timestampIso).getTime() : Date.now();
    const hits = [];
    for (const k of keys.filter(Boolean)) {
      const cur = this.map.get(k) || { count: 0, lastSeenMs: 0 };
      cur.count += 1;
      cur.lastSeenMs = nowMs;
      this.map.set(k, cur);
      hits.push({ id: k, seenCount: cur.count });
    }
    this.prune(timestampIso);
    return hits;
  }
}

// --------------------- Main enrichment ---------------------

function enrichAsterix(records, cfg) {
  const {
    sensorLatDeg, sensorLonDeg, sensorAltM,
    azimuthZeroRef = "north",
    clockwise = true,
    azimuthOffsetDeg = 0,
    utcDate,
    altitudePreference = ["I048/110","I048/090"],
    trackMemoryTtlMs = 60000
  } = cfg || {};

  const corr = new Correlator(trackMemoryTtlMs);
  const out = [];

  for (const rec of records) {
    const cat = rec.category;
    const items = rec.items || {};
    let timestampIso = null;

    // Timestamp (CAT048 I048/140 seconds since midnight)
    if (cat === 48 && items["I048/140"] && utcDate) {
      timestampIso = timeOfDayToIso(utcDate, items["I048/140"].seconds);
    }

    // Position
    let pos = null;
    let orient = null; // heading, ground speed, etc.
    let altitudeM = null;

    if (cat === 48) {
      // Altitude pick
      for (const src of altitudePreference) {
        if (src === "I048/110" && items["I048/110"]) {
          // Height measured; many implementations are meters; if raw, leave as-is
          const raw = items["I048/110"].raw; // we stored raw hex earlier; if you decode, set meters
          // If undecoded, skip; else set altitudeM = decodedMeters
        } else if (src === "I048/090" && items["I048/090"]) {
          altitudeM = flightLevelToAltMeters(items["I048/090"].flightLevel);
          break;
        }
      }
      // Use polar or cartesian
      if (items["I048/040"] || items["I048/042"]) {
        let e = 0, n = 0;
        if (items["I048/040"]) {
          const { range_nm, bearing_deg } = items["I048/040"];
          const en = polarToEn(range_nm, bearing_deg, { azimuthZeroRef, clockwise, azimuthOffsetDeg });
          e = en.e; n = en.n;
        } else if (items["I048/042"]) {
          // Cartesian X,Y in NM with LSB 1/256 NM (per your decoder)
          const { x_nm, y_nm } = items["I048/042"];
          // Our X=??, Y=?? assumptions: we interpret X=east, Y=north (adjust if your spec differs)
          e = x_nm * 1852;
          n = y_nm * 1852;
        }
        const u = altitudeM != null ? altitudeM - (sensorAltM || 0) : 0; // Up relative to sensor
        const ecef = enuToEcef(e, n, u, sensorLatDeg, sensorLonDeg, sensorAltM || 0);
        const geo = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
        pos = {
          lat: geo.latDeg,
          lon: geo.lonDeg,
          alt_m: geo.altM
        };
      }

      // Orientation / kinematics (if available)
      if (items["I048/220"]) {
        const { kts, heading_deg, mps } = items["I048/220"];
        orient = { ground_speed_mps: mps, ground_speed_kts: kts, course_deg: heading_deg };
      } else if (items["I048/200"]) {
        const { vx_mps, vy_mps } = items["I048/200"];
        const gs = Math.hypot(vx_mps, vy_mps);
        const course = (rad2deg(Math.atan2(vx_mps, vy_mps)) + 360) % 360; // from north, approx
        orient = { ground_speed_mps: gs, course_deg: course };
      }
    }

    if (cat === 21) {
      // Example: ADS-B already has WGS-84 items (not implemented in your parser yet).
      // If present, just pass through lat/lon/alt, normalize timestamp, and compute orientation from groundspeed/track angle.
    }

    // Correlation keys: prefer unique IDs
    const corrKeys = [];
    if (items["I048/161"]) corrKeys.push(`cat48:trk:${items["I048/161"]}`);
    if (items["I048/240"]) corrKeys.push(`icao24:${items["I048/240"].icao24}`);
    if (items["I048/070"]) corrKeys.push(`mode3a:${items["I048/070"].code_octal}`);

    // Fall back to coarse spatial-temporal clustering ONLY if you really must (not done here).
    const correl = corr.update(corrKeys, timestampIso);

    out.push({
      category: cat,
      timestamp: timestampIso,
      position: pos,          // {lat, lon, alt_m} or null
      orientation: orient,    // {ground_speed_mps, course_deg, ...} or null
      source: {
        sensor: { lat_deg: sensorLatDeg, lon_deg: sensorLonDeg, alt_m: sensorAltM },
        azimuth_ref: azimuthZeroRef, clockwise, azimuth_offset_deg: azimuthOffsetDeg,
      },
      correlation: {
        keys: corrKeys,
        hits: correl,         // [{id, seenCount}, ...]
      },
      raw: rec,               // keep original parsed record for audit
    });
  }

  return out;
}

module.exports = { enrichAsterix };

const fs = require("node:fs");
const { parseAsterixStream } = require("../parser");

const buf = fs.readFileSync("data/asterix.data");
const records = parseAsterixStream(buf);

// Create or clear the log file
fs.writeFileSync("data/asterix.log", "");

// Write each record to the log file
for (let record of records) {
    fs.appendFileSync("data/asterix.log", JSON.stringify(record) + "\n");
}

console.log(`Processed ${records.length} records. Output written to data/asterix.log`);

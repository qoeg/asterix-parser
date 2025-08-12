# ASTERIX Parser

Minimal-yet-extensible ASTERIX parser
 - Supports multi-record byte streams
 - Parses common CAT048 items (subset) and leaves unknowns as raw hex
 - Easy to add more categories: add to CATEGORY_DEFS and DECODERS
 
Notes:
 - Uses network byte order (big endian)
 - FSPEC continuation bit = 1 -> more FSPEC bytes follow
 - Each category’s UAP (User Application Profile) defines which data item corresponds to each FSPEC bit, in order (bit 7..1 per octet).

 ## Usage

 Here is an example using the `parseAsterixStream()` function:

 ```js
const fs = require("node:fs");
const { parseAsterixStream } = require("./asterix-parser");

const buf = fs.readFileSync("input.asterix");
const records = parseAsterixStream(buf);

console.log(JSON.stringify(records, null, 2));
 ```

## Contributing

The project requires NodeJS and npm to be installed.

Run the following to get started:

```cmd
npm i
```

You can run the test suite with:

```cmd
npm test
```

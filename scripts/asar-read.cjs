// Read one file out of an asar archive. Usage: node asar-read.cjs <asar> <path-in-asar>
const fs = require("fs");
const asarPath = process.argv[2];
const target = process.argv[3];
const buf = fs.readFileSync(asarPath);
const strLen = buf.readUInt32LE(12); // header string length
const headerBlock = buf.readUInt32LE(4); // header block size (offset 16 .. 16+headerBlock)
const json = buf.slice(16, 16 + strLen).toString("utf8");
const header = JSON.parse(json);
const dataOffset = 16 + headerBlock;
function find(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (child.files) {
      const r = find(child, p);
      if (r) return r;
    } else if (child.size != null && p === target) {
      const off = dataOffset + Number(child.offset);
      return buf.slice(off, off + child.size);
    }
  }
  return null;
}
const out = find(header, "");
if (!out) {
  console.error("not found: " + target);
  process.exit(2);
}
process.stdout.write(out.toString("utf8"));

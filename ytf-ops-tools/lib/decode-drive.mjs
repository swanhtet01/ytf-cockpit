#!/usr/bin/env node
// decode-drive.mjs — turn a saved `download_file_content` result (JSON {content: base64,...})
// into the real file on disk, so the xlsx generators can parse live Drive data.
// Usage: node lib/decode-drive.mjs <savedJsonPath> <outPath>
import fs from 'node:fs';
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('usage: decode-drive.mjs <savedJson> <out>'); process.exit(1); }
const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const buf = Buffer.from(j.content || '', 'base64');
fs.mkdirSync(outPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
fs.writeFileSync(outPath, buf);
console.log(`decoded "${j.title}" (${j.mimeType}) -> ${outPath}  ${buf.length} bytes  sig=${buf.slice(0, 4).toString('hex')}`);

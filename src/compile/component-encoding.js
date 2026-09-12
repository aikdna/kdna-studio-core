'use strict';
const {canonicalStringify}=require('../evidence/component-json');
function encodeComponentRuntime(plan){const {Encoder}=require('cbor-x');const encoder=new Encoder({useRecords:false,structuredClone:false,mapsAsObjects:true});return storedZip([['mimetype',Buffer.from('application/vnd.kdna.asset')],['kdna.json',Buffer.from(canonicalStringify(plan.manifest),'utf8')],['payload.kdnab',Buffer.from(encoder.encode(JSON.parse(canonicalStringify(plan.payload))))]]);}
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Compiler entry exceeds the Core limit.');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}


module.exports={encodeComponentRuntime};

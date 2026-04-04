const bcrypt = require('bcryptjs');

const WORDS = [
  'signal','hollow','margin','cipher','wren','solstice','phalanx','obsidian',
  'kelvin','fallow','cartwright','veridian','meridian','cascade','ember','archive',
  'syntax','vector','pulsar','axiom','delta','lambda','forge','basalt','cobalt',
  'sable','flint','quorum','stratum','vessel','lantern','mortar','beacon','lattice',
  'tether','glyph','mosaic','prism','reflex','static','torque','vertex','zenith',
  'alcove','brine','canopy','dredge','effigy','fjord','grotto','haven','ibis',
  'joist','knoll','loam','manor','nexus','obelisk','parcel','quartz','rafter',
  'schism','tallow','umbra','vantage','warden','xenon','yarrow','zephyr','amber',
  'blight','cinder','datum','estuary','flume','grain','hinge','inlet','jarvis',
  'kestrel','ledger','mast','notch','orbit','pillar','quarry','ridge','shard',
  'tundra','uplift','valley','willow','xylem','yield','zeroth','ashen','barrow',
  'cleft','dusk','ether','frond','graft','hallow','isle','joule','kinetic'
];

function generatePassphrase() {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  const num  = String(Math.floor(Math.random() * 90) + 10);
  return `${pick()}-${pick()}-${num}`;
}

async function hashPassphrase(passphrase) {
  return bcrypt.hash(passphrase, 12);
}

async function verifyPassphrase(passphrase, hash) {
  return bcrypt.compare(passphrase, hash);
}

module.exports = { generatePassphrase, hashPassphrase, verifyPassphrase };

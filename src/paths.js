/**
 * paths.js — where files live.
 *
 * Both of these can be pointed somewhere else with an environment variable,
 * which is what you do when you host the shop: the database and the product
 * photos have to sit on a disk that survives a restart, not inside the code
 * folder, which most hosts wipe on every deploy.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const DATA_DIR = process.env.SHOP_DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'public', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

module.exports = { ROOT, DATA_DIR, UPLOAD_DIR };

/**
 * countries.js — where the shop ships: Europe, the United States, the United
 * Arab Emirates and Israel. Used by the order form and by Stripe's address
 * step. Israel is "domestic" (the pieces are posted from there).
 */
const SHIP_TO = [
  { code: 'IL', name: 'Israel', region: 'domestic' },
  { code: 'US', name: 'United States', region: 'usa' },
  { code: 'AE', name: 'United Arab Emirates', region: 'emirates' },
  // Europe
  { code: 'AT', name: 'Austria', region: 'europe' },
  { code: 'BE', name: 'Belgium', region: 'europe' },
  { code: 'BG', name: 'Bulgaria', region: 'europe' },
  { code: 'HR', name: 'Croatia', region: 'europe' },
  { code: 'CY', name: 'Cyprus', region: 'europe' },
  { code: 'CZ', name: 'Czechia', region: 'europe' },
  { code: 'DK', name: 'Denmark', region: 'europe' },
  { code: 'EE', name: 'Estonia', region: 'europe' },
  { code: 'FI', name: 'Finland', region: 'europe' },
  { code: 'FR', name: 'France', region: 'europe' },
  { code: 'DE', name: 'Germany', region: 'europe' },
  { code: 'GR', name: 'Greece', region: 'europe' },
  { code: 'HU', name: 'Hungary', region: 'europe' },
  { code: 'IS', name: 'Iceland', region: 'europe' },
  { code: 'IE', name: 'Ireland', region: 'europe' },
  { code: 'IT', name: 'Italy', region: 'europe' },
  { code: 'LV', name: 'Latvia', region: 'europe' },
  { code: 'LI', name: 'Liechtenstein', region: 'europe' },
  { code: 'LT', name: 'Lithuania', region: 'europe' },
  { code: 'LU', name: 'Luxembourg', region: 'europe' },
  { code: 'MT', name: 'Malta', region: 'europe' },
  { code: 'MC', name: 'Monaco', region: 'europe' },
  { code: 'NL', name: 'Netherlands', region: 'europe' },
  { code: 'NO', name: 'Norway', region: 'europe' },
  { code: 'PL', name: 'Poland', region: 'europe' },
  { code: 'PT', name: 'Portugal', region: 'europe' },
  { code: 'RO', name: 'Romania', region: 'europe' },
  { code: 'SK', name: 'Slovakia', region: 'europe' },
  { code: 'SI', name: 'Slovenia', region: 'europe' },
  { code: 'ES', name: 'Spain', region: 'europe' },
  { code: 'SE', name: 'Sweden', region: 'europe' },
  { code: 'CH', name: 'Switzerland', region: 'europe' },
  { code: 'GB', name: 'United Kingdom', region: 'europe' },
];

const BY_CODE = Object.fromEntries(SHIP_TO.map((c) => [c.code, c]));

function countryName(code) {
  return (BY_CODE[String(code || '').toUpperCase()] || {}).name || String(code || '');
}

function isDomestic(code, homeCountry = 'IL') {
  return String(code || '').toUpperCase() === String(homeCountry).toUpperCase();
}

module.exports = { SHIP_TO, BY_CODE, countryName, isDomestic };

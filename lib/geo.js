const fetch = require('node-fetch');

async function geoLookup(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168')) {
    return { city: 'localhost', country: 'DEV', isp: 'local', region: 'dev' };
  }
  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,city,country,countryCode,region,regionName,isp,org,timezone`,
      { timeout: 3000 }
    );
    const data = await res.json();
    if (data.status === 'success') {
      return {
        city:    data.city        || '—',
        country: data.country     || '—',
        country_code: data.countryCode || '—',
        region:  data.regionName  || '—',
        isp:     data.isp         || data.org || '—',
        timezone: data.timezone   || '—',
      };
    }
  } catch (_) {}
  return { city: '—', country: '—', country_code: '—', region: '—', isp: '—', timezone: '—' };
}

module.exports = { geoLookup };

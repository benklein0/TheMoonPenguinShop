// src/links.js
// One place for the website URL every post points at.
//
// SITE_URL (env) overrides the default domain. siteUrl(source) builds a
// link to the shop page tagged with UTM params so traffic from each
// platform shows up separately in analytics. DISPLAY is the bare domain
// shown as plain text in captions (Instagram captions aren't clickable).

const SITE_URL = (process.env.SITE_URL || 'https://themoonpenguinshop.com').replace(/\/+$/, '');

const DISPLAY = SITE_URL.replace(/^https?:\/\//, '').replace(/^www\./, '');

function siteUrl(source, page = 'shop.html') {
  const url = new URL(`${SITE_URL}/${page}`);
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', 'autoposter');
  return url.toString();
}

module.exports = { SITE_URL, DISPLAY, siteUrl };

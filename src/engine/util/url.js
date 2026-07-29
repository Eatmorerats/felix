/**
 * url.js — URL joining shared by the drive steps.
 *
 * Lives here rather than in drive.js so flows.js can use it without a require cycle
 * (drive.js → flows.js → drive.js). drive.js re-exports joinUrl for back-compat.
 */

/** Join a base url + optional port + a route path into one URL. Pure. */
function joinUrl(base, port, route) {
  let origin = String(base || 'http://127.0.0.1').replace(/\/+$/, '');
  // Only append the port if the base doesn't already carry one.
  if (port && !/:\d+$/.test(origin)) origin = `${origin}:${port}`;
  const path = String(route || '/');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = { joinUrl };

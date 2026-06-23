#!/usr/bin/env node
/**
 * Generic Playwright fetcher — real Chrome channel (not bundled Chromium).
 *
 * Usage (driven by engine/executor.py):
 *   echo '{"url":"...", "profileDir":"/tmp/.p", "waitSelector":"article"}' | node playwright_real_chrome.js
 *
 * Outputs page HTML to stdout on success; errors to stderr with non-zero exit.
 *
 * NO-SITE-NAME RULE: this file must never branch on specific hostnames.
 * All site specifics come from the JSON input (url, waitSelector).
 *
 * Dependencies (install once on target machine):
 *   npm i -g playwright playwright-extra puppeteer-extra-plugin-stealth
 *   npx playwright install chrome    # system Chrome binary
 */

const dns = require('dns').promises;
const net = require('net');

// Drain stdout fully before exiting. `process.exit()` can truncate a large
// HTML payload because it does not wait for pending stdout I/O (Node docs).
function writeStdoutAsync(payload) {
  return new Promise((resolve, reject) => {
    process.stdout.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

// Structured envelope so the Python side can (a) validate on real status /
// final URL and (b) bridge the browser-cleared cookies + UA into curl_cffi.
async function buildEnvelope(ctx, page, html, resp, automation) {
  let cookies = [];
  try { cookies = (await ctx.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain })); } catch (_e) {}
  let userAgent = '';
  try { userAgent = await page.evaluate(() => navigator.userAgent); } catch (_e) {}
  let finalUrl = '';
  try { finalUrl = page.url(); } catch (_e) {}
  let status = 0;
  try { status = resp ? resp.status() : 0; } catch (_e) {}
  return JSON.stringify({ html, finalUrl, status, cookies, userAgent, automation });
}


class UnsafeUrlError extends Error {
  constructor(reason) {
    super(`unsafe_url:${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

function isBlockedHostname(hostname) {
  const h = (hostname || '').toLowerCase().replace(/\.$/, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa');
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}

function normalizeIPv4MappedIPv6(address) {
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function isPrivateIPv6(address) {
  const lower = address.toLowerCase();
  const mapped = normalizeIPv4MappedIPv6(lower);
  if (mapped !== lower && net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') ||
    lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
    lower.startsWith('ff') || lower.startsWith('2001:db8') || lower.startsWith('::ffff:');
}

function isPrivateOrSpecialAddress(address) {
  const normalized = normalizeIPv4MappedIPv6(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIPv4(normalized);
  if (family === 6) return isPrivateIPv6(normalized);
  if (net.isIP(address) === 6) return isPrivateIPv6(address);
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_e) { throw new UnsafeUrlError('invalid_url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UnsafeUrlError(`scheme:${parsed.protocol || 'none'}`);
  if (parsed.username || parsed.password) throw new UnsafeUrlError('credentials');
  if (isBlockedHostname(parsed.hostname)) throw new UnsafeUrlError('internal_host');
  if (net.isIP(parsed.hostname)) {
    if (isPrivateOrSpecialAddress(parsed.hostname)) throw new UnsafeUrlError(`ip_blocked:${parsed.hostname}`);
    return;
  }
  let records;
  try { records = await dns.lookup(parsed.hostname, { all: true, verbatim: true }); }
  catch (_e) { throw new UnsafeUrlError('resolve_failed'); }
  if (!records.length) throw new UnsafeUrlError('resolve_empty');
  const blocked = records.find((record) => isPrivateOrSpecialAddress(record.address));
  if (blocked) throw new UnsafeUrlError(`resolves_internal:${parsed.hostname}->${blocked.address}`);
}

async function assertPagePublic(page, label) {
  let current = '';
  try { current = page.url(); } catch (_e) {}
  await assertPublicHttpUrl(current);
  return current;
}

async function readStdinJson() {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = await readStdinJson();
  const url = args.url;
  if (!url) { process.stderr.write('missing url\n'); process.exit(2); }
  await assertPublicHttpUrl(url);

  const profileDir = args.profileDir || '/tmp/.insane_pw_profile';
  const waitSelector = args.waitSelector || null;
  const timeoutMs = args.timeout || 60000;
  const headless = args.headless ?? false;     // Akamai/etc detect headless
  const viewport = args.viewport || { width: 1366, height: 900 };

  let chromium;
  let automation = 'playwright';
  try {
    // Patchright is a DROP-IN Playwright fork (same API) that closes the CDP
    // Runtime.enable leak Cloudflare/DataDome now detect. Preferred when
    // installed; it does its own patching, so NO stealth plugin is added.
    // Additive only: if patchright is absent we fall back to exactly the
    // previous playwright-extra(+stealth) → playwright behaviour.
    ({ chromium } = require('patchright'));
    automation = 'patchright';
  } catch (_e0) {
    try {
      ({ chromium } = require('playwright-extra'));
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromium.use(stealth);
      automation = 'playwright-extra+stealth';
    } catch (_e) {
      // Fallback to plain playwright (no stealth). Still uses channel:chrome.
      ({ chromium } = require('playwright'));
      automation = 'playwright';
    }
  }

  let ctx;
  try {
    // Patchright official best practice: channel:'chrome', headless:false,
    // no_viewport (JS: viewport:null), persistent context, and NO custom
    // headers/UA/flags. We only override viewport for patchright; plain
    // playwright keeps the fixed viewport it has always used.
    const ctxOpts = { channel: 'chrome', headless };
    if (automation === 'patchright') {
      ctxOpts.viewport = null;     // == no_viewport=True (use real window size)
    } else {
      ctxOpts.viewport = viewport;
    }
    ctx = await chromium.launchPersistentContext(profileDir, ctxOpts);
    const page = await ctx.newPage();
    // Single shared deadline across warmup + main + reload navigations so the
    // first nav can't eat the whole budget and starve the rest.
    const deadline = Date.now() + timeoutMs;
    const rem = (cap) => Math.max(1000, Math.min(cap || timeoutMs, deadline - Date.now()));

    // Warmup hop: visit the site root first so Akamai-style bot managers
    // can run their JS sensor and set a resolved session cookie. Direct
    // landing on a search/deep URL is the classic first-hit rejection pattern.
    // Use domcontentloaded (not networkidle) — many SPAs keep analytics/xhr
    // open indefinitely and would hit the 90s timeout.
    try {
      const urlObj = new URL(url);
      const rootUrl = `${urlObj.protocol}//${urlObj.host}/`;
      if (rootUrl !== url) {
        await assertPublicHttpUrl(rootUrl);
        await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: rem(90000) });
        await assertPagePublic(page, 'warmup');
        await page.waitForTimeout(3500);   // let sensor JS finish
      }
    } catch (_e) {
      if (_e && _e.name === 'UnsafeUrlError') throw _e;
      // warmup is best-effort; continue even if it hiccups
    }

    // Main page — DOM loaded then give the sensor a moment.
    let mainResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: rem(90000) });
    await assertPagePublic(page, 'main');
    await page.waitForTimeout(2500);

    if (waitSelector) {
      try {
        await page.waitForSelector(waitSelector, { timeout: rem(20000) });
      } catch (_e) {
        // Selector still missing — try one hard reload in case the first hit
        // landed on a challenge page and the sensor has just cleared.
        try {
          mainResp = await page.reload({ waitUntil: 'domcontentloaded', timeout: rem(90000) });
          await assertPagePublic(page, 'reload');
          await page.waitForTimeout(2000);
          try {
            await page.waitForSelector(waitSelector, { timeout: rem(10000) });
          } catch (_e2) {
            // Still no luck — caller validates HTML anyway.
          }
        } catch (_e3) {
          // reload failed — proceed with whatever we have
        }
      }
    } else {
      // Without a positive-proof selector, give the sensor a couple more seconds.
      await page.waitForTimeout(2000);
    }

    await assertPagePublic(page, 'content');
    const html = await page.content();
    const payload = await buildEnvelope(ctx, page, html, mainResp, automation);
    await writeStdoutAsync(payload);  // flush fully before any exit
    process.exitCode = 0;
    return;                           // let finally close ctx, then exit naturally
  } catch (e) {
    process.stderr.write(`${e.name || 'Error'}: ${e.message || e}\n`);
    process.exitCode = 1;
    return;
  } finally {
    try { if (ctx) await ctx.close(); } catch (_e) {}
  }
}

main();

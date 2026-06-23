#!/usr/bin/env node
/**
 * Generic Playwright mobile fetcher — real Chrome + device emulation.
 *
 * Usage:
 *   echo '{"url":"...", "device":"iPhone 13 Pro"}' | node playwright_mobile_chrome.js
 *
 * Device name must match playwright `devices[...]` keys (Pixel 7, iPhone 13 Pro,
 * iPad Pro 11, etc.). When in doubt, omit `device` — default is iPhone 13 Pro.
 *
 * NO-SITE-NAME RULE: same as playwright_real_chrome.js — no hostname branches.
 */

const dns = require('dns').promises;
const net = require('net');

function writeStdoutAsync(payload) {
  return new Promise((resolve, reject) => {
    process.stdout.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

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

  const profileDir = args.profileDir || '/tmp/.insane_pw_mobile_profile';
  const deviceName = args.device || 'iPhone 13 Pro';
  const waitSelector = args.waitSelector || null;
  const timeoutMs = args.timeout || 60000;
  const headless = args.headless ?? false;

  let chromium, devices;
  let automation = 'playwright';
  try {
    // Patchright drop-in (additive; absent → previous behaviour unchanged).
    ({ chromium, devices } = require('patchright'));
    automation = 'patchright';
  } catch (_e0) {
    try {
      ({ chromium, devices } = require('playwright-extra'));
      const stealth = require('puppeteer-extra-plugin-stealth')();
      chromium.use(stealth);
      automation = 'playwright-extra+stealth';
    } catch (_e) {
      ({ chromium, devices } = require('playwright'));
      automation = 'playwright';
    }
  }

  const dev = devices[deviceName];
  if (!dev) {
    process.stderr.write(`unknown device: ${deviceName}\n`);
    process.exit(2);
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless,
      ...dev,
    });
    const page = await ctx.newPage();
    const deadline = Date.now() + timeoutMs;
    const rem = (cap) => Math.max(1000, Math.min(cap || timeoutMs, deadline - Date.now()));
    const mainResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: rem(90000) });
    await assertPagePublic(page, 'main');

    if (waitSelector) {
      try {
        await page.waitForSelector(waitSelector, { timeout: rem(20000) });
      } catch (_e) {}
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

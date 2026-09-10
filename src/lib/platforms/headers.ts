/**
 * Dynamic header rotation for TikTok fetch requests.
 *
 * TikTok actively fingerprints requests via User-Agent, Sec-CH-UA hints,
 * and header ordering. This module rotates modern desktop/mobile profiles
 * and injects plausible sec-ch-* headers so each request looks like a
 * different real browser visit.
 */

/* ------------------------------------------------------------------ */
/*  UA Profiles                                                        */
/* ------------------------------------------------------------------ */

interface UaProfile {
  userAgent: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  secChUaFullVersionList?: string;
  platformHeader: string;   // Sec-CH-UA-Platform value for Accept-CH
}

const UA_PROFILES: UaProfile[] = [
  // Chrome 130 on Windows 11
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    secChUaFullVersionList:
      '"Chromium";v="130.0.6723.92", "Google Chrome";v="130.0.6723.92", "Not?A_Brand";v="99.0.0.0"',
    platformHeader: '"Windows"',
  },
  // Chrome 129 on macOS
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="129", "Google Chrome";v="129", "Not?A_Brand";v="99"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"',
    secChUaFullVersionList:
      '"Chromium";v="129.0.6668.90", "Google Chrome";v="129.0.6668.90", "Not?A_Brand";v="99.0.0.0"',
    platformHeader: '"macOS"',
  },
  // Chrome 130 on Android (mobile)
  {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    secChUaMobile: '?1',
    secChUaPlatform: '"Android"',
    secChUaFullVersionList:
      '"Chromium";v="130.0.6723.86", "Google Chrome";v="130.0.6723.86", "Not?A_Brand";v="99.0.0.0"',
    platformHeader: '"Android"',
  },
  // Safari 18 on iOS 18
  {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    secChUa: '',
    secChUaMobile: '?1',
    secChUaPlatform: '"iOS"',
    platformHeader: '"iOS"',
  },
  // Chrome 128 on Linux
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="128", "Google Chrome";v="128", "Not?A_Brand";v="99"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Linux"',
    secChUaFullVersionList:
      '"Chromium";v="128.0.6613.138", "Google Chrome";v="128.0.6613.138", "Not?A_Brand";v="99.0.0.0"',
    platformHeader: '"Linux"',
  },
];

/* ------------------------------------------------------------------ */
/*  Picker                                                             */
/* ------------------------------------------------------------------ */

let lastIdx = -1;

/** Pick the next UA profile in round-robin (never repeats consecutively). */
export function pickUaProfile(): UaProfile {
  lastIdx = (lastIdx + 1) % UA_PROFILES.length;
  return UA_PROFILES[lastIdx];
}

/** Pick a random UA profile. */
export function randomUaProfile(): UaProfile {
  let idx: number;
  do { idx = Math.floor(Math.random() * UA_PROFILES.length); } while (idx === lastIdx && UA_PROFILES.length > 1);
  lastIdx = idx;
  return UA_PROFILES[idx];
}

/* ------------------------------------------------------------------ */
/*  Header builders                                                    */
/* ------------------------------------------------------------------ */

/** TikTok-specific web headers with rotated UA. */
export function tiktokWebHeaders(opts?: { referer?: string; extra?: Record<string, string> }): Record<string, string> {
  const p = pickUaProfile();
  const headers: Record<string, string> = {
    'User-Agent': p.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': opts?.referer ?? 'https://www.tiktok.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  if (p.secChUa) {
    headers['Sec-CH-UA'] = p.secChUa;
    headers['Sec-CH-UA-Mobile'] = p.secChUaMobile;
    headers['Sec-CH-UA-Platform'] = p.secChUaPlatform;
    if (p.secChUaFullVersionList) {
      headers['Sec-CH-UA-Full-Version-List'] = p.secChUaFullVersionList;
    }
  }

  if (opts?.extra) Object.assign(headers, opts.extra);
  return headers;
}

/** JSON API headers with rotated UA (for TikTok internal APIs). */
export function tiktokApiHeaders(opts?: { referer?: string }): Record<string, string> {
  const p = pickUaProfile();
  const headers: Record<string, string> = {
    'User-Agent': p.userAgent,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': opts?.referer ?? 'https://www.tiktok.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  if (p.secChUa) {
    headers['Sec-CH-UA'] = p.secChUa;
    headers['Sec-CH-UA-Mobile'] = p.secChUaMobile;
    headers['Sec-CH-UA-Platform'] = p.secChUaPlatform;
  }

  return headers;
}

/** Lightweight JSON headers for third-party APIs (TikWM etc). */
export function thirdPartyApiHeaders(referer: string): Record<string, string> {
  const p = pickUaProfile();
  return {
    'User-Agent': p.userAgent,
    'Accept': 'application/json',
    'Referer': referer,
  };
}

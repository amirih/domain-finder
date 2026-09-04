import { NextResponse } from 'next/server';
import type { CheckResult } from '@/types/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const MAX_BATCH = 25;
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 5;

type Bootstrap = {
  services: [string[], string[]][];
};

let bootstrapCache: { value: Bootstrap; expiresAt: number } | null = null;

function validDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  const labels = domain.toLowerCase().split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

async function getBootstrap(): Promise<Bootstrap> {
  if (bootstrapCache && bootstrapCache.expiresAt > Date.now()) return bootstrapCache.value;

  const response = await fetch(IANA_BOOTSTRAP, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 86_400 }
  });

  if (!response.ok) throw new Error(`IANA bootstrap returned HTTP ${response.status}`);
  const value = (await response.json()) as Bootstrap;
  bootstrapCache = { value, expiresAt: Date.now() + 86_400_000 };
  return value;
}

function rdapBaseForTld(bootstrap: Bootstrap, tld: string): string | undefined {
  const normalized = tld.toLowerCase().replace(/^\./, '');
  for (const [tlds, urls] of bootstrap.services) {
    if (tlds.some((item) => item.toLowerCase() === normalized)) return urls[0];
  }
  return undefined;
}

async function checkOne(domain: string, bootstrap: Bootstrap): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();
  const lookupUrl = `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(domain)}`;
  const tld = domain.split('.').pop() ?? '';
  const base = rdapBaseForTld(bootstrap, tld);

  if (!base) {
    return { domain, status: 'unknown', checkedAt, lookupUrl, detail: `No RDAP service found in IANA bootstrap for .${tld}.` };
  }

  const rdapUrl = `${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`;

  try {
    const response = await fetch(rdapUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/rdap+json, application/json;q=0.9' }
    });

    if (response.status === 200) {
      return { domain, status: 'registered', checkedAt, lookupUrl, rdapUrl, detail: 'Found in authoritative RDAP registration data.' };
    }
    if (response.status === 404) {
      return { domain, status: 'available', checkedAt, lookupUrl, rdapUrl, detail: 'Not found in the authoritative RDAP service.' };
    }
    if (response.status === 429) {
      return { domain, status: 'unknown', checkedAt, lookupUrl, rdapUrl, detail: 'Registry rate limit reached. Try checking again later.' };
    }

    return { domain, status: 'unknown', checkedAt, lookupUrl, rdapUrl, detail: `RDAP returned HTTP ${response.status}.` };
  } catch (error) {
    return {
      domain,
      status: 'unknown',
      checkedAt,
      lookupUrl,
      rdapUrl,
      detail: error instanceof Error ? error.message : 'RDAP request failed.'
    };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { domains?: unknown };
    if (!Array.isArray(body.domains)) {
      return NextResponse.json({ error: 'domains must be an array.' }, { status: 400 });
    }

    const domains = [...new Set(body.domains.filter((item): item is string => typeof item === 'string').map((d) => d.trim().toLowerCase()))];
    if (domains.length === 0) return NextResponse.json({ results: [] });
    if (domains.length > MAX_BATCH) {
      return NextResponse.json({ error: `Maximum ${MAX_BATCH} domains per request.` }, { status: 400 });
    }

    const invalid = domains.find((domain) => !validDomain(domain));
    if (invalid) return NextResponse.json({ error: `Invalid domain: ${invalid}` }, { status: 400 });

    const bootstrap = await getBootstrap();
    const results = await mapWithConcurrency(domains, CONCURRENCY, (domain) => checkOne(domain, bootstrap));
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to check domains.' },
      { status: 500 }
    );
  }
}

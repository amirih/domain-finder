# Domain Combination Finder

Next.js + TypeScript + PrimeReact app that generates every unique lowercase `a-z` combination of an exact length containing a required seed substring, then checks each resulting domain using the authoritative RDAP service for the selected TLD.

## Features

- Input `cat` or `cat.io`; extension auto-detects when included.
- `.com` is the visible default TLD. The extension field accepts multiple TLDs such as `.com, .org, .net` and deduplicates them.
- Exact second-level domain length, excluding the extension.
- Generates all lowercase letter combinations containing the seed, not dictionary words.
- Removes duplicates when the seed can occur in more than one placement.
- Every generated name is expanded across every selected extension, then checked progressively server-side using the IANA RDAP bootstrap registry.
- Statuses: Available, Registered, Unknown, Checking, Pending.
- Registered rows link to ICANN Lookup and the registry's direct RDAP response.
- PrimeReact DataTable with sorting, search, status filters, pagination, checkbox selection, Select view, and Select available.
- CSV export for the current filtered/sorted view or all generated rows.
- Stop button for large domain-check runs.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

For a production check:

```bash
npm run typecheck
npm run build
npm start
```

## Combination semantics

For seed `cat` and length `4`, the app considers every four-letter lowercase string where `cat` appears contiguously, such as `acat`, `bcat`, `cata`, `catb`, etc. The generator uses only `a-z` and deduplicates strings that can be produced from multiple seed placements.

The number of combinations grows exponentially. The UI has a safety limit of 100,000 unique generated candidates and 100,000 total domain checks after multiplying candidates by extensions. Change `MAX_CANDIDATES` and `MAX_DOMAIN_CHECKS` in `lib/combinations.ts` if you operate your own lookup infrastructure and want different limits.

## Registration-data behavior

`app/api/check/route.ts` downloads IANA's RDAP DNS bootstrap data, discovers the authoritative RDAP base URL for the requested TLD, and checks each domain server-side in bounded batches.

- HTTP 200: `registered`
- HTTP 404: `available` (no registration record in RDAP)
- HTTP 429, unsupported TLD, timeout, or other unexpected response: `unknown`

"Available" is intentionally not a promise that a registrar will sell the domain. Reserved, blocked, registry-premium, or policy-restricted names can still be unavailable for purchase.

## Main files

- `app/page.tsx`: generator UI, checking queue, filtering, sorting, selection, and CSV export.
- `app/api/check/route.ts`: server-side IANA bootstrap + RDAP lookup endpoint.
- `lib/combinations.ts`: normalization, estimate, and exhaustive combination generation.
- `types/domain.ts`: shared result types.


## Next.js 16 note

This project uses PrimeReact's `saga-blue` theme instead of the Lara theme. PrimeReact 10.9.9's Lara CSS can reference a missing `InterVariable.woff2` file under Turbopack, which causes a build-time module resolution error. `saga-blue` avoids that dependency.

## Wildcard patterns

The name input accepts `*` as a zero-or-more-character wildcard. The exact name length still controls the final domain label length.

Examples:

- `domain`, length 6: generated characters may appear before or after `domain`.
- `do*main`, length 6: generated characters may appear before `do`, between `do` and `main`, and after `main`.
- `do*ma*in.com`: remaining characters are distributed across the beginning, every `*` gap, and the end.
- `*`, length 3: generates every 3-character combination, subject to the safety limit.

By default generated characters are `a-z`. Enable **Include numbers 0-9** to use `a-z0-9` for generated positions. Fixed pattern characters remain letters.

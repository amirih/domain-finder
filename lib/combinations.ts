const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const LETTERS_AND_NUMBERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const MAX_CANDIDATES = 100_000;
export const MAX_DOMAIN_CHECKS = 100_000;

export function normalizePattern(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z*]/g, '')
    .replace(/\*+/g, '*');

  if (!cleaned) return '';
  if (/^\*+$/.test(cleaned)) return '*';
  return cleaned.replace(/^\*+|\*+$/g, '');
}

// Kept for compatibility with older callers/readme examples.
export function normalizeSeed(value: string): string {
  return normalizePattern(value);
}

export function patternLiteralLength(value: string): number {
  return normalizePattern(value).replace(/\*/g, '').length;
}

function normalizeSingleExtension(value: string): string | null {
  const labels = value
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .split('.')
    .map((label) => label.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, ''))
    .filter(Boolean);

  return labels.length ? `.${labels.join('.')}` : null;
}

export function normalizeExtension(value: string): string {
  return normalizeSingleExtension(value) ?? '.com';
}

export function normalizeExtensions(value: string | string[]): string[] {
  const source = Array.isArray(value) ? value : [value];
  const tokens = source.flatMap((item) => item.split(/[\s,;]+/g));
  const normalized = tokens
    .map(normalizeSingleExtension)
    .filter((extension): extension is string => Boolean(extension));

  return normalized.length ? [...new Set(normalized)] : ['.com'];
}

export function parseSeedAndExtension(value: string): { seed: string; extension?: string } {
  const raw = value.trim().toLowerCase();
  const withoutProtocol = raw.replace(/^https?:\/\//, '').split('/')[0];
  const dot = withoutProtocol.indexOf('.');

  if (dot > 0 && dot < withoutProtocol.length - 1) {
    return {
      seed: normalizePattern(withoutProtocol.slice(0, dot)),
      extension: normalizeExtension(withoutProtocol.slice(dot + 1))
    };
  }

  return { seed: normalizePattern(withoutProtocol) };
}

function combinationCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const effectiveK = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= effectiveK; i++) {
    result = (result * (n - effectiveK + i)) / i;
    if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) return Number.POSITIVE_INFINITY;
  }
  return result;
}

export function estimateCandidateUpperBound(pattern: string, totalLength: number, includeNumbers = false): number {
  const normalized = normalizePattern(pattern);
  if (!normalized || !Number.isInteger(totalLength) || totalLength < 0) return 0;

  const alphabetSize = includeNumbers ? LETTERS_AND_NUMBERS.length : LETTERS.length;

  if (normalized === '*') {
    return Math.pow(alphabetSize, totalLength);
  }

  const segments = normalized.split('*').filter(Boolean);
  const fixedLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalLength < fixedLength) return 0;

  const free = totalLength - fixedLength;
  const variableSlots = segments.length + 1; // implicit prefix + internal * gaps + implicit suffix
  const distributions = combinationCount(free + variableSlots - 1, variableSlots - 1);
  return distributions * Math.pow(alphabetSize, free);
}

function enumerateSequences(
  alphabet: string,
  length: number,
  emit: (sequence: string) => void
) {
  if (length === 0) {
    emit('');
    return;
  }

  const chars = Array<string>(length);
  const visit = (index: number) => {
    if (index === length) {
      emit(chars.join(''));
      return;
    }

    for (const char of alphabet) {
      chars[index] = char;
      visit(index + 1);
    }
  };

  visit(0);
}

function enumerateCompositions(total: number, parts: number, emit: (lengths: number[]) => void) {
  const lengths = Array<number>(parts).fill(0);

  const visit = (index: number, remaining: number) => {
    if (index === parts - 1) {
      lengths[index] = remaining;
      emit([...lengths]);
      return;
    }

    for (let amount = 0; amount <= remaining; amount++) {
      lengths[index] = amount;
      visit(index + 1, remaining - amount);
    }
  };

  visit(0, total);
}

function buildFromDistribution(segments: string[], lengths: number[], sequence: string): string {
  let cursor = 0;
  let value = sequence.slice(cursor, cursor + lengths[0]);
  cursor += lengths[0];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    value += segments[segmentIndex];
    if (segmentIndex < segments.length - 1) {
      const slotLength = lengths[segmentIndex + 1];
      value += sequence.slice(cursor, cursor + slotLength);
      cursor += slotLength;
    }
  }

  const suffixLength = lengths[lengths.length - 1];
  value += sequence.slice(cursor, cursor + suffixLength);
  return value;
}

export function generateCandidates(pattern: string, totalLength: number, includeNumbers = false): string[] {
  const normalized = normalizePattern(pattern);
  if (!normalized) throw new Error('Enter at least one letter or * wildcard.');
  if (!Number.isInteger(totalLength) || totalLength < 1) throw new Error('Length must be at least 1.');
  if (totalLength > 63) throw new Error('Domain labels cannot exceed 63 characters.');

  const alphabet = includeNumbers ? LETTERS_AND_NUMBERS : LETTERS;

  if (normalized === '*') {
    const upperBound = Math.pow(alphabet.length, totalLength);
    if (upperBound > MAX_CANDIDATES) {
      throw new Error(
        `This wildcard request creates ${upperBound.toLocaleString()} candidates. The app safety limit is ${MAX_CANDIDATES.toLocaleString()}. Reduce the length.`
      );
    }

    const output: string[] = [];
    enumerateSequences(alphabet, totalLength, (sequence) => output.push(sequence));
    return output;
  }

  const segments = normalized.split('*').filter(Boolean);
  const fixedLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalLength < fixedLength) {
    throw new Error(`Length must be at least ${fixedLength}, the number of fixed letters in the pattern.`);
  }

  const upperBound = estimateCandidateUpperBound(normalized, totalLength, includeNumbers);
  if (upperBound > MAX_CANDIDATES) {
    throw new Error(
      `This request can create up to ${upperBound.toLocaleString()} candidates. The app safety limit is ${MAX_CANDIDATES.toLocaleString()}. Reduce the length or disable numbers.`
    );
  }

  const free = totalLength - fixedLength;
  const variableSlots = segments.length + 1;
  const output = new Set<string>();

  enumerateCompositions(free, variableSlots, (lengths) => {
    enumerateSequences(alphabet, free, (sequence) => {
      output.add(buildFromDistribution(segments, lengths, sequence));
      if (output.size > MAX_CANDIDATES) {
        throw new Error(
          `More than ${MAX_CANDIDATES.toLocaleString()} unique candidates were generated. Reduce the length or disable numbers.`
        );
      }
    });
  });

  return Array.from(output).sort();
}

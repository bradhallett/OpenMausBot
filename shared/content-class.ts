// Content classes for the redaction boundary (#1670). The credential pass
// in redact.ts is unconditional and remains the primary control; these span
// classifiers cover what a credential pattern can never see — personal data
// and internal infrastructure — so a bot configured for them cannot paste
// them onward. Same philosophy as redact.ts: high precision only, because
// over-redaction breaks real tasks. Anything ambiguous stays unclassified.
// shared/ files cannot value-import each other: the app tsc build rejects .ts
// value imports and Node, which runs these files directly, cannot resolve a
// .js specifier to a .ts file. So this mirrors the two-line mask from
// redact.ts; the parity test in content-class.test.ts fails if the two ever
// drift, keeping repeated redaction byte-for-byte stable across scrubs.
const REDACTION_MARKER = /^«redacted \d+ chars»$/;
const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

/** Classes a bot can be configured to redact beyond credentials.
 * "credentials" is never loosenable and "public" needs no enforcement, so
 * neither appears here. */
export type ContentClass = "personal" | "internal";

// ── personal data ─────────────────────────────────────────────────────
// An email address is unmistakable. Phone numbers match only shapes that
// cannot be a date, an id, or a version: NANP 3-3-4 with real separators,
// or a leading + country code. SSNs are 3-2-4, a grouping no date or
// version uses. Cards are a 13-19 digit run that passes Luhn — the
// checksum makes false positives negligible.
const EMAIL = /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
const PHONE_NANP = /(?:\+1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;
const PHONE_INTL = /\+\d{1,3}(?:[\s.-]?\d){7,13}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE = /\b\d[\d -]{11,25}\d\b/g;

// ── internal infrastructure ───────────────────────────────────────────
// RFC1918/loopback/link-local IPv4 (validated octet-by-octet), IPv6
// unique-local (fc00::/7), link-local (fe80::/10) and ::1, and hostnames
// under private-only suffixes. A public IP or domain never matches.
const IPV4_CANDIDATE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_UNIQUE_LOCAL = /\bf[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){1,7}/gi;
const IPV6_LINK_LOCAL = /\bfe[89ab][0-9a-f](?::[0-9a-f]{0,4}){1,7}/gi;
const IPV6_LOOPBACK = /(?<![0-9a-f:])::1(?![0-9a-f:])/gi;
const INTERNAL_HOST = /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.(?:internal|local|lan|corp|home)\b/g;

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function luhnPasses(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function isCardNumber(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhnPasses(digits);
}

/** Module regexes carry /g state; every use goes through these resets. */
function matchesAny(text: string, patterns: RegExp[], accept: (match: string) => boolean = () => true): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    let found = false;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (accept(match[0])) {
        found = true;
        break;
      }
    }
    pattern.lastIndex = 0;
    return found;
  });
}

function maskPersonal(text: string): string {
  let out = text.replace(EMAIL, (m) => mask(m));
  out = out.replace(PHONE_NANP, (m) => mask(m));
  out = out.replace(PHONE_INTL, (m) => mask(m));
  out = out.replace(SSN, (m) => mask(m));
  return out.replace(CARD_CANDIDATE, (m) => (isCardNumber(m) ? mask(m) : m));
}

function maskInternal(text: string): string {
  let out = text.replace(IPV4_CANDIDATE, (m) => (isPrivateIpv4(m) ? mask(m) : m));
  out = out.replace(IPV6_UNIQUE_LOCAL, (m) => mask(m));
  out = out.replace(IPV6_LINK_LOCAL, (m) => mask(m));
  out = out.replace(IPV6_LOOPBACK, (m) => mask(m));
  return out.replace(INTERNAL_HOST, (m) => mask(m));
}

const hasPersonal = (text: string) =>
  matchesAny(text, [EMAIL, PHONE_NANP, PHONE_INTL, SSN]) || matchesAny(text, [CARD_CANDIDATE], isCardNumber);
const hasInternal = (text: string) =>
  matchesAny(text, [IPV4_CANDIDATE], isPrivateIpv4) || matchesAny(text, [IPV6_UNIQUE_LOCAL, IPV6_LINK_LOCAL, IPV6_LOOPBACK, INTERNAL_HOST]);

export interface ContentClassRedaction {
  text: string;
  /** Classes detected in the payload but not in the enforced list: they
   * crossed the boundary unredacted by explicit configuration, which the
   * caller must audit (#1670's escape hatch). Empty when nothing detected
   * or when every detected class was enforced. */
  passed: ContentClass[];
}

/** Mask the enforced classes and report classes that were detected but
   * allowed through. Detection for the report runs on the incoming text,
   * so loosened classes are always audited even though their spans are
   * left intact. */
export function redactContentClasses(text: string, enforced: readonly ContentClass[]): ContentClassRedaction {
  if (!text) return { text, passed: [] };
  const passed: ContentClass[] = [];
  let out = text;
  if (enforced.includes("personal")) out = maskPersonal(out);
  else if (hasPersonal(text)) passed.push("personal");
  if (enforced.includes("internal")) out = maskInternal(out);
  else if (hasInternal(text)) passed.push("internal");
  return { text: out, passed };
}

// All money is integer paise. Never use floats for amounts.

// 123450 -> "₹1,234.50", -123450 -> "-₹1,234.50" (Indian digit grouping).
export function formatINR(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}₹${rupees.toLocaleString('en-IN')}.${String(rest).padStart(2, '0')}`;
}

// 123450 -> "1234.50", 100 -> "1". Plain text for prefilling inputs (parseRupeesToPaise accepts it back).
export function paiseToRupees(paise: number): string {
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${paise < 0 ? '-' : ''}${rupees}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

// "1234" | "1234.5" | "1234.56" -> paise. Null for anything else, more than 2 decimals, or <= 0.
// Parsed by splitting the string so there is no floating-point rounding.
export function parseRupeesToPaise(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise <= 0) return null;
  return paise;
}

// For per-member inputs where blank means 0. Returns null only for invalid text.
export function parseOptionalRupees(input: string): number | null {
  if (input.trim() === '') return 0;
  if (/^0+(\.0{1,2})?$/.test(input.trim())) return 0;
  return parseRupeesToPaise(input);
}

// Today's date in the browser's local time zone as YYYY-MM-DD (toISOString would give the UTC date).
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

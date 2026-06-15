import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhoneNumber(rawNumber, defaultCountry = 'US') {
  const trimmed = String(rawNumber || '').trim();

  if (!trimmed) {
    return {
      rawNumber: trimmed,
      normalizedNumber: '',
      countryCode: null,
      isValid: false,
    };
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);

  if (parsed?.isValid()) {
    return {
      rawNumber: trimmed,
      normalizedNumber: parsed.number,
      countryCode: parsed.country,
      isValid: true,
    };
  }

  const digits = trimmed.replace(/\D/g, '');
  let normalizedNumber = trimmed.startsWith('+') ? `+${digits}` : digits;

  if (!trimmed.startsWith('+') && defaultCountry === 'US') {
    if (digits.length === 10) normalizedNumber = `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) normalizedNumber = `+${digits}`;
  }

  return {
    rawNumber: trimmed,
    normalizedNumber,
    countryCode: null,
    isValid: false,
  };
}

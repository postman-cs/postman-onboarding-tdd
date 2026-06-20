export type SecretMasker = (value: string) => string;

export function createSecretMasker(secrets: Array<string | undefined>): SecretMasker {
  const values = secrets
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length > 0)
    .sort((a, b) => b.length - a.length);

  return (value: string): string => {
    let masked = String(value || '');
    for (const secret of values) {
      masked = masked.split(secret).join('***');
    }
    return masked;
  };
}

export function sanitizeLogExcerpt(value: string, mask: SecretMasker, maxLength = 4000): string {
  const normalized = mask(String(value || ''))
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(normalized.length - maxLength)}\n...truncated to last ${maxLength} characters`;
}

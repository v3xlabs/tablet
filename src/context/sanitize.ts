const SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.staging",
  ".env.example",
  ".env.defaults",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
  ".git-credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "serviceaccount.json",
]);

const SECRET_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /\.env\.[\w.-]+$/i,
  /\.(pem|key|p12|pfx|keystore|jks|gpg)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.\w+)?$/i,
  /(^|[/\\])\.?(ssh|aws|gcloud|kube)[/\\]/i,
  /(^|[/\\])credentials(\.\w+)?$/i,
  /(^|[/\\])secret(s)?(\.\w+)?$/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.pypirc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])\.htpasswd$/i,
  /(^|[/\\])\.git-credentials$/i,
];

export const isSecretPath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;

  if (SECRET_BASENAMES.has(basename)) return true;

  return SECRET_PATH_PATTERNS.some(pattern => pattern.test(normalized) || pattern.test(basename));
};

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  /\brk_live_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const SECRET_ASSIGNMENT = /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9+/=_\-.]{8,}['"]?/gi;

const REDACTED = "<redacted>";

export const redactSecrets = (text: string): string => {
  let out = text;

  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replaceAll(pattern, "<redacted>");
  }

  let replaced = out;
  let search = out;

  while (true) {
    SECRET_ASSIGNMENT.lastIndex = 0;

    const match = SECRET_ASSIGNMENT.exec(search);

    if (match === null) break;

    const separator = match[0].match(/[:=]/)?.[0] ?? "=";
    const replacement = `${match[0].slice(0, match[0].indexOf(separator) + 1)} ${REDACTED}`;

    replaced = replaced.slice(0, match.index) + replacement + replaced.slice(match.index + match[0].length);
    search = search.slice(match.index + match[0].length);
  }

  return replaced;
};

export const hasSecret = (text: string): boolean => {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  return SECRET_ASSIGNMENT.test(text);
};

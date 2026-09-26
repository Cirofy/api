/**
 * Boot-time env checks. Fail fast in production; warn in development.
 * Never put secret values into user-facing responses.
 */
export function assertBootEnv() {
  const isProd = process.env.NODE_ENV === "production";
  const missing: string[] = [];
  const weak: string[] = [];

  const jwt = process.env.JWT_ACCESS_SECRET?.trim() ?? "";
  if (!jwt) missing.push("JWT_ACCESS_SECRET");
  else if (
    jwt.length < 32 ||
    jwt.includes("change-me") ||
    jwt === "dev-secret"
  ) {
    weak.push("JWT_ACCESS_SECRET");
  }

  if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");

  const refresh = process.env.JWT_REFRESH_SECRET?.trim() ?? "";
  if (!refresh) missing.push("JWT_REFRESH_SECRET");
  else if (
    refresh.length < 32 ||
    refresh.includes("change-me") ||
    refresh === "dev-secret"
  ) {
    weak.push("JWT_REFRESH_SECRET");
  }

  const webhook = process.env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim() ?? "";
  if (
    isProd &&
    (!webhook ||
      webhook.includes("your_") ||
      webhook.includes("placeholder") ||
      webhook.includes("change-me"))
  ) {
    weak.push("DODO_PAYMENTS_WEBHOOK_SECRET");
  }

  if (isProd) {
    if (missing.length || weak.length) {
      const parts = [
        ...missing.map((k) => `${k} eksik`),
        ...weak.map((k) => `${k} zayıf / varsayılan`),
      ];
      throw new Error(
        `Üretim ortamı yapılandırması geçersiz: ${parts.join("; ")}`,
      );
    }
  } else {
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.warn(`[boot] Eksik env: ${missing.join(", ")}`);
    }
    if (weak.length) {
      // eslint-disable-next-line no-console
      console.warn(`[boot] Zayıf env (yalnızca geliştirme): ${weak.join(", ")}`);
    }
  }
}

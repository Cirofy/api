/** Mağaza anahtarları — geçici base64; üretimde KMS/AES. */
export function encryptCredential(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function decryptCredential(value: string | null | undefined) {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

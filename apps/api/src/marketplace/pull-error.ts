/** Kullanıcıya güvenli (stack’siz) çekim hatası */
export class MarketplacePullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplacePullError";
  }
}

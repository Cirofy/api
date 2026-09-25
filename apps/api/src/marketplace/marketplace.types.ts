export type MarketplaceCode = "TRENDYOL" | "HEPSIBURADA";

export type PulledProduct = {
  externalId: string;
  sku: string;
  title: string;
  brand?: string | null;
  barcode?: string | null;
  category?: string | null;
  returnRatePct?: number;
  stockQty?: number | null;
  /** Katalogda hâlâ listeleniyor mu (silinen/arşiv değil) */
  listed?: boolean;
  costPrice: number;
  salePrice: number;
  commissionRate: number;
  shippingCost: number;
};

export type PulledOrder = {
  externalId: string;
  productExternalId: string;
  quantity: number;
  unitPrice: number;
  orderedAt: string;
  status: "CREATED" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "RETURNED";
};

export type MarketplacePullResult = {
  products: PulledProduct[];
  orders: PulledOrder[];
  source: "simulated" | "live";
  note: string;
};

export type MarketplaceCredentials = {
  apiKey: string;
  apiSecret: string;
  externalStoreId?: string | null;
};

export type CommissionPullOptions = {
  sinceDays?: number;
  catalog?: Array<{
    sku: string | null;
    barcode: string | null;
    category: string | null;
    externalId?: string | null;
  }>;
};

export type SettlementPullOptions = {
  transactionType: string;
  sinceDays?: number;
};

export type OtherFinancialPullOptions = {
  transactionType: string;
  transactionSubType?: string;
  sinceDays?: number;
};

export type AccountingPullOptions = {
  beginDate: string;
  endDate: string;
};

export type PulledSettlementRow = {
  transactionType: string;
  orderId: string | null;
  barcode: string | null;
  transactionDate: string | null;
  sellerRevenue: number | null;
  credit: number | null;
  debt: number | null;
  commissionAmount: number | null;
  paymentOrderId: string | null;
  description: string | null;
};

export type PulledAccountingRow = {
  typeName: string;
  orderId: string | null;
  amount: number;
  transactionDate: string | null;
  description: string | null;
};

export type PulledFinancialFeeRow = {
  amount: number;
  transactionDate: string | null;
  description: string;
  transactionType: string;
  transactionSubType: string | null;
};

export type PulledSellerPromotion = {
  sku: string | null;
  title: string | null;
  kind: "discount" | "flash";
  listPrice: number | null;
  offerPrice: number | null;
  rawType: string | null;
};

export interface MarketplaceAdapter {
  readonly code: MarketplaceCode;
  pull(
    credentials: MarketplaceCredentials,
    options?: { sinceDays?: number },
  ): Promise<MarketplacePullResult>;
  pullCommissionRates?(
    credentials: MarketplaceCredentials,
    options?: CommissionPullOptions,
  ): Promise<import("./commission-rates").PulledCommissionRate[]>;
  pullSettlements?(
    credentials: MarketplaceCredentials,
    options: SettlementPullOptions,
  ): Promise<PulledSettlementRow[]>;
  pullOtherFinancials?(
    credentials: MarketplaceCredentials,
    options: OtherFinancialPullOptions,
  ): Promise<PulledFinancialFeeRow[]>;
  pullAdsFees?(
    credentials: MarketplaceCredentials,
    sinceDays?: number,
  ): Promise<PulledFinancialFeeRow[]>;
  pullAccountingTransactions?(
    credentials: MarketplaceCredentials,
    options: AccountingPullOptions,
  ): Promise<PulledAccountingRow[]>;
  pullSellerPromotions?(
    credentials: MarketplaceCredentials,
  ): Promise<PulledSellerPromotion[]>;
}

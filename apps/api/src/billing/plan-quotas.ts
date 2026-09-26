export type PlanKey = "STARTER" | "BUSINESS" | "ENTERPRISE";

/** Plan kotları — kullanıcıya genel dil; sağlayıcı adı yok */
export const PLAN_QUOTAS: Record<
  PlanKey,
  {
    monthlyOrders: number;
    maxStores: number;
    tariffScanLimit: number;
    label: string;
  }
> = {
  STARTER: {
    monthlyOrders: 1000,
    maxStores: 1,
    tariffScanLimit: 50,
    label: "Starter",
  },
  BUSINESS: {
    monthlyOrders: 5000,
    maxStores: 3,
    tariffScanLimit: 250,
    label: "Business",
  },
  ENTERPRISE: {
    monthlyOrders: 100_000,
    maxStores: 999,
    tariffScanLimit: 50_000,
    label: "Enterprise",
  },
};

export const brand = {
  name: "Cirofy",
  tagline: "Pazaryeri kârlılığını kontrol altına alın",
  domain: "cirofy.com",
  // Canonical mark asset path in each app public folder
  logoPath: "/logo.png",
} as const;

/** Design tokens — ink + profit teal (no purple / cream clichés) */
export const colors = {
  ink: "#0B1424",
  inkSoft: "#152238",
  inkMuted: "#3D4F66",
  surface: "#EEF2F6",
  surfaceElevated: "#FFFFFF",
  border: "#D5DDE8",
  profit: "#0DBF9B",
  profitDark: "#0A9A7D",
  /** Text/icon on solid profit surfaces (primary buttons) */
  profitOn: "#FFFFFF",
  profitSoft: "#D8F8F0",
  loss: "#F05252",
  lossSoft: "#FDE8E8",
  warn: "#E8A317",
  warnSoft: "#FFF4D6",
  accent: "#2B6CFF",
} as const;

export const fonts = {
  display: "Sora",
  ui: "Figtree",
} as const;

export const plans = [
  {
    id: "starter",
    name: "Starter",
    monthlyOrders: "0 – 1.000",
    productLimit: 10_000,
    priceMonthlyTry: 799,
    priceYearlyTry: 599,
  },
  {
    id: "business",
    name: "Business",
    monthlyOrders: "1.000 – 5.000",
    productLimit: 20_000,
    priceMonthlyTry: 1499,
    priceYearlyTry: 999,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyOrders: "5.000 – 30.000",
    productLimit: 30_000,
    priceMonthlyTry: 2899,
    priceYearlyTry: 1999,
  },
] as const;

export type PlanId = (typeof plans)[number]["id"];

export const marketplaces = ["TRENDYOL", "HEPSIBURADA"] as const;
export type Marketplace = (typeof marketplaces)[number];

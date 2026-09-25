import type {
  MarketplaceCode,
  MarketplacePullResult,
  PulledOrder,
  PulledProduct,
} from "./marketplace.types";

type Mapped = Omit<MarketplacePullResult, "source" | "note">;

/** Partner JSON → Cirofy çekim modeli */
export function mapPartnerPayload(
  code: MarketplaceCode,
  productsJson: unknown,
  ordersJson: unknown,
): Mapped | null {
  const productRows = extractRows(productsJson, [
    "content",
    "items",
    "products",
    "data",
    "result",
  ]);
  const orderRows = extractRows(ordersJson, [
    "content",
    "items",
    "orders",
    "data",
    "result",
  ]);

  if (!productRows || productRows.length === 0) return null;

  const products = productRows
    .map((row, i) => mapProduct(code, row, i))
    .filter((p): p is PulledProduct => p != null);

  if (products.length === 0) return null;

  const byExternal = new Map(products.map((p) => [p.externalId, p]));
  // Barkod / stok kodu ile de eşle
  for (const p of products) {
    if (p.barcode) byExternal.set(p.barcode, p);
    if (p.sku) byExternal.set(p.sku, p);
  }
  const orders: PulledOrder[] = [];

  for (const [i, row] of (orderRows ?? []).entries()) {
    const mapped = mapOrders(code, row, i, products, byExternal);
    orders.push(...mapped);
  }

  return { products, orders };
}

function extractRows(json: unknown, keys: string[]): Record<string, unknown>[] | null {
  if (Array.isArray(json)) {
    return json.filter(isRecord);
  }
  if (!isRecord(json)) return null;

  for (const key of keys) {
    const nested = json[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
    if (isRecord(nested)) {
      for (const inner of keys) {
        const arr = nested[inner];
        if (Array.isArray(arr)) return arr.filter(isRecord);
      }
    }
  }

  // Tek nesne sarmalayıcı
  if ("id" in json || "sku" in json || "barcode" in json) {
    return [json];
  }
  return null;
}

function mapProduct(
  code: MarketplaceCode,
  row: Record<string, unknown>,
  index: number,
): PulledProduct | null {
  const prefix = code === "TRENDYOL" ? "ty" : "hb";
  const externalId = firstString(row, [
    "barcode",
    "stockCode",
    "merchantSku",
    "sku",
    "productMainId",
    "id",
    "externalId",
  ]);
  if (!externalId) return null;

  const title = firstString(row, ["title", "name", "productName", "description"]) ?? "Ürün";
  const brand = firstString(row, ["brand", "brandName", "manufacturer"]);
  const barcode = firstString(row, ["barcode", "barcodeNumber", "gtin"]);
  const category = firstString(row, [
    "categoryName",
    "category",
    "leafCategoryName",
    "productCategory",
  ]);
  const returnRatePct =
    firstNumber(row, ["returnRate", "returnRatePct", "returnRatio"]) ?? 0;
  const salePrice = firstNumber(row, [
    "salePrice",
    "sellingPrice",
    "listPrice",
    "price",
    "amount",
  ]);
  const costPrice = firstNumber(row, ["costPrice", "cost", "purchasePrice"]) ?? 0;
  const commissionRate =
    firstNumber(row, ["commissionRate", "commission"]) ??
    (code === "HEPSIBURADA" ? 0.13 : 0.12);
  const desi = firstNumber(row, ["dimensionalWeight", "desi", "desiWeight"]);
  const shippingCost =
    firstNumber(row, ["shippingCost", "cargo", "desiCost"]) ??
    (desi != null ? Math.max(29, Math.round(desi * 12)) : 35);
  const sku =
    firstString(row, ["stockCode", "merchantSku", "sku", "productSellerCode"]) ??
    `SKU-${prefix.toUpperCase()}-${index + 1}`;
  const stockQty = firstNumber(row, [
    "quantity",
    "stock",
    "stockQuantity",
    "availableStock",
    "quantityAvailable",
  ]);

  const archived = firstBool(row, ["archived", "isArchived", "locked"]);
  const approved = firstBool(row, ["approved", "isApproved"]);
  // Onaylı çekimde gelen satır katalogda; arşiv/kilitli ise listelenmiyor.
  const listed = archived === true || approved === false ? false : true;

  return {
    externalId: String(externalId),
    sku,
    title,
    brand,
    barcode,
    category,
    returnRatePct: returnRatePct > 1 ? returnRatePct : returnRatePct * 100,
    stockQty: stockQty != null ? Math.round(stockQty) : null,
    listed,
    costPrice,
    salePrice: salePrice ?? 0,
    commissionRate: commissionRate > 1 ? commissionRate / 100 : commissionRate,
    shippingCost,
  };
}

function mapOrders(
  code: MarketplaceCode,
  row: Record<string, unknown>,
  index: number,
  products: PulledProduct[],
  byExternal: Map<string, PulledProduct>,
): PulledOrder[] {
  const prefix = code === "TRENDYOL" ? "ty" : "hb";
  const packageId = firstString(row, [
    "orderNumber",
    "packageNumber",
    "id",
    "externalId",
    "shipmentPackageId",
  ]);
  if (!packageId) return [];

  const orderedAt =
    parseDate(row, [
      "orderDate",
      "orderedAt",
      "createdAt",
      "packageCreationDate",
      "originShipmentDate",
    ]) ?? new Date().toISOString();
  const status = sanitizeStatus(
    firstString(row, ["status", "shipmentPackageStatus", "orderStatus"]),
  );

  const lines = extractLines(row);
  if (lines.length === 0) {
    const productExternalId =
      firstString(row, ["barcode", "merchantSku", "sku", "productId"]) ||
      products[index % products.length]!.externalId;
    const matched = byExternal.get(productExternalId);
    return [
      {
        externalId: `${prefix}-${packageId}`,
        productExternalId:
          matched?.externalId ?? products[index % products.length]!.externalId,
        quantity: firstNumber(row, ["quantity", "qty"]) ?? 1,
        unitPrice:
          firstNumber(row, ["price", "unitPrice", "totalPrice"]) ??
          matched?.salePrice ??
          products[0]!.salePrice,
        orderedAt,
        status,
      },
    ];
  }

  const out: PulledOrder[] = [];
  for (const [li, line] of lines.entries()) {
    const lineKey =
      firstString(line, [
        "barcode",
        "merchantSku",
        "sku",
        "productSellerCode",
        "stockCode",
        "id",
      ]) ?? String(li);
    const productKey =
      firstString(line, [
        "barcode",
        "merchantSku",
        "sku",
        "productSellerCode",
        "stockCode",
        "productId",
      ]) || products[index % products.length]!.externalId;
    const matched = byExternal.get(productKey);
    out.push({
      externalId: `${prefix}-${packageId}-${lineKey}`,
      productExternalId:
        matched?.externalId ?? products[index % products.length]!.externalId,
      quantity: firstNumber(line, ["quantity", "amount", "qty"]) ?? 1,
      unitPrice:
        firstNumber(line, ["price", "unitPrice", "salePrice", "amount"]) ??
        matched?.salePrice ??
        products[0]!.salePrice,
      orderedAt,
      status,
    });
  }
  return out;
}

function parseDate(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      const ms = v < 1e12 ? v * 1000 : v;
      return new Date(ms).toISOString();
    }
    const s = String(v).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      const ms = n < 1e12 ? n * 1000 : n;
      return new Date(ms).toISOString();
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function extractLines(row: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["lines", "orderLines", "items", "products"]) {
    const v = row[key];
    if (Array.isArray(v)) return v.filter(isRecord);
  }
  return [];
}

function sanitizeStatus(
  raw: string | null,
): "CREATED" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "RETURNED" {
  if (!raw) return "DELIVERED";
  const s = raw.toUpperCase();
  if (s.includes("CANCEL") || s.includes("UNSUPPLIED")) return "CANCELLED";
  if (s.includes("RETURN") || s.includes("IADE")) return "RETURNED";
  if (
    s.includes("SHIP") ||
    s.includes("KARGO") ||
    s.includes("INTRANSIT") ||
    s.includes("UNDELIVERED") ||
    s.includes("COLLECTION")
  ) {
    return "SHIPPED";
  }
  if (
    s.includes("CREATE") ||
    s.includes("NEW") ||
    s.includes("WAITING") ||
    s.includes("AWAITING") ||
    s.includes("PICKING") ||
    s.includes("INVOICED")
  ) {
    return "CREATED";
  }
  if (
    s === "CREATED" ||
    s === "SHIPPED" ||
    s === "DELIVERED" ||
    s === "CANCELLED" ||
    s === "RETURNED"
  ) {
    return s;
  }
  return "DELIVERED";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstBool(row: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const v = row[key];
    if (v == null) continue;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v).trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return null;
}

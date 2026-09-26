import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import DodoPayments from "dodopayments";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCheckoutDto } from "./dto";
import { PLAN_QUOTAS, type PlanKey } from "./quota.service";

const PLAN_ENV: Record<CreateCheckoutDto["planId"], string> = {
  starter: "DODO_PRODUCT_STARTER",
  business: "DODO_PRODUCT_BUSINESS",
  enterprise: "DODO_PRODUCT_ENTERPRISE",
};

function isPlaceholder(value: string | undefined | null) {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return (
    !v ||
    v.includes("your_") ||
    v.includes("placeholder") ||
    v.includes("change-me")
  );
}

function safeEqual(a: string, b: string) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly client: DodoPayments | null;
  private readonly isProd: boolean;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.isProd = this.config.get<string>("NODE_ENV") === "production";
    this.webhookSecret =
      this.config.get<string>("DODO_PAYMENTS_WEBHOOK_SECRET")?.trim() ?? "";
    const apiKey = this.config.get<string>("DODO_PAYMENTS_API_KEY");
    const env =
      this.config.get<string>("DODO_PAYMENTS_ENVIRONMENT") ?? "test_mode";
    if (apiKey && !isPlaceholder(apiKey)) {
      this.client = new DodoPayments({
        bearerToken: apiKey,
        environment: env === "live_mode" ? "live_mode" : "test_mode",
      });
    } else {
      this.client = null;
      this.logger.warn("Payment provider credentials missing — checkout mock mode");
    }
  }

  async createCheckout(
    user: {
      id: string;
      email: string;
      fullName: string;
      organization: { id: string; name: string } | null;
    },
    dto: CreateCheckoutDto,
  ) {
    if (!user.organization) {
      throw new BadRequestException("Organizasyon bulunamadı");
    }

    const planKey = dto.planId.toUpperCase() as PlanKey;
    const returnUrl =
      this.config.get<string>("DODO_RETURN_URL") ??
      "http://localhost:3001/billing/success";

    if (!this.client) {
      if (this.isProd) {
        throw new ServiceUnavailableException(
          "Ödeme şu an yapılandırılamadı. Lütfen destek ile iletişime geçin.",
        );
      }
      await this.applyPlan(user.organization.id, planKey, dto.billingInterval);
      return {
        mock: true,
        checkoutUrl: `${returnUrl}?mock=1&plan=${dto.planId}&interval=${dto.billingInterval}`,
        planId: dto.planId,
        quotas: PLAN_QUOTAS[planKey],
        message: "Plan güncellendi. Kota anında uygulanır.",
      };
    }

    const productEnv = PLAN_ENV[dto.planId];
    const productId = this.config.get<string>(productEnv);
    if (!productId || isPlaceholder(productId)) {
      throw new BadRequestException(
        "Seçilen plan için ödeme yapılandırması eksik. Destek ile iletişime geçin.",
      );
    }

    try {
      const session = await this.client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: {
          email: user.email,
          name: user.fullName,
        },
        return_url: returnUrl,
        metadata: {
          organizationId: user.organization.id,
          userId: user.id,
          planId: dto.planId,
          billingInterval: dto.billingInterval,
        },
      });

      return {
        mock: false,
        checkoutUrl: session.checkout_url,
        sessionId: session.session_id,
      };
    } catch (error) {
      this.logger.error("Checkout session failed", error as Error);
      throw new ServiceUnavailableException("Ödeme oturumu oluşturulamadı");
    }
  }

  async applyPlan(
    organizationId: string,
    planId: PlanKey,
    billingInterval: "month" | "year" = "month",
  ) {
    await this.prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        planId,
        status: "ACTIVE",
        interval: billingInterval === "year" ? "YEAR" : "MONTH",
        currentPeriodStart: new Date(),
        trialEndsAt: null,
      },
      update: {
        planId,
        status: "ACTIVE",
        interval: billingInterval === "year" ? "YEAR" : "MONTH",
        currentPeriodStart: new Date(),
        trialEndsAt: null,
        canceledAt: null,
      },
    });
  }

  private assertWebhookSignature(
    payload: Record<string, unknown>,
    signature?: string,
  ) {
    if (isPlaceholder(this.webhookSecret)) {
      if (this.isProd) {
        throw new UnauthorizedException("Webhook doğrulaması yapılamadı");
      }
      this.logger.warn("Webhook secret missing — signature skipped (dev only)");
      return;
    }
    if (!signature?.trim()) {
      throw new UnauthorizedException("Webhook imzası eksik");
    }
    const raw = JSON.stringify(payload);
    const expected = createHmac("sha256", this.webhookSecret)
      .update(raw)
      .digest("hex");
    const candidates = [
      signature.trim(),
      signature.replace(/^sha256=/i, "").trim(),
      this.webhookSecret,
    ];
    const ok = candidates.some(
      (c) => safeEqual(c, expected) || safeEqual(c, this.webhookSecret),
    );
    if (!ok) {
      throw new UnauthorizedException("Webhook imzası geçersiz");
    }
  }

  async handleWebhook(payload: Record<string, unknown>, signature?: string) {
    this.assertWebhookSignature(payload, signature);

    const type = String(payload.type ?? "");
    this.logger.log(`Payment webhook received: ${type}`);

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, string>;
    const organizationId = metadata.organizationId;
    const planId = metadata.planId?.toUpperCase() as PlanKey | undefined;

    if (
      organizationId &&
      planId &&
      PLAN_QUOTAS[planId] &&
      (type.includes("payment") || type.includes("subscription"))
    ) {
      await this.applyPlan(
        organizationId,
        planId,
        metadata.billingInterval === "year" ? "year" : "month",
      );
    }

    return { received: true };
  }
}

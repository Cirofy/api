import { Body, Controller, Get, Headers, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { BillingService } from "./billing.service";
import { QuotaService } from "./quota.service";
import { CreateCheckoutDto } from "./dto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@ApiTags("billing")
@Controller("billing")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly quotas: QuotaService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("usage")
  usage(@Req() req: { user: { organization: { id: string } | null } }) {
    const orgId = req.user.organization?.id;
    if (!orgId) {
      return {
        planId: "STARTER",
        planLabel: "Starter",
        status: "TRIALING",
        trialEndsAt: null,
        ordersThisMonth: 0,
        orderLimit: 1000,
        orderUsagePct: 0,
        storeCount: 0,
        storeLimit: 1,
        canConnectStore: true,
        canSync: true,
        blockedReason: null,
        nearOrderLimit: false,
        nearStoreLimit: false,
        warnReason: null,
        tariffMismatchCount: 0,
        tariffNote: null,
      };
    }
    return this.quotas.getUsage(orgId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post("checkout")
  checkout(
    @Req() req: { user: Parameters<BillingService["createCheckout"]>[0] },
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.billing.createCheckout(req.user, dto);
  }

  @Post("webhooks/payments")
  webhook(
    @Body() body: Record<string, unknown>,
    @Headers("webhook-signature") signature?: string,
    @Headers("x-webhook-secret") legacySecret?: string,
  ) {
    return this.billing.handleWebhook(body, signature ?? legacySecret);
  }
}

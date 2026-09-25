import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { QuotaService } from "./quota.service";
import { TariffsModule } from "../tariffs/tariffs.module";

@Module({
  imports: [TariffsModule],
  controllers: [BillingController],
  providers: [BillingService, QuotaService],
  exports: [BillingService, QuotaService],
})
export class BillingModule {}

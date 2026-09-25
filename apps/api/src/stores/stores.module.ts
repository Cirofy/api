import { Module } from "@nestjs/common";
import { StoresController } from "./stores.controller";
import { StoresService } from "./stores.service";
import { SyncJobsService } from "./sync-jobs.service";
import { BillingModule } from "../billing/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MarketplaceModule } from "../marketplace/marketplace.module";

@Module({
  imports: [BillingModule, NotificationsModule, MarketplaceModule],
  controllers: [StoresController],
  providers: [StoresService, SyncJobsService],
  exports: [StoresService, SyncJobsService],
})
export class StoresModule {}


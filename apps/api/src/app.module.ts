import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { AdminModule } from "./admin/admin.module";
import { StoresModule } from "./stores/stores.module";
import { CatalogModule } from "./catalog/catalog.module";
import { LiveModule } from "./live/live.module";
import { MetricsModule } from "./metrics/metrics.module";
import { ReportsModule } from "./reports/reports.module";
import { AdsModule } from "./ads/ads.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { SettlementsModule } from "./settlements/settlements.module";
import { PricingModule } from "./pricing/pricing.module";
import { BuyboxModule } from "./buybox/buybox.module";
import { PromotionsModule } from "./promotions/promotions.module";
import { ScenariosModule } from "./scenarios/scenarios.module";
import { RadarModule } from "./radar/radar.module";
import { TeamModule } from "./team/team.module";
import { AgencyModule } from "./agency/agency.module";
import { SupportModule } from "./support/support.module";
import { ReturnsModule } from "./returns/returns.module";
import { TariffsModule } from "./tariffs/tariffs.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    BillingModule,
    DashboardModule,
    AdminModule,
    StoresModule,
    CatalogModule,
    LiveModule,
    MetricsModule,
    ReportsModule,
    AdsModule,
    NotificationsModule,
    SettlementsModule,
    PricingModule,
    BuyboxModule,
    PromotionsModule,
    ScenariosModule,
    RadarModule,
    TeamModule,
    AgencyModule,
    SupportModule,
    ReturnsModule,
    TariffsModule,
  ],
})
export class AppModule {}

import { Module } from "@nestjs/common";
import { SettlementsController } from "./settlements.controller";
import { SettlementsService } from "./settlements.service";
import { TariffsModule } from "../tariffs/tariffs.module";
import { MarketplaceModule } from "../marketplace/marketplace.module";

@Module({
  imports: [TariffsModule, MarketplaceModule],
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}

import { Module } from "@nestjs/common";
import { AdsController } from "./ads.controller";
import { AdsService } from "./ads.service";
import { MarketplaceModule } from "../marketplace/marketplace.module";

@Module({
  imports: [MarketplaceModule],
  controllers: [AdsController],
  providers: [AdsService],
  exports: [AdsService],
})
export class AdsModule {}

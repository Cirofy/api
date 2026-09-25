import { Module } from "@nestjs/common";
import { MarketplaceModule } from "../marketplace/marketplace.module";
import { PromotionsController } from "./promotions.controller";
import { PromotionsService } from "./promotions.service";

@Module({
  imports: [MarketplaceModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
})
export class PromotionsModule {}

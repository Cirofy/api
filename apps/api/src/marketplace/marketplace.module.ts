import { Module } from "@nestjs/common";
import { MarketplaceRegistry } from "./marketplace.registry";

@Module({
  providers: [MarketplaceRegistry],
  exports: [MarketplaceRegistry],
})
export class MarketplaceModule {}

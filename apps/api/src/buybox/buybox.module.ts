import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { TariffsModule } from "../tariffs/tariffs.module";
import { BuyboxController } from "./buybox.controller";
import { BuyboxService } from "./buybox.service";

@Module({
  imports: [NotificationsModule, TariffsModule],
  controllers: [BuyboxController],
  providers: [BuyboxService],
})
export class BuyboxModule {}

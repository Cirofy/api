import { Module, forwardRef } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MarketplaceModule } from "../marketplace/marketplace.module";
import { TariffsController } from "./tariffs.controller";
import { TariffsService } from "./tariffs.service";

@Module({
  imports: [MailModule, forwardRef(() => NotificationsModule), MarketplaceModule],
  controllers: [TariffsController],
  providers: [TariffsService],
  exports: [TariffsService],
})
export class TariffsModule {}

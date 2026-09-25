import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { TariffsModule } from "../tariffs/tariffs.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [MailModule, TariffsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}

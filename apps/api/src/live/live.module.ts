import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { LiveController } from "./live.controller";
import { LiveService } from "./live.service";
import { TariffsModule } from "../tariffs/tariffs.module";

@Module({
  imports: [
    TariffsModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? "cirofy-dev-access-secret-change-me-32chars",
    }),
  ],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}

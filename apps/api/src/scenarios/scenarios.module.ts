import { Module } from "@nestjs/common";
import { TariffsModule } from "../tariffs/tariffs.module";
import { ScenariosController } from "./scenarios.controller";
import { ScenariosService } from "./scenarios.service";

@Module({
  imports: [TariffsModule],
  controllers: [ScenariosController],
  providers: [ScenariosService],
})
export class ScenariosModule {}

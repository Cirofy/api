import { Module } from "@nestjs/common";
import { RadarController } from "./radar.controller";
import { RadarService } from "./radar.service";
import { TariffsModule } from "../tariffs/tariffs.module";

@Module({
  imports: [TariffsModule],
  controllers: [RadarController],
  providers: [RadarService],
})
export class RadarModule {}

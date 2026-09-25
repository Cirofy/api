import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>("JWT_ACCESS_SECRET");
        const isProd = config.get<string>("NODE_ENV") === "production";
        if (isProd && (!secret || secret.length < 32 || secret.includes("change-me"))) {
          throw new Error("JWT_ACCESS_SECRET üretim için zorunlu ve güçlü olmalı");
        }
        return {
          secret: secret ?? "dev-secret",
          signOptions: {
            expiresIn: (config.get<string>("JWT_ACCESS_TTL") ?? "8h") as
              | `${number}m`
              | `${number}h`
              | `${number}d`,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { assertBootEnv } from "./boot-env";

async function bootstrap() {
  assertBootEnv();

  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin: [
      process.env.APP_URL ?? "http://localhost:3000",
      process.env.WEB_URL ?? "http://localhost:3001",
      process.env.ADMIN_URL ?? "http://localhost:3002",
    ],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const isProd = process.env.NODE_ENV === "production";
  if (!isProd || process.env.ENABLE_API_DOCS === "true") {
    const swagger = new DocumentBuilder()
      .setTitle("Cirofy API")
      .setDescription("Pazaryeri kârlılık API")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swagger));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`Cirofy API listening on :${port}`);
}

bootstrap();

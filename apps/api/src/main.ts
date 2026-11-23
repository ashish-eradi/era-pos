import 'reflect-metadata';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { HealthResponseV1 } from '@era/contracts';
import { openDatabase } from './database';
import { MERCHANT_DATABASE, MerchantController } from './modules/merchant/merchant.controller';

const database = openDatabase();

@Controller('v1/health')
class HealthController {
  @Get()
  async readiness(): Promise<HealthResponseV1> {
    try {
      await database.query('SELECT 1');
      return { version: 1, status: 'ok' };
    } catch {
      const response: HealthResponseV1 = { version: 1, status: 'unavailable' };
      throw new ServiceUnavailableException(response);
    }
  }
}

@Module({
  controllers: [HealthController, MerchantController],
  providers: [{ provide: MERCHANT_DATABASE, useValue: database }],
})
class ApiModule {
  async onApplicationShutdown(): Promise<void> {
    await database.end();
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

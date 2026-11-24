import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, Get, HttpException, Module, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost, NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { HealthResponseV1 } from '@era/contracts';
import { openDatabase } from './database';
import { MERCHANT_DATABASE, MerchantController } from './modules/merchant/merchant.controller';
import { OnboardingController } from './modules/onboarding/onboarding';
import { PlatformController } from './modules/onboarding/platform';
import { CatalogController } from './modules/catalog/catalog';
import { CashController } from './modules/cash/cash';
import { ReturnsController } from './modules/cash/returns';
import { RecoveryController } from './modules/cash/recovery';
import { ClosesController } from './modules/cash/closes';
import { InventoryController } from './modules/catalog/inventory';
import { BillingController } from './modules/merchant/billing';
import { SupportController } from './modules/support/support';
import { PaymentsController } from './modules/payments/payments';
import { MerchantWebhooks } from './modules/merchant/webhooks';
import { BranchShifts } from './modules/cash/branch-shifts';
import { MerchantSignup } from './modules/onboarding/signup';

const database = openDatabase();

type TracedRequest = IncomingMessage & {
  startedAt: number; params?: { merchantId?: string }; route?: { path: string };
};

@Catch()
class ApiErrorFilter extends BaseExceptionFilter {
  override catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<TracedRequest>();
    const res = http.getResponse<ServerResponse>();
    console.error(JSON.stringify({
      requestId: res.getHeader('x-request-id'), merchant: req.params?.merchantId ?? null,
      endpoint: req.route?.path ?? req.url?.split('?')[0], method: req.method,
      status: error instanceof HttpException ? error.getStatus() : 500,
      durationMs: Date.now() - req.startedAt,
    }));
    super.catch(error, host);
  }
}

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
  controllers: [HealthController, MerchantController, OnboardingController, PlatformController, CatalogController, CashController, ReturnsController, ClosesController, RecoveryController, InventoryController, BillingController, SupportController, PaymentsController, MerchantWebhooks, BranchShifts, MerchantSignup],
  providers: [{ provide: MERCHANT_DATABASE, useValue: database }],
})
class ApiModule {
  async onApplicationShutdown(): Promise<void> {
    await database.end();
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { rawBody: true });
  app.use((req: TracedRequest, res: ServerResponse, next: () => void) => {
    req.startedAt = Date.now();
    const id = req.headers['x-request-id'];
    res.setHeader('x-request-id', typeof id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(id) ? id : randomUUID());
    next();
  });
  app.useGlobalFilters(new ApiErrorFilter(app.get(HttpAdapterHost).httpAdapter));
  app.useBodyParser('json', { limit: '256kb' });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { openDatabase } from '../database';
import { completeNextMerchantExport } from '../modules/merchant/exports';
import { deliverNextWebhook } from '../modules/merchant/webhooks';
import { provisionNextSignup } from '../modules/onboarding/signup';

const database = openDatabase();
let keepAlive: ReturnType<typeof setInterval> | undefined;

@Module({})
class WorkerModule {
  async onApplicationShutdown(): Promise<void> {
    clearInterval(keepAlive);
    await database.end();
  }
}

async function main(): Promise<void> {
  await database.query('SELECT 1');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  keepAlive = setInterval(() => {
    void deliverNextWebhook(database).catch(error => Logger.error(error,'Webhook delivery'));
    void provisionNextSignup(database).catch(error => Logger.error(error,'Signup provisioning'));
    void completeNextMerchantExport(database).catch((error: unknown) => {
      Logger.error(error, 'Merchant export worker');
    });
  }, 1000);
  Logger.log('Worker ready', 'Worker');
}

void main().catch(async (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  await database.end();
});

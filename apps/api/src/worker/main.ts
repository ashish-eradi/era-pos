import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { openDatabase } from '../database';

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
    void database.query('SELECT 1').catch((error: unknown) => {
      Logger.error(error, 'Worker database check');
    });
  }, 30_000);
  Logger.log('Worker ready', 'Worker');
}

void main().catch(async (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  await database.end();
});

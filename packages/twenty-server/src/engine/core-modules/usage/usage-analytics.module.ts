/* @license Enterprise */

import { Module } from '@nestjs/common';

import { ClickHouseModule } from 'src/database/clickhouse/clickhouse.module';
import { CacheLockModule } from 'src/engine/core-modules/cache-lock/cache-lock.module';
import { UsageAnalyticsService } from 'src/engine/core-modules/usage/services/usage-analytics.service';

@Module({
  imports: [ClickHouseModule, CacheLockModule],
  providers: [UsageAnalyticsService],
  exports: [UsageAnalyticsService],
})
export class UsageAnalyticsModule {}

/* @license Enterprise */

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { isNonEmptyString } from '@sniptt/guards';

import { isNonEmptyArray } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { ClickHouseService } from 'src/database/clickhouse/clickhouse.service';
import { formatDateTimeForClickHouse } from 'src/database/clickhouse/utils/format-date-time-for-clickhouse.util';
import { ApplicationEntity } from 'src/engine/core-modules/application/application.entity';
import { CacheLockService } from 'src/engine/core-modules/cache-lock/cache-lock.service';
import { CacheLockException } from 'src/engine/core-modules/cache-lock/exceptions/cache-lock.exception';
import { InjectCacheStorage } from 'src/engine/core-modules/cache-storage/decorators/cache-storage.decorator';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';
import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import {
  CREDITS_USED_CACHE_TTL,
  CREDITS_USED_CACHE_RETRY_TTL,
  CREDITS_USED_REFRESH_LOCK_TTL,
} from 'src/engine/core-modules/usage/constants/credits-used-cache.constant';
import { type SpenderType } from 'src/engine/core-modules/usage-limit/types/spender-type.type';
import { UsageOperationType } from 'src/engine/core-modules/usage/enums/usage-operation-type.enum';
import { UsageResourceType } from 'src/engine/core-modules/usage/enums/usage-resource-type.enum';
import { type UsageUnit } from 'src/engine/core-modules/usage/enums/usage-unit.enum';
import { type UsageConsumptionRow } from 'src/engine/core-modules/usage/types/usage-consumption-row.type';
import { type UsageConsumptionTotals } from 'src/engine/core-modules/usage/types/usage-consumption-totals.type';
import { type UsagePeriodAnchor } from 'src/engine/core-modules/usage/types/usage-period-anchor.type';
import { buildRecurringChargeKey } from 'src/engine/core-modules/usage/utils/build-recurring-charge-key.util';
import { buildUsagePeriodClause } from 'src/engine/core-modules/usage/utils/build-usage-period-clause.util';
import { buildUsageResourceTypeFilter } from 'src/engine/core-modules/usage/utils/build-usage-resource-type-filter.util';
import { buildUsageScopeFilter } from 'src/engine/core-modules/usage/utils/build-usage-scope-filter.util';
import { fillUsageTimeSeriesGaps } from 'src/engine/core-modules/usage/utils/fill-usage-time-series-gaps.util';
import { toDisplayCredits } from 'src/engine/core-modules/usage/utils/to-display-credits.util';
import { toDollars } from 'src/engine/core-modules/usage/utils/to-dollars.util';

export type CreditUsedItem = {
  key: string;
  label?: string;
  resource?: UsageResourceType | null;
  operation?: UsageOperationType | null;
  creditsUsed: number;
};

export type UsageApplicationBreakdownItem = {
  applicationId: string;
  operation: string;
  creditsUsed: number;
};

export type UsageTimeSeriesPoint = {
  date: string;
  creditsUsed: number;
};

type BreakdownRowMicro<TColumn extends string> = Record<TColumn, string> & {
  creditsUsedMicro: number;
};

type TimeSeriesRowMicro = {
  date: string;
  creditsUsedMicro: number;
};

type PeriodParams = {
  workspaceId: string;
  periodStart: Date;
  periodEnd: Date;
  operationTypes?: string[];
};

const ALLOWED_GROUP_BY_FIELDS = [
  'userWorkspaceId',
  'resourceId',
  'operationType',
  'resourceType',
  'resourceContext',
] as const;

type GroupByField = (typeof ALLOWED_GROUP_BY_FIELDS)[number];

const BREAKDOWN_QUERY_LIMIT = 50;

// Scopes a declared operation to its application; both sides of the comparison use it so they cannot spell the pair differently.
const DECLARED_OPERATION_KEY_SEPARATOR = ':';

@Injectable()
export class UsageAnalyticsService {
  private readonly logger = new Logger(UsageAnalyticsService.name);

  constructor(
    private readonly clickHouseService: ClickHouseService,
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
    @InjectCacheStorage(CacheStorageNamespace.ModuleApplications)
    private readonly cacheStorageService: CacheStorageService,
    private readonly cacheLockService: CacheLockService,
  ) {}

  async getCreditsUsedBreakdownForRegistration(
    applicationRegistrationId: string,
  ): Promise<CreditUsedItem[] | null> {
    const cacheKey = `registration-credits-used:v1:${applicationRegistrationId}`;
    const readCache = () =>
      this.cacheStorageService
        .get<{ creditsUsedBreakdown: CreditUsedItem[] | null }>(cacheKey)
        .then((cached) => cached?.creditsUsedBreakdown)
        .catch((error) => {
          this.logger.warn(
            `Failed to read credits used cache for registration ${applicationRegistrationId}`,
            error,
          );
          return undefined;
        });
    const cached = await readCache();

    if (cached !== undefined) {
      return cached;
    }

    try {
      return await this.cacheLockService.withLock(
        async () => {
          const cachedAfterLock = await readCache();

          if (cachedAfterLock !== undefined) {
            return cachedAfterLock;
          }

          const creditsUsedBreakdown = await this.loadCreditsUsedBreakdown(
            applicationRegistrationId,
          );

          await this.cacheStorageService
            .set(
              cacheKey,
              { creditsUsedBreakdown },
              creditsUsedBreakdown === null
                ? CREDITS_USED_CACHE_RETRY_TTL
                : CREDITS_USED_CACHE_TTL,
            )
            .catch((error) => {
              this.logger.warn(
                `Failed to cache credits used for registration ${applicationRegistrationId}`,
                error,
              );
            });

          return creditsUsedBreakdown;
        },
        cacheKey,
        { ttl: CREDITS_USED_REFRESH_LOCK_TTL },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to lock credits used refresh for registration ${applicationRegistrationId}`,
        error,
      );
      return error instanceof CacheLockException
        ? null
        : this.loadCreditsUsedBreakdown(applicationRegistrationId);
    }
  }

  private async loadCreditsUsedBreakdown(
    applicationRegistrationId: string,
  ): Promise<CreditUsedItem[] | null> {
    try {
      const applications = await this.coreDataSource
        .createQueryBuilder(ApplicationEntity, 'application')
        .select('application.id', 'id')
        .innerJoin('application.workspace', 'workspace')
        .where(
          'application.applicationRegistrationId = :applicationRegistrationId',
          { applicationRegistrationId },
        )
        .andWhere('workspace.deletedAt IS NULL')
        .getRawMany<{ id: string }>();

      return isNonEmptyArray(applications)
        ? await this.getCreditsUsedBreakdownForApplications(
            applications.map(({ id }) => id),
          )
        : [];
    } catch (error) {
      this.logger.warn(
        `Failed to load credits used for registration ${applicationRegistrationId}`,
        error,
      );
      return null;
    }
  }

  async getCreditsUsedBreakdownForApplications(
    applicationIds: string[],
  ): Promise<CreditUsedItem[]> {
    const rows = await this.clickHouseService.selectOrThrow<
      BreakdownRowMicro<'resourceType' | 'operationType'>
    >(
      `SELECT resourceType, operationType, sum(creditsUsedMicro) AS creditsUsedMicro
       FROM usageEvent
       WHERE applicationId IN {applicationIds:Array(String)}
       GROUP BY resourceType, operationType
       HAVING creditsUsedMicro != 0
       ORDER BY creditsUsedMicro DESC
       SETTINGS max_execution_time = 10`,
      { applicationIds },
    );

    return rows.map(({ resourceType, operationType, creditsUsedMicro }) => ({
      key: operationType,
      resource:
        Object.values(UsageResourceType).find(
          (resource) => resource === resourceType,
        ) ?? null,
      operation:
        Object.values(UsageOperationType).find(
          (operation) => operation === operationType,
        ) ?? null,
      creditsUsed: toDisplayCredits(Number(creditsUsedMicro)),
    }));
  }

  async getConsumptionRowsForAllScopes({
    workspaceId,
    resourceType,
    periodStart,
    periodEnd,
    periodAnchor,
  }: {
    workspaceId: string;
    resourceType: UsageResourceType;
    periodStart: Date;
    periodEnd: Date;
    periodAnchor: UsagePeriodAnchor;
  }): Promise<UsageConsumptionRow[]> {
    const periodClause = buildUsagePeriodClause(periodAnchor);
    const resourceTypeFilter = buildUsageResourceTypeFilter(resourceType);

    // Grouped again so the shape matches the consumption_by_scope projection, which is picked only on a full key match.
    return this.clickHouseService.selectOrThrow<UsageConsumptionRow>(
      `SELECT operationType, unit, userWorkspaceId, apiKeyId, applicationId,
              agentId, workflowId, logicFunctionId,
              sum(creditsUsedMicro) AS creditsUsedMicro,
              sum(quantity) AS quantity
       FROM usageEvent
       WHERE workspaceId = {workspaceId:String}
         ${resourceTypeFilter.clause}
         ${periodClause}
       GROUP BY operationType, unit, userWorkspaceId, apiKeyId, applicationId,
                agentId, workflowId, logicFunctionId`,
      {
        workspaceId,
        ...resourceTypeFilter.params,
        periodStart: formatDateTimeForClickHouse(periodStart),
        periodEnd: formatDateTimeForClickHouse(periodEnd),
      },
    );
  }

  async getConsumptionTotalsForScope({
    workspaceId,
    resourceType,
    operationType,
    unit,
    spenderType,
    spenderId,
    periodStart,
    periodEnd,
    periodAnchor,
  }: {
    workspaceId: string;
    resourceType: UsageResourceType;
    operationType: UsageOperationType;
    unit: UsageUnit | null;
    spenderType: SpenderType;
    spenderId: string | null;
    periodStart: Date;
    periodEnd: Date;
    periodAnchor: UsagePeriodAnchor;
  }): Promise<UsageConsumptionTotals> {
    const resourceTypeFilter = buildUsageResourceTypeFilter(resourceType);
    const scopeFilter = buildUsageScopeFilter({
      operationType,
      unit,
      spenderType,
      spenderId,
    });

    const rows =
      await this.clickHouseService.selectOrThrow<UsageConsumptionTotals>(
        `SELECT sum(creditsUsedMicro) AS creditsUsedMicro,
                sum(quantity) AS quantity
         FROM usageEvent
         WHERE workspaceId = {workspaceId:String}
           ${resourceTypeFilter.clause}
           ${buildUsagePeriodClause(periodAnchor)}
           ${scopeFilter.clause}`,
        {
          workspaceId,
          ...resourceTypeFilter.params,
          periodStart: formatDateTimeForClickHouse(periodStart),
          periodEnd: formatDateTimeForClickHouse(periodEnd),
          ...scopeFilter.params,
        },
      );

    return {
      creditsUsedMicro: rows[0]?.creditsUsedMicro ?? 0,
      quantity: rows[0]?.quantity ?? 0,
    };
  }

  async getCreditsUsedMicroForBillingPeriod({
    workspaceId,
    periodStart,
  }: {
    workspaceId: string;
    periodStart: Date;
  }): Promise<number> {
    // The grouping only exists to match the billing_by_workspace_period projection; it still returns one row.
    const rows = await this.clickHouseService.selectOrThrow<{
      total: string | number | null;
    }>(
      `SELECT sum(creditsUsedMicro) AS total
       FROM usageEvent
       WHERE workspaceId = {workspaceId:String}
         AND periodStart = {periodStart:DateTime64(3)}
       GROUP BY workspaceId, periodStart`,
      { workspaceId, periodStart: formatDateTimeForClickHouse(periodStart) },
    );

    return Number(rows[0]?.total ?? 0);
  }

  async getAdminAiUsageByWorkspace(params: {
    periodStart: Date;
    periodEnd: Date;
    useDollarMode?: boolean;
  }): Promise<CreditUsedItem[]> {
    const aiOperationTypes = ['AI_CHAT_TOKEN', 'AI_WORKFLOW_TOKEN'];

    const convert = params.useDollarMode ? toDollars : toDisplayCredits;

    const query = `
      SELECT
        workspaceId AS key,
        sum(creditsUsedMicro) AS creditsUsedMicro
      FROM usageEvent
      WHERE timestamp >= {periodStart:String}
        AND timestamp < {periodEnd:String}
        AND operationType IN ({operationTypes:Array(String)})
      GROUP BY workspaceId
      ORDER BY creditsUsedMicro DESC
      LIMIT ${BREAKDOWN_QUERY_LIMIT}
    `;

    const rows = await this.clickHouseService.select<BreakdownRowMicro<'key'>>(
      query,
      {
        periodStart: formatDateTimeForClickHouse(params.periodStart),
        periodEnd: formatDateTimeForClickHouse(params.periodEnd),
        operationTypes: aiOperationTypes,
      },
    );

    return rows.map((row) => ({
      key: row.key,
      creditsUsed: convert(row.creditsUsedMicro),
    }));
  }

  async getUsageByUser(params: PeriodParams): Promise<CreditUsedItem[]> {
    return this.queryBreakdown({
      ...params,
      groupByField: 'userWorkspaceId',
      extraWhere: "AND userWorkspaceId != ''",
    });
  }

  async getUsageByModel(params: PeriodParams): Promise<CreditUsedItem[]> {
    return this.queryBreakdown({
      ...params,
      groupByField: 'resourceContext',
      extraWhere: "AND resourceContext != ''",
    });
  }

  async getUsageByOperationType(
    params: PeriodParams & { userWorkspaceId?: string },
  ): Promise<CreditUsedItem[]> {
    return this.queryBreakdown({
      ...params,
      groupByField: 'operationType',
      ...(params.userWorkspaceId && {
        extraWhere: 'AND userWorkspaceId = {userWorkspaceId:String}',
        extraParams: { userWorkspaceId: params.userWorkspaceId },
      }),
    });
  }

  // Apps share a closed operation-type enum, so grouping on the app and its declared operation shows what each app charged.
  // Undeclared contexts collapse here rather than in the resolver, so the limit truncates displayed slices.
  async getUsageByApplication({
    workspaceId,
    periodStart,
    periodEnd,
    operationTypes,
    userWorkspaceId,
    declaredOperationsByApplicationId,
  }: PeriodParams & {
    userWorkspaceId?: string;
    declaredOperationsByApplicationId: Record<string, string[]>;
  }): Promise<UsageApplicationBreakdownItem[]> {
    const hasOperationTypes = isNonEmptyArray(operationTypes);
    const declaredOperationKeys = Object.entries(
      declaredOperationsByApplicationId,
    ).flatMap(([applicationId, operations]) =>
      operations.map(
        (operation) =>
          `${applicationId}${DECLARED_OPERATION_KEY_SEPARATOR}${operation}`,
      ),
    );

    const query = `
      SELECT
        resourceId,
        if(
          has(
            {declaredOperationKeys:Array(String)},
            concat(
              resourceId,
              {declaredOperationKeySeparator:String},
              resourceContext
            )
          ),
          resourceContext,
          ''
        ) AS operation,
        sum(creditsUsedMicro) AS creditsUsedMicro
      FROM usageEvent
      WHERE workspaceId = {workspaceId:String}
        AND timestamp >= {periodStart:String}
        AND timestamp < {periodEnd:String}
        AND resourceType = {appResourceType:String}
        AND resourceId != ''
        ${hasOperationTypes ? 'AND operationType IN ({operationTypes:Array(String)})' : ''}
        ${isNonEmptyString(userWorkspaceId) ? 'AND userWorkspaceId = {userWorkspaceId:String}' : ''}
      GROUP BY resourceId, operation
      ORDER BY creditsUsedMicro DESC
      LIMIT ${BREAKDOWN_QUERY_LIMIT}
    `;

    const rows = await this.clickHouseService.select<
      BreakdownRowMicro<'resourceId' | 'operation'>
    >(query, {
      workspaceId,
      periodStart: formatDateTimeForClickHouse(periodStart),
      periodEnd: formatDateTimeForClickHouse(periodEnd),
      appResourceType: UsageResourceType.APP,
      declaredOperationKeys,
      declaredOperationKeySeparator: DECLARED_OPERATION_KEY_SEPARATOR,
      ...(hasOperationTypes ? { operationTypes } : {}),
      ...(isNonEmptyString(userWorkspaceId) ? { userWorkspaceId } : {}),
    });

    return rows.map((row) => ({
      applicationId: row.resourceId,
      operation: row.operation,
      creditsUsed: row.creditsUsedMicro,
    }));
  }

  // The usage row is the record of the charge; >= so a truncated timestamp cannot miss the current period.
  async getChargedRecurringKeys({
    workspaceId,
    periodStart,
  }: {
    workspaceId: string;
    periodStart: Date;
  }): Promise<Set<string>> {
    const query = `
      SELECT resourceId, resourceContext
      FROM usageEvent
      WHERE workspaceId = {workspaceId:String}
        AND resourceType = {appResourceType:String}
        AND operationType = {subscriptionOperationType:String}
        AND periodStart >= {periodStart:String}
      GROUP BY resourceId, resourceContext
    `;

    const rows = await this.clickHouseService.selectOrThrow<
      Record<'resourceId' | 'resourceContext', string>
    >(query, {
      workspaceId,
      appResourceType: UsageResourceType.APP,
      subscriptionOperationType: UsageOperationType.SUBSCRIPTION,
      periodStart: formatDateTimeForClickHouse(periodStart),
    });

    return new Set(
      rows.map((row) =>
        buildRecurringChargeKey({
          applicationId: row.resourceId,
          chargeKey: row.resourceContext,
        }),
      ),
    );
  }

  async getUsageByUserTimeSeries(
    params: PeriodParams & { userWorkspaceId: string },
  ): Promise<UsageTimeSeriesPoint[]> {
    return this.queryTimeSeries({
      ...params,
      extraWhere: 'AND userWorkspaceId = {userWorkspaceId:String}',
      extraParams: { userWorkspaceId: params.userWorkspaceId },
    });
  }

  async getUsageTimeSeries(
    params: PeriodParams,
  ): Promise<UsageTimeSeriesPoint[]> {
    return this.queryTimeSeries(params);
  }

  private async queryBreakdown({
    workspaceId,
    periodStart,
    periodEnd,
    groupByField,
    operationTypes,
    extraWhere = '',
    extraParams,
  }: PeriodParams & {
    groupByField: GroupByField;
    extraWhere?: string;
    extraParams?: Record<string, unknown>;
  }): Promise<CreditUsedItem[]> {
    if (
      !ALLOWED_GROUP_BY_FIELDS.includes(
        groupByField as (typeof ALLOWED_GROUP_BY_FIELDS)[number],
      )
    ) {
      throw new Error(`Invalid groupByField: ${groupByField}`);
    }

    const opTypeFilter =
      operationTypes && operationTypes.length > 0
        ? 'AND operationType IN ({operationTypes:Array(String)})'
        : '';

    const query = `
      SELECT
        ${groupByField} AS key,
        sum(creditsUsedMicro) AS creditsUsedMicro
      FROM usageEvent
      WHERE workspaceId = {workspaceId:String}
        AND timestamp >= {periodStart:String}
        AND timestamp < {periodEnd:String}
        ${opTypeFilter}
        ${extraWhere}
      GROUP BY ${groupByField}
      ORDER BY creditsUsedMicro DESC
      LIMIT ${BREAKDOWN_QUERY_LIMIT}
    `;

    const rows = await this.clickHouseService.select<BreakdownRowMicro<'key'>>(
      query,
      {
        workspaceId,
        periodStart: formatDateTimeForClickHouse(periodStart),
        periodEnd: formatDateTimeForClickHouse(periodEnd),
        ...(operationTypes && operationTypes.length > 0
          ? { operationTypes }
          : {}),
        ...(extraParams ?? {}),
      },
    );

    return rows.map((row) => ({
      key: row.key,
      creditsUsed: row.creditsUsedMicro,
    }));
  }

  private async queryTimeSeries({
    workspaceId,
    periodStart,
    periodEnd,
    operationTypes,
    extraWhere = '',
    extraParams,
  }: PeriodParams & {
    extraWhere?: string;
    extraParams?: Record<string, unknown>;
  }): Promise<UsageTimeSeriesPoint[]> {
    const opTypeFilter =
      operationTypes && operationTypes.length > 0
        ? 'AND operationType IN ({operationTypes:Array(String)})'
        : '';

    const query = `
      SELECT
        formatDateTime(timestamp, '%Y-%m-%d') AS date,
        sum(creditsUsedMicro) AS creditsUsedMicro
      FROM usageEvent
      WHERE workspaceId = {workspaceId:String}
        AND timestamp >= {periodStart:String}
        AND timestamp < {periodEnd:String}
        ${opTypeFilter}
        ${extraWhere}
      GROUP BY date
      ORDER BY date ASC
    `;

    const rows = await this.clickHouseService.select<TimeSeriesRowMicro>(
      query,
      {
        workspaceId,
        periodStart: formatDateTimeForClickHouse(periodStart),
        periodEnd: formatDateTimeForClickHouse(periodEnd),
        ...(operationTypes && operationTypes.length > 0
          ? { operationTypes }
          : {}),
        ...(extraParams ?? {}),
      },
    );

    const points = rows.map((row) => ({
      date: row.date,
      creditsUsed: row.creditsUsedMicro,
    }));

    return fillUsageTimeSeriesGaps({
      rows: points,
      periodStart,
      periodEnd,
    });
  }
}

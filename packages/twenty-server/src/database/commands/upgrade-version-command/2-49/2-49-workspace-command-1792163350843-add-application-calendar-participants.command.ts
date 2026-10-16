import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { getStandardFlatEntitiesToCreateOrThrow } from 'src/database/commands/upgrade-version-command/2-10/utils/get-standard-flat-entities-to-create-or-throw.util';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const FIELD_UNIVERSAL_IDENTIFIERS = [
  STANDARD_OBJECTS.calendarEventParticipant.fields.applicationId
    .universalIdentifier,
];

@RegisteredWorkspaceCommand('2.49.0', 1792163350843)
@Command({
  name: 'upgrade:2-49:add-application-calendar-participants',
  description: 'Add application identity to calendar participants',
})
export class AddApplicationCalendarParticipantsCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace(args: RunOnWorkspaceArgs): Promise<void> {
    await this.up(args);
  }

  async up({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    await this.syncMetadata({
      workspaceId,
      isDryRun: options.dryRun ?? false,
      direction: 'up',
    });
  }

  async down({ workspaceId, options }: RunOnWorkspaceArgs): Promise<void> {
    await this.syncMetadata({
      workspaceId,
      isDryRun: options.dryRun ?? false,
      direction: 'down',
    });
  }

  private async syncMetadata({
    workspaceId,
    isDryRun,
    direction,
  }: {
    workspaceId: string;
    isDryRun: boolean;
    direction: 'up' | 'down';
  }): Promise<void> {
    const { flatFieldMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatFieldMetadataMaps',
      ]);
    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const { allFlatEntityMaps: standardMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId,
        twentyStandardApplicationId: twentyStandardFlatApplication.id,
      });
    const allFlatEntityOperationByMetadataName = {
      fieldMetadata: {
        flatEntityToCreate:
          direction === 'up'
            ? getStandardFlatEntitiesToCreateOrThrow({
                standardFlatEntityMaps: standardMaps.flatFieldMetadataMaps,
                existingFlatEntityMaps: flatFieldMetadataMaps,
                universalIdentifiers: FIELD_UNIVERSAL_IDENTIFIERS,
              })
            : [],
        flatEntityToDelete:
          direction === 'down'
            ? FIELD_UNIVERSAL_IDENTIFIERS.map(
                (id) => flatFieldMetadataMaps.byUniversalIdentifier[id],
              ).filter(isDefined)
            : [],
        flatEntityToUpdate: [],
      },
    };

    if (isDryRun) {
      this.logger.log(
        `[DRY RUN] Would ${direction === 'up' ? 'add' : 'remove'} application calendar participants for workspace ${workspaceId}`,
      );
      return;
    }

    if (
      Object.values(allFlatEntityOperationByMetadataName).every(
        ({ flatEntityToCreate, flatEntityToDelete }) =>
          flatEntityToCreate.length + flatEntityToDelete.length === 0,
      )
    ) {
      return;
    }

    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
        {
          workspaceId,
          isSystemBuild: true,
          applicationUniversalIdentifier:
            twentyStandardFlatApplication.universalIdentifier,
          allFlatEntityOperationByMetadataName,
        },
      );

    if (result.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        result,
        `Failed to ${direction} application calendar participants for workspace ${workspaceId}`,
      );
    }
  }
}

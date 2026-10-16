/* @license Enterprise */

import { ObjectType } from '@nestjs/graphql';

import { CreditUsedItemDTO } from 'src/engine/core-modules/usage/dtos/credit-used-item.dto';

@ObjectType('UsageBreakdownItem')
export class UsageBreakdownItemDTO extends CreditUsedItemDTO {}

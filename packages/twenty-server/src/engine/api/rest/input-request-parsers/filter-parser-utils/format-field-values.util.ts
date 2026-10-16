import { BadRequestException } from '@nestjs/common';

import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type FieldValue } from 'src/engine/api/rest/core/types/field-value.type';

// Commas inside quoted items do not separate values. Quotes only open
// at item starts and close before a delimiter, so mid-value apostrophes
// stay literal even next to commas.
const splitRespectingQuotes = (values: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let isWithinDoubleQuotes = false;
  let isWithinSingleQuotes = false;
  let previousCharacter = '';
  const characters = [...values];

  const isQuoteBoundary = (next: string | undefined) =>
    next === undefined || [',', ']', ')'].includes(next);

  for (let index = 0; index < characters.length; index++) {
    const c = characters[index];
    const next = characters[index + 1];
    const atItemStart =
      previousCharacter === '' || [':', '[', ','].includes(previousCharacter);

    if (
      c === '"' &&
      !isWithinSingleQuotes &&
      (atItemStart || (isWithinDoubleQuotes && isQuoteBoundary(next)))
    )
      isWithinDoubleQuotes = !isWithinDoubleQuotes;

    if (
      c === "'" &&
      !isWithinDoubleQuotes &&
      (atItemStart || (isWithinSingleQuotes && isQuoteBoundary(next)))
    )
      isWithinSingleQuotes = !isWithinSingleQuotes;

    if (c === ',' && !isWithinDoubleQuotes && !isWithinSingleQuotes) {
      parts.push(current);
      current = '';
      previousCharacter = c;
      continue;
    }

    current += c;
    previousCharacter = c;
  }

  parts.push(current);

  return parts;
};

export const formatFieldValue = (
  value: string,
  fieldType?: FieldMetadataType,
  comparator?: string,
): FieldValue => {
  if (isDefined(comparator) && ['in', 'containsAny'].includes(comparator)) {
    if (value[0] !== '[' || value[value.length - 1] !== ']') {
      throw new BadRequestException(
        `'filter' invalid for '${comparator}' operator. Received '${value}' but array value expected eg: 'field[${comparator}]:[value_1,value_2]'`,
      );
    }
    const stringValues = value.substring(1, value.length - 1);

    return splitRespectingQuotes(stringValues).map((value) =>
      formatFieldValue(value, fieldType),
    );
  }
  if (comparator === 'is') {
    return value;
  }
  switch (fieldType) {
    case FieldMetadataType.NUMERIC:
      return parseInt(value);
    case FieldMetadataType.NUMBER:
    case FieldMetadataType.POSITION:
      return parseFloat(value);
    case FieldMetadataType.BOOLEAN:
      return value.toLowerCase() === 'true';
  }

  if (
    (value[0] === '"' || value[0] === "'") &&
    (value.charAt(value.length - 1) === '"' ||
      value.charAt(value.length - 1) === "'")
  ) {
    return value.substring(1, value.length - 1);
  }

  return value;
};

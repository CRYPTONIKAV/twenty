import { BadRequestException } from '@nestjs/common';

import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type FieldValue } from 'src/engine/api/rest/core/types/field-value.type';

// Commas inside quoted items do not separate values. Quotes only open
// at item starts, so mid-value apostrophes stay literal.
const splitRespectingQuotes = (values: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let isWithinDoubleQuotes = false;
  let isWithinSingleQuotes = false;
  let previousCharacter = '';

  for (const c of values) {
    const atItemStart =
      previousCharacter === '' || [':', '[', ','].includes(previousCharacter);

    if (
      c === '"' &&
      !isWithinSingleQuotes &&
      (isWithinDoubleQuotes || atItemStart)
    )
      isWithinDoubleQuotes = !isWithinDoubleQuotes;

    if (
      c === "'" &&
      !isWithinDoubleQuotes &&
      (isWithinSingleQuotes || atItemStart)
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

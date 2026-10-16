import { Conjunctions } from 'src/engine/api/rest/input-request-parsers/filter-parser-utils/parse-filter.util';

export const DEFAULT_CONJUNCTION = Conjunctions.and;

const hasSingleRootConjunction = (filterQuery: string): boolean => {
  const match = filterQuery.match(/^(or|and|not)\(/);

  if (!match) {
    return false;
  }

  // The root conjunction only spans the whole query when its parenthesis
  // is the one closed by the last character.
  const body = filterQuery.slice(match[0].length - 1);
  let depth = 0;

  for (let index = 0; index < body.length; index++) {
    const c = body[index];

    if (c === '(') {
      depth++;
    }

    if (c === ')') {
      depth--;

      if (depth === 0) {
        return index === body.length - 1;
      }
    }
  }

  return false;
};

export const addDefaultConjunctionIfMissing = (filterQuery: string): string => {
  if (!hasSingleRootConjunction(filterQuery)) {
    return `${DEFAULT_CONJUNCTION}(${filterQuery})`;
  }

  return filterQuery;
};

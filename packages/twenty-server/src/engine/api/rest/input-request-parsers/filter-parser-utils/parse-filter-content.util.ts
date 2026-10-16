export const parseFilterContent = (filterQuery: string): string[] => {
  let isWithinBrackets = false;
  let isWithinDoubleQuotes = false;
  let isWithinSingleQuotes = false;
  let parenthesisCounter = 0;
  const predicates: string[] = [];
  let currentPredicates = '';
  let previousCharacter = '';

  const isWithinQuotes = () => isWithinDoubleQuotes || isWithinSingleQuotes;
  const isValueStart = (character: string) =>
    [':', '[', ','].includes(character);
  const isQuoteBoundary = (next: string | undefined) =>
    next === undefined || [',', ']', ')'].includes(next);

  const characters = [...filterQuery];

  for (let index = 0; index < characters.length; index++) {
    const c = characters[index];
    const next = characters[index + 1];
    let shouldPersistCharacter = parenthesisCounter >= 1;

    if (c === '(' && !isWithinQuotes()) {
      parenthesisCounter++;
    }

    if (c === ')' && !isWithinQuotes()) {
      parenthesisCounter--;
      shouldPersistCharacter = parenthesisCounter >= 1;
    }

    if (['[', ']'].includes(c) && !isWithinQuotes())
      isWithinBrackets = !isWithinBrackets;

    // Quotes delimit at value starts; a matching quote inside a string
    // only closes before a delimiter, so mid-value apostrophes stay
    // literal while brackets and parens inside stay ignored.
    if (
      c === '"' &&
      !isWithinSingleQuotes &&
      (isValueStart(previousCharacter) ||
        (isWithinDoubleQuotes && isQuoteBoundary(next)))
    )
      isWithinDoubleQuotes = !isWithinDoubleQuotes;

    if (
      c === "'" &&
      !isWithinDoubleQuotes &&
      (isValueStart(previousCharacter) ||
        (isWithinSingleQuotes && isQuoteBoundary(next)))
    )
      isWithinSingleQuotes = !isWithinSingleQuotes;

    if (
      c === ',' &&
      parenthesisCounter === 1 &&
      !isWithinBrackets &&
      !isWithinDoubleQuotes &&
      !isWithinSingleQuotes
    ) {
      predicates.push(currentPredicates);
      currentPredicates = '';
      shouldPersistCharacter = false;
    }

    if (shouldPersistCharacter) currentPredicates += c;

    previousCharacter = c;
  }

  predicates.push(currentPredicates);

  return predicates;
};

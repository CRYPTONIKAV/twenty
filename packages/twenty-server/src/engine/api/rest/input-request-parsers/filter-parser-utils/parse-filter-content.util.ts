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

  for (const c of filterQuery) {
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

    // Quotes only delimit at value starts; mid-value apostrophes stay
    // literal, as do brackets and parens inside a quoted string.
    if (
      c === '"' &&
      !isWithinSingleQuotes &&
      (isWithinDoubleQuotes || isValueStart(previousCharacter))
    )
      isWithinDoubleQuotes = !isWithinDoubleQuotes;

    if (
      c === "'" &&
      !isWithinDoubleQuotes &&
      (isWithinSingleQuotes || isValueStart(previousCharacter))
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

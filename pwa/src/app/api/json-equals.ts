/** Compares JSON values, including objects whose optional properties are omitted or undefined. */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index]))
    );
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  return (
    Object.keys(leftObject).every((key) =>
      jsonEquals(leftObject[key], Object.hasOwn(rightObject, key) ? rightObject[key] : undefined),
    ) && Object.keys(rightObject).every((key) => Object.hasOwn(leftObject, key) || rightObject[key] === undefined)
  );
}

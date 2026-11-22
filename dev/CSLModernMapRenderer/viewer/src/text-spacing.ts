// Add one ordinary space at adjacent Han and Latin or digit boundaries.
const mixedBoundary = /\p{Script=Han}(?=[\p{Script=Latin}0-9])|[\p{Script=Latin}0-9](?=\p{Script=Han})/gu;

export function spaceMixedText(text: string): string {
  return text.replace(mixedBoundary, '$& ');
}

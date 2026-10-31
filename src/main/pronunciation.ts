import type { Pronunciation } from '../shared/types';

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Swaps words for their respellings in text about to be spoken. It runs as a single pass, so a
 * replacement is never rewritten by another entry, and the longest entry wins, so a phrase beats
 * a word inside it. Boundaries are Unicode-aware, so "cat" leaves "concatenate" alone.
 */
export function applyPronunciations(text: string, entries: Pronunciation[]): string {
  if (entries.length === 0) return text;
  const byWord = new Map(entries.map((e) => [normalize(e.word), e.spoken]));
  const alternatives = [...entries]
    .sort((a, b) => b.word.length - a.word.length)
    .map((e) => escapeRegex(e.word).replace(/\s+/g, '\\s+'))
    .join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(pattern, (match) => byWord.get(normalize(match)) ?? match);
}

function normalize(word: string): string {
  return word.trim().replace(/\s+/g, ' ').toLowerCase();
}

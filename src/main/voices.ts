export type VoiceKind = 'requests' | 'complaints' | 'problems';

const MIN_SENTENCE = 30;
const MAX_SENTENCE = 280;

const ASKED_ABOUT: [VoiceKind, RegExp][] = [
  ['requests', /\b(requests?|requested|wish(es|list)?|feature|features|missing|asked for|asking for|want|wants)\b/i],
  ['complaints', /\b(complain\w*|frustrat\w*|annoy\w*|dislike\w*|hate|unhappy|disappoint\w*)\b/i],
  ['problems', /\b(bugs?|crash\w*|problems?|issues?|broken|fail\w*|errors?)\b/i],
];

const PHRASES: Record<VoiceKind, RegExp> = {
  requests:
    /\b(please (add|implement|support|include|consider)|(would|'d) (love|like) (to (see|have)|an?\b)|would be (great|nice|awesome|helpful|useful|amazing) (if|to have|to be able)|i wish (it|you|there|we|i could)|can (you|we) (please )?add|any plans? (to|for)|feature request:)/i,
  complaints: /\b(frustrat\w*|annoy\w*|disappoint\w*|too expensive|overpriced|terrible|awful|i hate|unusable|deal ?breaker|ridiculous)\b/i,
  problems: /\b(crash\w*|freez\w*|froze|(stopped|not) working|(doesn'?t|does not) work|broken|glitch\w*)\b/i,
};

/** Replies from the people running a forum or a project, thanking or fixing rather than speaking up. */
const NOT_A_VOICE =
  /\b(we('re| are) sorry|sorry to hear|we fixed|fixed (an?|many|the|some)|we hear you|i understand|we would love|we'd love|let us know|thanks for|thank you for|wish you (and|all|the best|best|luck|success|a )|good luck)\b/i;

/** The kind of statement a question is about, if counting statements could answer it. */
export function voiceKind(question: string): VoiceKind | null {
  return ASKED_ABOUT.find(([, words]) => words.test(question))?.[0] ?? null;
}

/** Sentences in which someone makes this kind of statement themselves. */
export function voiceSentences(text: string, kind: VoiceKind): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(
      (s) =>
        s.length >= MIN_SENTENCE &&
        s.length <= MAX_SENTENCE &&
        !/^[-#>|]|https?:\/\//.test(s) &&
        PHRASES[kind].test(s) &&
        !NOT_A_VOICE.test(s),
    );
}

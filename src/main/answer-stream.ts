// Model control syntax is never an answer. Keep even partial streaming tags out of text and speech.
const MARKERS = [
  "<tool_call",
  "</tool_call",
  "<function=",
  "<parameter=",
  "</function>",
  "</parameter>",
  "<|tool_call",
  "[TOOL_CALLS]",
];
export const hasToolProtocol = (text: string) =>
  MARKERS.some((m) => text.toLowerCase().includes(m.toLowerCase()));

export class AnswerStream {
  private held = "";
  blocked = false;
  push(text: string): string {
    if (this.blocked) return "";
    this.held += text;
    const lower = this.held.toLowerCase();
    const at = MARKERS.map((m) => lower.indexOf(m.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (at !== undefined) {
      this.blocked = true;
      const safe = this.held.slice(0, at);
      this.held = "";
      return safe;
    }
    let keep = 0;
    for (const marker of MARKERS) {
      for (let n = 1; n < marker.length; n++) {
        if (lower.endsWith(marker.slice(0, n).toLowerCase()))
          keep = Math.max(keep, n);
      }
    }
    const safe = this.held.slice(0, this.held.length - keep);
    this.held = this.held.slice(this.held.length - keep);
    return safe;
  }
  finish(): string {
    if (this.blocked) return "";
    if (this.held.length > 2) {
      this.blocked = true;
      this.held = "";
      return "";
    }
    const rest = this.held;
    this.held = "";
    return rest;
  }
}

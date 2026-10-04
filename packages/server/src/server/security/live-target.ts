const LIVE_TARGET_PATTERNS = [
  /\bremote targets?\b/i,
  /\blive targets?\b/i,
  /\bagainst the (?:host|daemon|service|target|guest)\b/i,
  /\b(?:on|in|inside) (?:a |the )?(?:vm|virtual machine|guest)\b/i,
  /\b(?:boot|start|run) (?:the |a )?(?:vm|guest|qemu|kvm)\b/i,
  /\bneeds? a vm\b/i,
  /\bexploit chains?\b/i,
  /\bchaining\b/i,
  /\baufeinander\b/i,
  /\bbuild on the (?:previous|last)\b/i,
  /\bevaluate against\b/i,
];

export function campaignRunsLive(text: string): boolean {
  return LIVE_TARGET_PATTERNS.some((pattern) => pattern.test(text));
}
